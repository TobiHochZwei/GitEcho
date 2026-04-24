import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { logger, redactSecrets } from '../logger.js';

import { getConfig } from '../config.js';
import { classifyGitError, rethrowAsUnavailableIfMatch } from './errors.js';
import { execGitWithTrace, newTraceLogPath, pruneOldLogs } from './git-trace.js';
import type {
  PluginCallOptions,
  ProviderPlugin,
  RepositoryInfo,
} from './interface.js';

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

/**
 * Extra `-c` flags prepended to every git invocation to work around two
 * common failure modes when cloning large repos:
 *   - HTTP/2 stream cancellations ("curl 92 … CANCEL", "early EOF") → force
 *     HTTP/1.1, which is dramatically more tolerant of proxies/firewalls.
 *   - Large pack files exceeding the default POST buffer → bump to 500 MB.
 */
const GIT_TRANSPORT_FLAGS: string[] = [
  '-c',
  'http.version=HTTP/1.1',
  '-c',
  'http.postBuffer=524288000',
];

/** Prepend the transport-hardening `-c` flags to a git argv. */
function gitArgs(...args: string[]): string[] {
  return [...GIT_TRANSPORT_FLAGS, ...args];
}

/**
 * Retry an async operation a few times with linear backoff. Intended for
 * `git clone` only — `fetch`/`pull` are already retried implicitly by the
 * next scheduled backup cycle.
 */
