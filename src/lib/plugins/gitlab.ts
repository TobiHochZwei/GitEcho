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

/** Default host when none is configured. */
const DEFAULT_HOST = 'gitlab.com';

/**
 * Return the configured GitLab host (without scheme or trailing slash),
 * defaulting to gitlab.com for SaaS.
 */
function gitlabHost(): string {
  const raw = getConfig().gitlab?.host?.trim();
  if (!raw) return DEFAULT_HOST;
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Regex matching a GitLab repository URL for a specific host. GitLab supports
 * nested groups (`group/subgroup/.../repo`), so the path must contain at
 * least two non-empty segments.
 */
function gitlabUrlRe(host: string): RegExp {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https?:\\/\\/${escaped}\\/(?<path>[^\\s]+?)(?:\\.git)?\\/?$`, 'i');
}

/**
 * Parse a GitLab URL into its namespace path and repository name.
 * Returns undefined when the URL does not belong to the configured host.
 */
function parseGitLabUrl(
  url: string,
  host: string = gitlabHost(),
): { owner: string; name: string; url: string } | undefined {
  const match = url.match(gitlabUrlRe(host));
  if (!match?.groups) return undefined;
  const path = match.groups.path.replace(/\/+$/, '');
  const segments = path.split('/');
  if (segments.length < 2) return undefined;
  const name = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join('/');
  return { owner, name, url: `https://${host}/${path}` };
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

function gitArgs(...args: string[]): string[] {
  return [...GIT_TRANSPORT_FLAGS, ...args];
}

function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'Never',
  };
}

/** Env passed to `glab` so it authenticates against the configured host + PAT. */
function glabEnv(): NodeJS.ProcessEnv {
  const pat = getConfig().gitlab?.pat;
  const host = gitlabHost();
  return {
    ...process.env,
    ...(pat ? { GITLAB_TOKEN: pat } : {}),
    GITLAB_HOST: host,
  };
}

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
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      ...options,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const detail = err.stderr?.trim() || err.message;
    const safeArgs = args.map((a) => redactSecrets(a));
    throw new Error(
      `Command failed: ${command} ${safeArgs.join(' ')}\n${redactSecrets(detail)}`,
    );
  }
}

/** GitLab REST response shape for `/projects?membership=true`. */
interface GlProject {
  web_url: string;
  path_with_namespace: string;
  default_branch?: string | null;
  visibility?: string;
  description?: string | null;
}

export class GitLabPlugin implements ProviderPlugin {
  readonly name = 'gitlab';
  readonly displayName = 'GitLab';

  isConfigured(): boolean {
    return getConfig().gitlab !== undefined;
  }

