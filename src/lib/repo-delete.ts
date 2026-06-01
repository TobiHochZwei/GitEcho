// Shared cascade-delete logic for repositories.
//
// Permanently removing a repository involves three steps that must stay in
// sync between the single-repo DELETE endpoint and the bulk-delete endpoint:
//   1. delete its on-disk backup files + archive ZIP
//   2. delete the database row (orphaning historical backup_items)
//   3. blacklist the URL so auto-discovery won't surface it again
//
// `deleteRepositoryFiles` throws `BackupBusyError` when a backup is running;
// callers should map that to HTTP 409.

import type { AppConfig } from './config.js';
import type { Repository } from './database.js';
import { deleteRepository } from './database.js';
import { deleteRepositoryFiles, providerToSettingsKey } from './archive.js';
import { addExcludedUrl } from './settings.js';
import { logger } from './logger.js';

/**
 * Permanently delete a single repository: its files, its database row, and
 * (best-effort) add its URL to the provider blacklist. Returns whether the
 * URL was blacklisted. Propagates `BackupBusyError` from file deletion.
 */
export function deleteRepositoryCascade(
  repo: Repository,
  cfg: AppConfig,
): { blacklisted: boolean } {
  deleteRepositoryFiles(repo, cfg.backupsDir, repo.archive_path);

  deleteRepository(repo.id);

  let blacklisted = false;
  const settingsKey = providerToSettingsKey(repo.provider);
  if (settingsKey) {
    try {
      addExcludedUrl(settingsKey, repo.url);
      blacklisted = true;
    } catch (e) {
      logger.warn(`[repo-delete] Failed to blacklist ${repo.url}: ${(e as Error).message}`);
    }
  }

  logger.info(
    `[repo-delete] Deleted repository #${repo.id} ${repo.provider}/${repo.owner}/${repo.name} (${repo.url})` +
      (blacklisted ? ' — added to provider blacklist' : ''),
  );

  return { blacklisted };
}
