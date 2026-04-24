// Main backup orchestration engine
// Coordinates a full backup run across all configured providers

import { getConfig } from '../config';
import {
  createBackupItem,
  createBackupRun,
  isRunCancellationRequested,
  updateBackupItem,
  updateBackupRun,
  updateRepositorySync,
  upsertRepository,
} from '../database';
import { runDiscovery } from '../discovery';
import { isUpstreamUnavailable } from '../plugins/errors';
import type { RepositoryInfo, ProviderPlugin } from '../plugins/interface';
import { getPluginRegistry } from '../plugins/interface';
import { backupOption1 } from './option1';
import { backupOption2 } from './option2';
import { backupOption3 } from './option3';
import { logger, redactSecrets } from '../logger.js';
import { collectPatExpiryWarnings, type PatWarning } from '../smtp.js';
import { getStorageUsage } from '../stats.js';

export interface NewRepoEntry {
  provider: string;
  providerDisplay: string;
  repos: Array<{ url: string; owner: string; name: string }>;
}

export interface BackupResult {
  runId: number;
  startedAt: string;
  completedAt: string;
  totalRepos: number;
  successCount: number;
  failedCount: number;
  unavailableCount: number;
  skippedCount: number;
  failures: Array<{ repo: string; error: string }>;
  unavailable: Array<{ repo: string; url: string; error: string }>;
  backupMode: string;
  /** True if the run was cancelled by the user before processing every repo. */
  cancelled: boolean;
  /** Repositories seen for the first time during this run, grouped by provider. */
  newRepos: NewRepoEntry[];
  /** PAT expiry warnings captured at the start of the cycle. */
  patWarnings: PatWarning[];
}