  async authenticate(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await execCommand('glab', ['auth', 'status'], { env: glabEnv() });
      return true;
    } catch (error) {
      logger.error('[gitlab] Authentication failed:', error);
      return false;
    }
  }

  async listRepositories(): Promise<RepositoryInfo[]> {
    const autoDiscover = getConfig().gitlab?.autoDiscover ?? true;
    const [apiRepos, fileRepos] = await Promise.all([
      autoDiscover ? this.listFromGitLab() : Promise.resolve([] as RepositoryInfo[]),
      this.listFromConfigFile(),
    ]);

    const merged = new Map<string, RepositoryInfo>();
    for (const repo of [...apiRepos, ...fileRepos]) {
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
      `[gitlab] Clone "${redactSecrets(repoUrl)}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );
    try {
      await retry(
        async () => {
          if (trace.enabled) {
            const logPath = await newTraceLogPath(trace.repoId, 'clone');
            logger.info(
              `[gitlab] Debug trace enabled for "${redactSecrets(repoUrl)}" — writing to ${logPath}`,
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
              `[gitlab] Clone attempt ${attempt} failed for "${repoUrl}", retrying: ${redactSecrets(msg)}`,
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
    await this.healRemoteUrl(repoDir);

    const trace = opts.trace ?? { enabled: false, repoId: 0 };

    logger.info(
      `[gitlab] Pull "${repoDir}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );

    try {
      if (trace.enabled) {
        const logPath = await newTraceLogPath(trace.repoId, 'pull');
        logger.info(
          `[gitlab] Debug trace enabled for "${repoDir}" — writing to ${logPath}`,
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
        `[gitlab] Remote for "${repoDir}" appears to be empty (no branches) — skipping fast-forward.`,
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
        `[gitlab] Could not determine remote default branch for "${repoDir}": ${(error as Error).message}`,
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
          `[gitlab] pull --ff-only failed for ${repoDir}, history may have diverged: ${(error as Error).message}`,
        );
      }
      return;
    }

    if (!remoteDefault) {
      logger.warn(
        `[gitlab] Local branch "${currentLocal}" is gone upstream and no remote default could be resolved for "${repoDir}"`,
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
        `[gitlab] Remote default branch changed ${currentLocal ?? '?'} → ${remoteDefault} for "${repoDir}", switched local checkout`,
      );
    } catch (error) {
      logger.warn(
        `[gitlab] Failed to switch "${repoDir}" to new default branch "${remoteDefault}": ${(error as Error).message}`,
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
      const cleaned = current.replace(
        /^(https:\/\/)[^/@\s]+(?::[^/@\s]+)?@/i,
        '$1',
      );
      const fresh = this.getAuthenticatedUrl(cleaned.replace(/\.git$/, ''));
      if (fresh !== current) {
        await execCommand('git', ['-C', repoDir, 'remote', 'set-url', 'origin', fresh], {
          env: nonInteractiveGitEnv(),
        });
      }
    } catch {
      // Best-effort — fetch will surface the real error below.
    }
  }

  getAuthenticatedUrl(repoUrl: string): string {
    const pat = getConfig().gitlab?.pat;
    // Strip any previously-embedded credentials so a rotated PAT always wins.
    const stripped = repoUrl.replace(
      /^(https:\/\/)[^/@\s]+(?::[^/@\s]+)?@/i,
      '$1',
    );
    const normalized = stripped.replace(/\.git$/, '');
    if (!pat) return `${normalized}.git`;
    try {
      const url = new URL(normalized);
      // GitLab accepts `oauth2:<token>` as HTTP Basic auth for any PAT.
      url.username = 'oauth2';
      url.password = pat;
      return url.toString() + '.git';
    } catch {
      return normalized.replace('https://', `https://oauth2:${pat}@`) + '.git';
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Discover repos visible to the configured PAT via GitLab's REST API.
   * We call the API directly (rather than via `glab api`) so a single SDK-less
   * fetch walks paginated results — simpler than scripting `glab`.
   */
  private async listFromGitLab(): Promise<RepositoryInfo[]> {
    const cfg = getConfig().gitlab;
    if (!cfg?.pat) return [];
    const host = gitlabHost();
    const baseUrl = `https://${host}/api/v4`;
    const pageSize = 100;
    const repos: RepositoryInfo[] = [];

    for (let page = 1; page <= 50; page++) {
      const url = `${baseUrl}/projects?membership=true&simple=false&per_page=${pageSize}&page=${page}&order_by=id&sort=asc`;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            'PRIVATE-TOKEN': cfg.pat,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        logger.warn(`[gitlab] Failed to fetch projects page ${page}:`, err);
        break;
      }
      if (!res.ok) {
        logger.warn(
          `[gitlab] Projects API returned ${res.status} on page ${page}: ${redactSecrets(await res.text().catch(() => ''))}`,
        );
        break;
      }
      const batch = (await res.json()) as GlProject[];
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const p of batch) {
        const parsed = parseGitLabUrl(p.web_url, host);
        if (!parsed) {
          // Fallback to path_with_namespace if web_url didn't match (e.g.
          // custom host in redirect). Parse it the same way.
          const path = p.path_with_namespace.replace(/\/+$/, '');
          const segs = path.split('/');
          if (segs.length < 2) continue;
          const name = segs[segs.length - 1];
          const owner = segs.slice(0, -1).join('/');
          repos.push({
            url: `https://${host}/${path}`,
            name,
            owner,
            provider: 'gitlab',
            defaultBranch: p.default_branch ?? undefined,
            isPrivate: p.visibility ? p.visibility.toLowerCase() !== 'public' : undefined,
            description: p.description ?? undefined,
          });
          continue;
        }
        repos.push({
          url: parsed.url,
          name: parsed.name,
          owner: parsed.owner,
          provider: 'gitlab',
          defaultBranch: p.default_branch ?? undefined,
          isPrivate: p.visibility ? p.visibility.toLowerCase() !== 'public' : undefined,
          description: p.description ?? undefined,
        });
      }

      if (batch.length < pageSize) break;
    }

    return repos;
  }

  private async listFromConfigFile(): Promise<RepositoryInfo[]> {
    const configDir = getConfig().configDir;
    const filePath = `${configDir}/repos.txt`;
    const host = gitlabHost();

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const repos: RepositoryInfo[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parsed = parseGitLabUrl(line, host);
      if (!parsed) continue;
      repos.push({
        url: parsed.url,
        name: parsed.name,
        owner: parsed.owner,
        provider: 'gitlab',
      });
    }
    return repos;
  }
}
