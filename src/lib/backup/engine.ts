// Main backup orchestration engine
// Coordinates a full backup run across all configured providers

import { getConfig } from '../config';
import {
  createBackupItem,
  createBackupRun,
  updateBackupItem,
  updateBackupRun,
  updateRepositorySync,
  upsertRepository,
} from '../database';
import { runDiscovery } from '../discovery';
import { isUpstreamUnavailable } from '../plugins/errors';
import type { RepositoryInfo, ProviderPlugin } from '../plugins/interface';
import { backupOption1 } from './option1';
import { backupOption2 } from './option2';
import { backupOption3 } from './option3';
import { logger } from '../logger.js';

export interface BackupResult {
  runId: number;
  startedAt: string;
  completedAt: string;
  totalRepos: number;
  successCount: number;
  failedCount: number;
  unavailableCount: number;
  failures: Array<{ repo: string; error: string }>;
  unavailable: Array<{ repo: string; url: string; error: string }>;
  backupMode: string;
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

  // Discover repositories from all configured plugins via the shared pipeline.
  // This also persists new repos, applies filters, optionally appends to
  // repos.txt, and emits the "new repos discovered" SMTP notification.
  const discovery = await runDiscovery();
  const allRepos: Array<{ plugin: ProviderPlugin; repo: RepositoryInfo }> = discovery.repos;

  for (const provider of discovery.providers) {
    if (!provider.authenticated) {
      logger.error(`[backup] Skipping ${provider.provider}: authentication failed`);
    }
  }

  // Update run with total count
  updateBackupRun(run.id, { repos_total: allRepos.length });

  // Process repos sequentially to avoid overwhelming git/network
  for (const { plugin, repo } of allRepos) {
    const repoLabel = `${repo.provider}/${repo.owner}/${repo.name}`;
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
      const message = err instanceof Error ? err.message : String(err);
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
  const errorParts: string[] = [];
  if (failures.length > 0) {
    errorParts.push(failures.map((f) => `${f.repo}: ${f.error}`).join('\n'));
  }
  if (unavailable.length > 0) {
    errorParts.push(
      `Unavailable upstream:\n` + unavailable.map((u) => `${u.repo}: ${u.error}`).join('\n'),
    );
  }
  const errorSummary = errorParts.length > 0 ? errorParts.join('\n\n') : null;

  updateBackupRun(run.id, {
    completed_at: completedAt,
    status: failedCount === 0 && unavailableCount === 0 ? 'success' : 'partial_failure',
    repos_total: allRepos.length,
    repos_success: successCount,
    repos_failed: failedCount,
    repos_unavailable: unavailableCount,
    error_summary: errorSummary,
  });

  logger.info(
    `[backup] Completed: ${successCount}/${allRepos.length} succeeded, ${failedCount} failed, ${unavailableCount} unavailable`,
  );

  return {
    runId: run.id,
    startedAt,
    completedAt,
    totalRepos: allRepos.length,
    successCount,
    failedCount,
    unavailableCount,
    failures,
    unavailable,
    backupMode,
  };
}