async function retry<T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    backoffMs = 2000,
    shouldRetry = () => true,
    onRetry,
  }: {
    attempts?: number;
    backoffMs?: number;
    shouldRetry?: (err: unknown) => boolean;
    onRetry?: (err: unknown, attempt: number) => void | Promise<void>;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err)) throw err;
      if (onRetry) await onRetry(err, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastErr;
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

  async cloneRepository(
    repoUrl: string,
    targetDir: string,
    opts: PluginCallOptions = {},
  ): Promise<void> {
    const url = this.getAuthenticatedUrl(repoUrl);
    const trace = opts.trace ?? { enabled: false, repoId: 0 };
    logger.info(
      `[github] Clone "${redactSecrets(repoUrl)}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );
    try {
      await retry(
        async () => {
          if (trace.enabled) {
            const logPath = await newTraceLogPath(trace.repoId, 'clone');
            logger.info(
              `[github] Debug trace enabled for "${redactSecrets(repoUrl)}" — writing to ${logPath}`,
            );
            await execGitWithTrace(
              gitArgs('clone', url, targetDir),
              logPath,
              nonInteractiveGitEnv(),
            );
            void pruneOldLogs(trace.repoId);
            return;
          }
          await execCommand('git', gitArgs('clone', url, targetDir), {
            env: nonInteractiveGitEnv(),
          });
        },
        {
          shouldRetry: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            return !classifyGitError(msg);
          },
          onRetry: async (err, attempt) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[github] Clone attempt ${attempt} failed for "${repoUrl}", retrying: ${redactSecrets(msg)}`,
            );
            try {
              await rm(targetDir, { recursive: true, force: true });
            } catch {
              // Best-effort — next attempt will surface any real problem.
            }
          },
        },
      );
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoUrl);
    }
  }

  async pullRepository(
    repoDir: string,
    opts: PluginCallOptions = {},
  ): Promise<void> {
    // Heal existing clones that were made before the auth-URL format fix:
    // rewrite the remote URL to the current (correct) authenticated form so
    // fetch/pull don't fall back to an interactive password prompt.
    await this.healRemoteUrl(repoDir);

    const trace = opts.trace ?? { enabled: false, repoId: 0 };

    logger.info(
      `[github] Pull "${repoDir}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );

    try {
      // `--prune` ensures deleted upstream branches disappear from
      // refs/remotes/origin/* so `set-head --auto` below can resolve the
      // current default branch correctly.
      if (trace.enabled) {
        const logPath = await newTraceLogPath(trace.repoId, 'pull');
        logger.info(
          `[github] Debug trace enabled for "${repoDir}" — writing to ${logPath}`,
        );
        await execGitWithTrace(
          gitArgs('-C', repoDir, 'fetch', '--all', '--prune'),
          logPath,
          nonInteractiveGitEnv(),
        );
        void pruneOldLogs(trace.repoId);
      } else {
        await execCommand('git', gitArgs('-C', repoDir, 'fetch', '--all', '--prune'), {
          env: nonInteractiveGitEnv(),
        });
      }
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoDir);
    }

    await this.fastForwardToRemoteDefault(repoDir);
  }

  /**
   * Fast-forward the working copy to the remote's current state, tolerating
   * upstream branch renames/deletions (e.g. "master" → "main"):
   *   1. Refresh origin/HEAD so we know the current remote default.
   *   2. If the local branch still exists on the remote → ff-only merge.
   *   3. Otherwise → switch the local checkout to the new remote default.
   *   4. On genuine divergence → warn and return (never force).
   */
  private async fastForwardToRemoteDefault(repoDir: string): Promise<void> {
    // Empty remote (no branches yet) → `set-head --auto` would fail with
    // "Cannot determine remote HEAD". Detect and skip quietly.
    const remoteBranchList = await execFileAsync(
      'git',
      ['-C', repoDir, 'ls-remote', '--heads', 'origin'],
      { env: nonInteractiveGitEnv() },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => '');
    if (remoteBranchList.length === 0) {
      logger.info(
        `[github] Remote for "${repoDir}" appears to be empty (no branches) — skipping fast-forward.`,
      );
      return;
    }

    let remoteDefault: string | undefined;
    try {
      await execCommand('git', gitArgs('-C', repoDir, 'remote', 'set-head', 'origin', '--auto'), {
        env: nonInteractiveGitEnv(),
      });
      const ref = await execCommand(
        'git',
        gitArgs('-C', repoDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
        { env: nonInteractiveGitEnv() },
      );
      remoteDefault = ref.replace(/^origin\//, '');
    } catch (error) {
      logger.warn(
        `[github] Could not determine remote default branch for "${repoDir}": ${(error as Error).message}`,
      );
      return;
    }

    let currentLocal: string | undefined;
    try {
      currentLocal = await execCommand(
        'git',
        gitArgs('-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
        { env: nonInteractiveGitEnv() },
      );
    } catch {
      currentLocal = undefined;
    }

    const currentTrackedOnRemote =
      !!currentLocal &&
      (await execFileAsync(
        'git',
        ['-C', repoDir, 'rev-parse', '--verify', `refs/remotes/origin/${currentLocal}`],
        { env: nonInteractiveGitEnv() },
      )
        .then(() => true)
        .catch(() => false));

    if (currentTrackedOnRemote && currentLocal) {
      try {
        await execCommand(
          'git',
          gitArgs('-C', repoDir, 'merge', '--ff-only', `origin/${currentLocal}`),
          { env: nonInteractiveGitEnv() },
        );
      } catch (error) {
        logger.warn(
          `[github] pull --ff-only failed for ${repoDir}, history may have diverged: ${(error as Error).message}`,
        );
      }
      return;
    }

    if (!remoteDefault) {
      logger.warn(
        `[github] Local branch "${currentLocal}" is gone upstream and no remote default could be resolved for "${repoDir}"`,
      );
      return;
    }

    try {
      await execCommand(
        'git',
        gitArgs('-C', repoDir, 'checkout', '-B', remoteDefault, `origin/${remoteDefault}`),
        { env: nonInteractiveGitEnv() },
      );
      logger.info(
        `[github] Remote default branch changed ${currentLocal ?? '?'} → ${remoteDefault} for "${repoDir}", switched local checkout`,
      );
    } catch (error) {
      logger.warn(
        `[github] Failed to switch "${repoDir}" to new default branch "${remoteDefault}": ${(error as Error).message}`,
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
