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
import { getPluginRegistry } from '../plugins/interface';
import type { RepositoryInfo } from '../plugins/interface';
import { backupOption1 } from './option1';
import { backupOption2 } from './option2';

export interface BackupResult {
  runId: number;
  startedAt: string;
  completedAt: string;
  totalRepos: number;
  successCount: number;
  failedCount: number;
  failures: Array<{ repo: string; error: string }>;
  backupMode: string;
}

export async function runBackup(): Promise<BackupResult> {
  const config = getConfig();
  const { backupMode, backupsDir } = config;

  console.log(`[backup] Starting backup run (mode: ${backupMode})`);

  // Create backup run in DB
  const run = createBackupRun(backupMode);
  const startedAt = run.started_at;

  const failures: Array<{ repo: string; error: string }> = [];
  let successCount = 0;
  let failedCount = 0;

  // Discover repositories from all configured plugins
  const plugins = getPluginRegistry().getConfigured();
  const allRepos: Array<{ plugin: typeof plugins[number]; repo: RepositoryInfo }> = [];

  for (const plugin of plugins) {
    try {
      console.log(`[backup] Authenticating with ${plugin.displayName}...`);
      const authOk = await plugin.authenticate();
      if (!authOk) {
        console.error(`[backup] Authentication failed for ${plugin.displayName}`);
        continue;
      }

      console.log(`[backup] Listing repositories from ${plugin.displayName}...`);
      const repos = await plugin.listRepositories();
      console.log(`[backup] Found ${repos.length} repositories from ${plugin.displayName}`);

      for (const repo of repos) {
        upsertRepository({
          url: repo.url,
          provider: repo.provider,
          owner: repo.owner,
          name: repo.name,
        });
        allRepos.push({ plugin, repo });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[backup] Error fetching repos from ${plugin.displayName}: ${message}`);
    }
  }

  // Update run with total count
  updateBackupRun(run.id, { repos_total: allRepos.length });

  // Process repos sequentially to avoid overwhelming git/network
  for (const { plugin, repo } of allRepos) {
    const repoLabel = `${repo.provider}/${repo.owner}/${repo.name}`;
    console.log(`[backup] Backing up ${repoLabel}...`);

    const dbRepo = upsertRepository({
      url: repo.url,
      provider: repo.provider,
      owner: repo.owner,
      name: repo.name,
    });

    const item = createBackupItem({ runId: run.id, repositoryId: dbRepo.id });

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
          console.log(`[backup] ✓ ${repoLabel}`);
        } else {
          failedCount++;
          failures.push({ repo: repoLabel, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'failed', result.error);
          updateBackupItem(item.id, {
            status: 'failed',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          console.error(`[backup] ✗ ${repoLabel}: ${result.error}`);
        }
      } else {
        const result = await backupOption2(plugin, repo, backupsDir);
        if (result.success) {
          successCount++;
          updateRepositorySync(dbRepo.id, 'success', undefined, result.checksum);
          updateBackupItem(item.id, {
            status: 'success',
            checksum: result.checksum ?? null,
            zip_path: result.zipPath ?? null,
            completed_at: new Date().toISOString(),
          });
          console.log(`[backup] ✓ ${repoLabel}${result.zipPath ? ' (new snapshot)' : ' (unchanged)'}`);
        } else {
          failedCount++;
          failures.push({ repo: repoLabel, error: result.error ?? 'Unknown error' });
          updateRepositorySync(dbRepo.id, 'failed', result.error);
          updateBackupItem(item.id, {
            status: 'failed',
            error: result.error ?? null,
            completed_at: new Date().toISOString(),
          });
          console.error(`[backup] ✗ ${repoLabel}: ${result.error}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failedCount++;
      failures.push({ repo: repoLabel, error: message });
      updateRepositorySync(dbRepo.id, 'failed', message);
      updateBackupItem(item.id, {
        status: 'failed',
        error: message,
        completed_at: new Date().toISOString(),
      });
      console.error(`[backup] ✗ ${repoLabel}: ${message}`);
    }
  }

  // Finalize the backup run
  const completedAt = new Date().toISOString();
  const errorSummary = failures.length > 0
    ? failures.map((f) => `${f.repo}: ${f.error}`).join('\n')
    : null;

  updateBackupRun(run.id, {
    completed_at: completedAt,
    status: failedCount === 0 ? 'success' : 'partial_failure',
    repos_total: allRepos.length,
    repos_success: successCount,
    repos_failed: failedCount,
    error_summary: errorSummary,
  });

  console.log(`[backup] Completed: ${successCount}/${allRepos.length} succeeded, ${failedCount} failed`);

  return {
    runId: run.id,
    startedAt,
    completedAt,
    totalRepos: allRepos.length,
    successCount,
    failedCount,
    failures,
    backupMode,
  };
}
