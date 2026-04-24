import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { logger, redactSecrets } from '../logger.js';

import { getConfig } from '../config.js';
import { rethrowAsUnavailableIfMatch } from './errors.js';
import type { ProviderPlugin, RepositoryInfo } from './interface.js';

const execFileAsync = promisify(execFile);

/**
 * Environment variables that disable any interactive git/credential prompts.
 * Without these, git will block forever on stdin when authentication fails —
 * e.g. when running in a container with no TTY and a bad/expired PAT.
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'Never',
  };
}

async function execCommand(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf-8',
      ...options,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const detail = err.stderr?.trim() || err.message;
    // Never leak PATs or other credentials embedded in the command or stderr.
    const safeArgs = args.map((a) => redactSecrets(a));
    throw new Error(
      `Command failed: ${command} ${safeArgs.join(' ')}\n${redactSecrets(detail)}`,
    );
  }
}

interface GhRepoJson {
  name: string;
  owner: { login: string };
  url: string;
  defaultBranchRef?: { name: string };
  isPrivate: boolean;
  description: string | null;
}

export class GitHubPlugin implements ProviderPlugin {
  readonly name = 'github';
  readonly displayName = 'GitHub';

  isConfigured(): boolean {
    return getConfig().github !== undefined;
  }

  async authenticate(): Promise<boolean> {
    try {
      await execCommand('gh', ['auth', 'status'], {
        env: { ...process.env, GH_TOKEN: this.getPat() },
      });
      return true;
    } catch {
      return false;
    }
  }

  async listRepositories(): Promise<RepositoryInfo[]> {
    const autoDiscover = getConfig().github?.autoDiscover ?? true;
    const [ghRepos, fileRepos] = await Promise.all([
      autoDiscover ? this.listFromGitHub() : Promise.resolve([] as RepositoryInfo[]),
      this.listFromConfigFile(),
    ]);

    // Merge: use a map keyed by normalised URL to deduplicate
    const merged = new Map<string, RepositoryInfo>();
    for (const repo of [...ghRepos, ...fileRepos]) {
      const key = repo.url.replace(/\.git$/, '').toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, repo);
      }
    }

    return Array.from(merged.values());
  }

  async cloneRepository(repoUrl: string, targetDir: string): Promise<void> {
    const url = this.getAuthenticatedUrl(repoUrl);
    try {
      await execCommand('git', ['clone', url, targetDir], { env: nonInteractiveGitEnv() });
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoUrl);
    }
  }

  async pullRepository(repoDir: string): Promise<void> {
    // Heal existing clones that were made before the auth-URL format fix:
    // rewrite the remote URL to the current (correct) authenticated form so
    // fetch/pull don't fall back to an interactive password prompt.
    await this.healRemoteUrl(repoDir);

    try {
      await execCommand('git', ['-C', repoDir, 'fetch', '--all'], {
        env: nonInteractiveGitEnv(),
      });
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoDir);
    }
    try {
      await execCommand('git', ['-C', repoDir, 'pull', '--ff-only'], {
        env: nonInteractiveGitEnv(),
      });
    } catch (error) {
      logger.warn(
        `[github] pull --ff-only failed for ${repoDir}, history may have diverged: ${(error as Error).message}`,
      );
    }
  }

  private async healRemoteUrl(repoDir: string): Promise<void> {
    try {
      const current = await execCommand(
        'git',
        ['-C', repoDir, 'remote', 'get-url', 'origin'],
        { env: nonInteractiveGitEnv() },
      );
      // Strip any embedded credentials before rebuilding the URL.
      const cleaned = current.replace(/https:\/\/[^/@\s]+@github\.com\//i, 'https://github.com/');
      const fresh = this.getAuthenticatedUrl(cleaned.replace(/\.git$/, ''));
      if (fresh !== current) {
        await execCommand('git', ['-C', repoDir, 'remote', 'set-url', 'origin', fresh], {
          env: nonInteractiveGitEnv(),
        });
      }
    } catch {
      // Best-effort — if remote doesn't exist yet or the repo is being cloned,
      // fetch will surface the real error below.
    }
  }

  getAuthenticatedUrl(repoUrl: string): string {
    const pat = this.getPat();
    // Strip any previously-embedded credentials so a rotated PAT always wins
    // (old clones may have the previous token baked into their remote URL).
    const stripped = repoUrl.replace(
      /^(https:\/\/)[^/@\s]+(?::[^/@\s]+)?@github\.com\//i,
      '$1github.com/',
    );
    const normalized = stripped.replace(/\.git$/, '');
    // Use "x-access-token:<pat>@github.com" which is the documented form for
    // both classic (ghp_) and fine-grained (github_pat_) PATs. The bare
    // "<pat>@github.com" variant is rejected by fine-grained PATs, which
    // causes git to fall back to an interactive password prompt and hang the
    // worker when running without a TTY (e.g. in Docker).
    return (
      normalized.replace('https://github.com/', `https://x-access-token:${pat}@github.com/`) +
      '.git'
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getPat(): string {
    const cfg = getConfig().github;
    if (!cfg) {
      throw new Error('GitHub provider is not configured (missing PAT)');
    }
    return cfg.pat;
  }

  private async listFromGitHub(): Promise<RepositoryInfo[]> {
    const json = await execCommand(
      'gh',
      [
        'repo',
        'list',
        '--limit',
        '1000',
        '--json',
        'name,owner,url,defaultBranchRef,isPrivate,description',
      ],
      { env: { ...process.env, GH_TOKEN: this.getPat() } },
    );

    const repos: GhRepoJson[] = JSON.parse(json);
    return repos.map((r) => ({
      url: r.url,
      name: r.name,
      owner: r.owner.login,
      provider: 'github',
      defaultBranch: r.defaultBranchRef?.name,
      isPrivate: r.isPrivate,
      description: r.description ?? undefined,
    }));
  }

  private async listFromConfigFile(): Promise<RepositoryInfo[]> {
    const configDir = getConfig().configDir;
    const filePath = `${configDir}/repos.txt`;

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist — nothing extra to load
      return [];
    }

    const repos: RepositoryInfo[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      // Expect URLs like https://github.com/owner/repo
      const match = line.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (!match) continue;

      repos.push({
        url: line.replace(/\.git$/, ''),
        name: match[2],
        owner: match[1],
        provider: 'github',
      });
    }

    return repos;
  }
}