export async function runBackup(): Promise<BackupResult> {
  const config = getConfig();
  const { backupMode, backupsDir } = config;

  logger.info(`[backup] Starting backup run (mode: ${backupMode})`);

  // Create backup run in DB
  const run = createBackupRun(backupMode);
  if (!run || typeof run.id !== 'number') {
    throw new Error(
      `[backup] createBackupRun did not return a row (got ${JSON.stringify(run)}). ` +
        'The SQLite database under /data may be corrupt or unwritable.',
    );
  }
  const startedAt = run.started_at;

  const failures: Array<{ repo: string; error: string }> = [];
  const unavailable: Array<{ repo: string; url: string; error: string }> = [];
  let successCount = 0;
  let failedCount = 0;
  let unavailableCount = 0;
  let skippedCount = 0;

  // PAT expiry — collect so the scheduler can include it in the single
  // consolidated cycle email instead of firing separate notifications.
  const patWarnings = collectPatExpiryWarnings();

  // Discover repositories from all configured plugins via the shared pipeline.
  // Pass notify=false so the "new repos discovered" email is NOT sent from
  // here — the scheduler folds this information into a single cycle report.
  const discovery = await runDiscovery({ notify: false });
  const allRepos: Array<{ plugin: ProviderPlugin; repo: RepositoryInfo }> = discovery.repos;

  const newRepos: NewRepoEntry[] = discovery.providers
    .filter((p) => p.newlyDiscovered.length > 0)
    .map((p) => {
      // Prefer the plugin registry's displayName so new providers surface
      // correctly without per-provider branches here.
      const plugin = getPluginRegistry().get(String(p.provider).toLowerCase());
      const providerDisplay =
        plugin?.displayName ??
        (p.provider === 'azureDevOps' ? 'Azure DevOps' : p.provider === 'gitlab' ? 'GitLab' : 'GitHub');
      return {
        provider: p.provider,
        providerDisplay,
        repos: p.newlyDiscovered.map((r) => ({ url: r.url, owner: r.owner, name: r.name })),
      };
    });

  for (const provider of discovery.providers) {
    if (!provider.authenticated) {
      logger.error(`[backup] Skipping ${provider.provider}: authentication failed`);
    }
  }

  // Update run with total count
  updateBackupRun(run.id, { repos_total: allRepos.length });

  // True once a cancellation has been observed for this run. Remaining
  // repos are skipped (but still materialised as `skipped` backup_items
  // so the UI shows an honest picture of what happened).
  let cancelled = false;

  // Process repos sequentially to avoid overwhelming git/network
  for (const { plugin, repo } of allRepos) {
    // Graceful cancellation: check the flag BEFORE starting each repo so
    // any in-flight git/archive operation always runs to completion and
    // leaves no half-written files behind.
    if (!cancelled && isRunCancellationRequested(run.id)) {
      cancelled = true;
      logger.info(`[backup] Cancellation requested for run #${run.id} — stopping after current progress`);
    }

    const repoLabel = `${repo.provider}/${repo.owner}/${repo.name}`;

    if (cancelled) {
      // Record remaining repos as skipped so the run detail page clearly
      // shows which repos were dropped by the cancellation.
      const dbRepo = upsertRepository({
        url: repo.url,
        provider: repo.provider,
        owner: repo.owner,
        name: repo.name,
      });
      if (dbRepo && typeof dbRepo.id === 'number') {
        const item = createBackupItem({ runId: run.id, repositoryId: dbRepo.id });
        if (item && typeof item.id === 'number') {
          updateBackupItem(item.id, {
            status: 'skipped',
            error: 'Run cancelled by user',
            completed_at: new Date().toISOString(),
          });
        }
      }
      skippedCount++;
      continue;
    }

    logger.info(`[backup] Backing up ${repoLabel}...`);

    const dbRepo = upsertRepository({
      url: repo.url,
      provider: repo.provider,
      owner: repo.owner,
      name: repo.name,
    });
    if (!dbRepo || typeof dbRepo.id !== 'number') {
      logger.error(
        `[backup] upsertRepository returned ${JSON.stringify(dbRepo)} for ${repo.url} — skipping`,
      );
      failures.push({ repo: repoLabel, error: 'DB upsert returned no row' });
      failedCount++;
      continue;
    }

    // User-requested skip: don't clone/pull this repo, don't count it as
    // a failure. A backup_item row is still created so the run history
    // shows an explicit "skipped" entry for the repo.
    if (dbRepo.skip_backup === 1) {
      const item = createBackupItem({ runId: run.id, repositoryId: dbRepo.id });
      if (item && typeof item.id === 'number') {
        updateBackupItem(item.id, {
          status: 'skipped',
          completed_at: new Date().toISOString(),
        });
      }
      skippedCount++;
      logger.info(`[backup] ⏭ ${repoLabel} skipped (manually excluded)`);
      continue;
    }

    const item = createBackupItem({ runId: run.id, repositoryId: dbRepo.id });
    if (!item || typeof item.id !== 'number') {
      logger.error(
        `[backup] createBackupItem returned ${JSON.stringify(item)} for ${repo.url} — skipping`,
      );
      failures.push({ repo: repoLabel, error: 'DB item insert returned no row' });
      failedCount++;
      continue;
    }

    try {
      if (backupMode === 'option1') {
        const result = await backupOption1(plugin, repo, backupsDir);
        if (result.success) {
          successCount++;
          updateRepositorySync(dbRepo.id, 'success');
          updateBackupItem(item.id, {
            status: 'success',
            completed_at: new Date().toISOString(),
          });
          logger.info(`[backup] ✓ ${repoLabel}`);
        } else if (result.unavailable) {
          unavailableCount++;
          unavailable.push({ repo: repoLabel, url: repo.url, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'unavailable', result.error);
          updateBackupItem(item.id, {
            status: 'unavailable',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          logger.warn(`[backup] ⚠ ${repoLabel} unavailable: ${result.error}`);
        } else {
          failedCount++;
          failures.push({ repo: repoLabel, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'failed', result.error);
          updateBackupItem(item.id, {
            status: 'failed',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          logger.error(`[backup] ✗ ${repoLabel}: ${result.error}`);
        }
      } else {
        // option2 and option3 share the same {checksum, zipPath} result shape.
        const result =
          backupMode === 'option3'
            ? await backupOption3(plugin, repo, backupsDir)
            : await backupOption2(plugin, repo, backupsDir);
        if (result.success) {
          successCount++;
          updateRepositorySync(dbRepo.id, 'success', undefined, result.checksum);
          updateBackupItem(item.id, {
            status: 'success',
            checksum: result.checksum ?? null,
            zip_path: result.zipPath ?? null,
            completed_at: new Date().toISOString(),
          });
          logger.info(`[backup] ✓ ${repoLabel}${result.zipPath ? ' (new snapshot)' : ' (unchanged)'}`);
        } else if (result.unavailable) {
          unavailableCount++;
          unavailable.push({ repo: repoLabel, url: repo.url, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'unavailable', result.error);
          updateBackupItem(item.id, {
            status: 'unavailable',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          logger.warn(`[backup] ⚠ ${repoLabel} unavailable: ${result.error}`);
        } else {
          failedCount++;
          failures.push({ repo: repoLabel, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'failed', result.error);
          updateBackupItem(item.id, {
            status: 'failed',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          logger.error(`[backup] ✗ ${repoLabel}: ${result.error}`);
        }
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = redactSecrets(rawMessage);
      if (isUpstreamUnavailable(err)) {
        unavailableCount++;
        unavailable.push({ repo: repoLabel, url: repo.url, error: message });
        updateRepositorySync(dbRepo.id, 'unavailable', message);
        updateBackupItem(item.id, {
          status: 'unavailable',
          error: message,
          completed_at: new Date().toISOString(),
        });
        logger.warn(`[backup] ⚠ ${repoLabel} unavailable: ${message}`);
      } else {
        failedCount++;
        failures.push({ repo: repoLabel, error: message });
        updateRepositorySync(dbRepo.id, 'failed', message);
        updateBackupItem(item.id, {
          status: 'failed',
          error: message,
          completed_at: new Date().toISOString(),
        });
        logger.error(`[backup] ✗ ${repoLabel}: ${message}`);
      }
    }
  }

  // Finalize the backup run
  const completedAt = new Date().toISOString();

  // If no cancellation was observed during the loop itself, double-check
  // one last time — a flag set between the last repo and finalisation
  // still counts, and surfacing it as `cancelled` is more accurate than
  // labelling an otherwise clean run `success`.
  if (!cancelled && isRunCancellationRequested(run.id)) {
    cancelled = true;
  }

  const errorParts: string[] = [];
  if (failures.length > 0) {
    errorParts.push(failures.map((f) => `${f.repo}: ${f.error}`).join('\n'));
  }
  if (unavailable.length > 0) {
    errorParts.push(
      `Unavailable upstream:\n` + unavailable.map((u) => `${u.repo}: ${u.error}`).join('\n'),
    );
  }
  if (cancelled) {
    errorParts.unshift('Cancelled by user');
  }
  const errorSummary = errorParts.length > 0 ? errorParts.join('\n\n') : null;

  const finalStatus = cancelled
    ? 'cancelled'
    : failedCount === 0 && unavailableCount === 0
      ? 'success'
      : 'partial_failure';

  updateBackupRun(run.id, {
    completed_at: completedAt,
    status: finalStatus,
    repos_total: allRepos.length,
    repos_success: successCount,
    repos_failed: failedCount,
    repos_unavailable: unavailableCount,
    repos_skipped: skippedCount,
    error_summary: errorSummary,
  });

  logger.info(
    `[backup] ${cancelled ? 'Cancelled' : 'Completed'}: ${successCount}/${allRepos.length} succeeded, ${failedCount} failed, ${unavailableCount} unavailable, ${skippedCount} skipped`,
  );

  // Refresh the persistent storage-usage cache so the dashboard shows
  // fresh totals without having to walk the filesystem on render. This
  // is best-effort: any failure here is non-fatal for the backup run.
  try {
    const cfg = getConfig();
    getStorageUsage(cfg.backupsDir, { force: true });
  } catch (e) {
    logger.warn(`[backup] Storage usage cache refresh failed: ${(e as Error).message}`);
  }

  return {
    runId: run.id,
    startedAt,
    completedAt,
    totalRepos: allRepos.length,
    successCount,
    failedCount,
    unavailableCount,
    skippedCount,
    failures,
    unavailable,
    backupMode,
    cancelled,
    newRepos,
    patWarnings,
  };
}
