import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { getConfig } from '../config.js';
import type { ProviderPlugin, RepositoryInfo } from './interface.js';

const execFileAsync = promisify(execFile);

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
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${detail}`);
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
    await execCommand('git', ['clone', url, targetDir]);
  }

  async pullRepository(repoDir: string): Promise<void> {
    await execCommand('git', ['-C', repoDir, 'fetch', '--all']);
    try {
      await execCommand('git', ['-C', repoDir, 'pull', '--ff-only']);
    } catch (error) {
      console.warn(
        `[github] pull --ff-only failed for ${repoDir}, history may have diverged: ${(error as Error).message}`,
      );
    }
  }

  getAuthenticatedUrl(repoUrl: string): string {
    const pat = this.getPat();
    const normalized = repoUrl.replace(/\.git$/, '');
    return normalized.replace('https://github.com/', `https://${pat}@github.com/`) + '.git';
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
