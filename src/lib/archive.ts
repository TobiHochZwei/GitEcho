// Repository archive + permanent-delete helpers.
//
// Archive: the per-repo backup directory under `{backupsDir}/{provider}/{owner}/{name}`
// is packed into a single ZIP under `{backupsDir}/_archived/{provider}/{owner}/{name}.zip`
// and the original directory is removed. The DB row stays with archived=1
// so the repo is hidden from active listings but still inspectable under
// /settings/repos/archived.
//
// Delete: both the active backup directory and any archive ZIP are
// removed from disk. The DB row itself is deleted by the caller; this
// module only touches the filesystem.
//
// Both operations refuse to run while a backup cycle holds the backup
// lock, because option1/option3 mutate the repo directory in place and
// we'd race with them otherwise.

import archiver from 'archiver';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Repository } from './database.js';
import { inspectBackupLock } from './backup-lock.js';
import { logger } from './logger.js';
import { getStorageUsage } from './stats.js';

export class BackupBusyError extends Error {
  constructor(message = 'A backup cycle is currently running. Try again after it completes.') {
    super(message);
    this.name = 'BackupBusyError';
  }
}

/** Relative path of the archive ZIP under `backupsDir`, forward-slash encoded. */
export function archiveRelativePath(repo: Pick<Repository, 'provider' | 'owner' | 'name'>): string {
  return ['_archived', repo.provider, repo.owner, `${repo.name}.zip`].join('/');
}

/** Absolute path of the per-repo backup directory. */
export function repoBackupDir(
  repo: Pick<Repository, 'provider' | 'owner' | 'name'>,
  backupsDir: string,
): string {
  return join(backupsDir, repo.provider, repo.owner, repo.name);
}

/** Absolute path of the archive ZIP for a repo. */
export function repoArchivePath(
  repo: Pick<Repository, 'provider' | 'owner' | 'name'>,
  backupsDir: string,
): string {
  return join(backupsDir, '_archived', repo.provider, repo.owner, `${repo.name}.zip`);
}

function ensureBackupNotRunning(): void {
  const lock = inspectBackupLock();
  if (lock) {
    throw new BackupBusyError();
  }
}

function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(outputPath), { recursive: true });
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

/**
 * Pack the repo's backup directory into a single archive ZIP and remove the
 * original directory. Returns the archive path relative to `backupsDir`.
 *
 * Idempotent: if the source directory does not exist (e.g. an empty repo
 * that was never successfully backed up), an empty ZIP is still produced
 * so downstream UI always has a file to list/download.
 */
export async function archiveRepositoryFiles(
  repo: Pick<Repository, 'provider' | 'owner' | 'name'>,
  backupsDir: string,
): Promise<string> {
  ensureBackupNotRunning();
  const sourceDir = repoBackupDir(repo, backupsDir);
  const archivePath = repoArchivePath(repo, backupsDir);

  // Clean up any stale archive from a previous archive attempt on the
  // same repo (e.g. a crash between zip-write and rm). This keeps the
  // final ZIP consistent with the current on-disk contents.
  if (existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }

  if (existsSync(sourceDir)) {
    await zipDirectory(sourceDir, archivePath);
    rmSync(sourceDir, { recursive: true, force: true });
  } else {
    // Produce an empty archive so the archived page always has a file
    // reference that downloads cleanly.
    await new Promise<void>((resolve, reject) => {
      mkdirSync(dirname(archivePath), { recursive: true });
      const output = createWriteStream(archivePath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      void archive.finalize();
    });
  }

  try {
    getStorageUsage(backupsDir, { force: true });
  } catch (e) {
    logger.warn(`[archive] Storage usage cache refresh failed: ${(e as Error).message}`);
  }

  // Return a forward-slash, relative path for portability across
  // platforms and for use in URLs (?path=...).
  return relative(backupsDir, archivePath).split(/[\\/]/).join('/');
}

/**
 * Permanently remove all on-disk traces of a repository: the active
 * backup directory and any archive ZIP. Safe to call when either or
 * both are already missing.
 */
export function deleteRepositoryFiles(
  repo: Pick<Repository, 'provider' | 'owner' | 'name'>,
  backupsDir: string,
  archivePathHint?: string | null,
): void {
  ensureBackupNotRunning();
  const sourceDir = repoBackupDir(repo, backupsDir);
  if (existsSync(sourceDir)) {
    rmSync(sourceDir, { recursive: true, force: true });
  }

  const archivePaths = new Set<string>();
  archivePaths.add(repoArchivePath(repo, backupsDir));
  if (archivePathHint) {
    archivePaths.add(join(backupsDir, archivePathHint));
  }
  for (const p of archivePaths) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }

  try {
    getStorageUsage(backupsDir, { force: true });
  } catch (e) {
    logger.warn(`[archive] Storage usage cache refresh failed: ${(e as Error).message}`);
  }
}

/**
 * Remove just the archive ZIP for a repo (used when un-archiving so the
 * archive does not linger after reactivation).
 */
export function deleteArchiveZip(
  repo: Pick<Repository, 'provider' | 'owner' | 'name'>,
  backupsDir: string,
  archivePathHint?: string | null,
): void {
  ensureBackupNotRunning();
  const archivePaths = new Set<string>();
  archivePaths.add(repoArchivePath(repo, backupsDir));
  if (archivePathHint) {
    archivePaths.add(join(backupsDir, archivePathHint));
  }
  for (const p of archivePaths) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }

  try {
    getStorageUsage(backupsDir, { force: true });
  } catch (e) {
    logger.warn(`[archive] Storage usage cache refresh failed: ${(e as Error).message}`);
  }
}

/**
 * Map a repository's `provider` (as stored in the DB, lower-case) to the
 * key used in settings/exclusion blacklists (which uses camelCase for
 * Azure DevOps). Returns undefined for unknown providers.
 */
export function providerToSettingsKey(
  provider: string,
): 'github' | 'azureDevOps' | 'gitlab' | undefined {
  switch (provider.toLowerCase()) {
    case 'github':
      return 'github';
    case 'azuredevops':
      return 'azureDevOps';
    case 'gitlab':
      return 'gitlab';
    default:
      return undefined;
  }
}
