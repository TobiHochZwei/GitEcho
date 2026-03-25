// Option1: Git clone/pull strategy with history protection
// - First run: clone the repo
// - Subsequent runs: fetch + pull (never force, protect history)
// - Directory structure: /backups/<provider>/<owner>/<repo>/

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ProviderPlugin, RepositoryInfo } from '../plugins/interface';

export async function backupOption1(
  plugin: ProviderPlugin,
  repo: RepositoryInfo,
  backupsDir: string,
): Promise<{ success: boolean; error?: string }> {
  const targetDir = path.join(backupsDir, repo.provider, repo.owner, repo.name);

  try {
    const dirExists = existsSync(targetDir);
    const hasGit = dirExists && existsSync(path.join(targetDir, '.git'));

    if (dirExists && hasGit) {
      // Existing clone — fetch + pull (never force)
      await plugin.pullRepository(targetDir);
    } else {
      if (dirExists && !hasGit) {
        // Corrupted state — remove and re-clone
        rmSync(targetDir, { recursive: true, force: true });
      }

      // Ensure parent directories exist
      mkdirSync(path.dirname(targetDir), { recursive: true });

      const authenticatedUrl = plugin.getAuthenticatedUrl(repo.url);
      await plugin.cloneRepository(authenticatedUrl, targetDir);
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
