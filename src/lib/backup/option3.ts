// Option3: Mirror clone + ZIP snapshots — the strongest revision-safety mode.
//
// Per repo we maintain two siblings under /backups/<provider>/<owner>/<repo>/:
//
//   clone/   bare `git clone --mirror` of the repository, with gc.auto=0 so
//            unreachable commits (e.g. after upstream force-pushes) are
//            preserved on disk indefinitely. Every cycle:
//              git -C clone remote set-url origin <fresh-auth-url>
//              git -C clone remote update --prune
//
//   zips/    timestamped ZIP snapshots produced from the mirror via
//            `git archive --format=zip HEAD`. SHA-256-deduplicated against
//            the previous snapshot stored in repositories.checksum so we
//            only write a new ZIP when the default-branch tree actually
//            changed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { getRepositoryByUrl } from '../database';
import { isUpstreamUnavailable } from '../plugins/errors';
import type { ProviderPlugin, RepositoryInfo } from '../plugins/interface';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  return stdout.trim();
}

function isHealthyMirror(cloneDir: string): boolean {
  // A mirror clone is bare; presence of HEAD + objects/ + refs/ is a good proxy.
  return (
    existsSync(path.join(cloneDir, 'HEAD')) &&
    existsSync(path.join(cloneDir, 'objects')) &&
    existsSync(path.join(cloneDir, 'refs'))
  );
}

function computeChecksum(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export async function backupOption3(
  plugin: ProviderPlugin,
  repo: RepositoryInfo,
  backupsDir: string,
): Promise<{ success: boolean; error?: string; checksum?: string; zipPath?: string; unavailable?: boolean }> {
  const repoDir = path.join(backupsDir, repo.provider, repo.owner, repo.name);
  const cloneDir = path.join(repoDir, 'clone');
  const zipsDir = path.join(repoDir, 'zips');

  try {
    const authenticatedUrl = plugin.getAuthenticatedUrl(repo.url);

    // ── 1. Ensure the mirror exists and is up-to-date ─────────────────
    if (existsSync(cloneDir) && !isHealthyMirror(cloneDir)) {
      // Half-broken state — wipe and re-mirror (matches option1's guard).
      rmSync(cloneDir, { recursive: true, force: true });
    }

    if (!existsSync(cloneDir)) {
      mkdirSync(repoDir, { recursive: true });
      await git(['clone', '--mirror', authenticatedUrl, cloneDir]);
      // Disable auto-GC so unreachable commits are preserved indefinitely.
      await git(['-C', cloneDir, 'config', 'gc.auto', '0']);
    } else {
      // Refresh the remote URL so PAT rotation doesn't silently break fetches.
      await git(['-C', cloneDir, 'remote', 'set-url', 'origin', authenticatedUrl]);
      await git(['-C', cloneDir, 'remote', 'update', '--prune']);
    }

    // ── 2. Snapshot the default branch into a temp ZIP ────────────────
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-opt3-'));
    let tempZipPath: string | undefined;
    try {
      tempZipPath = path.join(tempDir, `${repo.name}.zip`);
      try {
        await git(['-C', cloneDir, 'archive', '--format=zip', `--output=${tempZipPath}`, 'HEAD']);
      } catch (err) {
        // Empty repository (no HEAD / no commits) — mirror is still the
        // source of truth, just nothing to snapshot.
        const message = err instanceof Error ? err.message : String(err);
        if (/HEAD|does not exist|did not match|bad revision/i.test(message)) {
          console.warn(
            `[option3] Skipping ZIP for ${repo.url}: archive failed (likely empty repo). ${message}`,
          );
          return { success: true };
        }
        throw err;
      }

      const checksum = computeChecksum(tempZipPath);

      const existing = getRepositoryByUrl(repo.url);
      if (existing?.checksum === checksum) {
        // Tree unchanged since last snapshot — keep mirror, drop new ZIP.
        return { success: true, checksum };
      }

      mkdirSync(zipsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const finalZipPath = path.join(zipsDir, `${repo.name}_${timestamp}.zip`);
      copyFileSync(tempZipPath, finalZipPath);

      return { success: true, checksum, zipPath: finalZipPath };
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, unavailable: isUpstreamUnavailable(err) };
  }
}
