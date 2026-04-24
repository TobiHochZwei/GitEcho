import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
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

// Matches https://dev.azure.com/{org}/{project}/_git/{repo}
const AZURE_DEVOPS_URL_RE =
  /^https:\/\/dev\.azure\.com\/(?<org>[^/]+)\/(?<project>[^/]+)\/_git\/(?<repo>[^/\s]+)$/;

// Matches legacy https://{org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
const LEGACY_VSTS_URL_RE =
  /^https:\/\/(?<org>[^./]+)\.visualstudio\.com(?:\/DefaultCollection)?\/(?<project>[^/]+)\/_git\/(?<repo>[^/\s?#]+)/i;

/**
 * Rewrite legacy `<org>.visualstudio.com[/DefaultCollection]/...` URLs to the
 * modern `dev.azure.com/<org>/...` form. The legacy endpoint is notorious
 * for unstable HTTP/2 transfers on large repos ("early EOF",
 * "HTTP/2 stream CANCEL"), while dev.azure.com is far more reliable.
 * URLs that already point at dev.azure.com (or any unknown host) are returned
 * unchanged.
 */
function normalizeRepoUrl(url: string): string {
  const match = url.match(LEGACY_VSTS_URL_RE);
  if (!match?.groups) return url;
  const { org, project, repo } = match.groups;
  return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
}

/**
 * Extra `-c` flags prepended to every git invocation to work around two
 * common failure modes when cloning large Azure DevOps / GitHub repos:
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
 * next scheduled backup cycle, and retrying would only delay surfacing a
 * real problem.
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

/** Run a command and return its stdout, trimming trailing whitespace. */
async function execCommand(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
    return stdout.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Never leak PATs or other credentials embedded in the command or stderr.
    const safeArgs = args.map((a) => redactSecrets(a));
    throw new Error(
      `Command failed: ${command} ${safeArgs.join(' ')}\n${redactSecrets(msg)}`,
    );
  }
}

/** Return the environment variables needed for az CLI authentication. */
function azEnv(): NodeJS.ProcessEnv {
  const config = getConfig();
  return {
    ...process.env,
    ...(config.azureDevOps ? { AZURE_DEVOPS_EXT_PAT: config.azureDevOps.pat } : {}),
  };
}

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

/** Extract the organization URL from a dev.azure.com repo URL. */
function orgUrlFromRepoUrl(repoUrl: string): string | undefined {
  const match = repoUrl.match(AZURE_DEVOPS_URL_RE);
  if (!match?.groups) return undefined;
  return `https://dev.azure.com/${match.groups.org}`;
}

/**
 * Read repos.txt and return only Azure DevOps URLs together with their parsed
 * components (org, project, repo).
 */
async function readReposTxt(): Promise<
  { url: string; org: string; project: string; repo: string }[]
> {
  const config = getConfig();
  const reposFile = path.join(config.configDir, 'repos.txt');

  let content: string;
  try {
    content = await readFile(reposFile, 'utf-8');
  } catch {
    return [];
  }

  const entries: { url: string; org: string; project: string; repo: string }[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(AZURE_DEVOPS_URL_RE);
    if (match?.groups) {
      entries.push({
        url: line,
        org: match.groups.org,
        project: match.groups.project,
        repo: match.groups.repo,
      });
    }
  }

  return entries;
}

/**
 * Discover the organization URL. Order of precedence:
 *   1. settings.json via getConfig() (UI-managed — highest priority)
 *   2. AZUREDEVOPS_ORG environment variable
 *   3. First Azure DevOps entry in /config/repos.txt
 */
async function discoverOrgUrl(): Promise<string | undefined> {
  const cfgOrg = getConfig().azureDevOps?.org;
  if (cfgOrg) return normalizeOrgUrl(cfgOrg);

  const envOrg = process.env.AZUREDEVOPS_ORG;
  if (envOrg) return normalizeOrgUrl(envOrg);

  const entries = await readReposTxt();
  if (entries.length > 0) {
    return `https://dev.azure.com/${entries[0].org}`;
  }

  return undefined;
}

/**
 * Accept any of the common spellings users tend to paste into the UI and
 * return a canonical `https://dev.azure.com/<org>` URL.
 *   - "myorg"                                   -> https://dev.azure.com/myorg
 *   - "https://dev.azure.com/myorg"             -> same
 *   - "https://dev.azure.com/myorg/"            -> same (trailing slash stripped)
 *   - "https://myorg.visualstudio.com"          -> https://dev.azure.com/myorg
 */
function normalizeOrgUrl(input: string): string | undefined {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;

  const devAzure = trimmed.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (devAzure) return `https://dev.azure.com/${devAzure[1]}`;

  const legacyVs = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com/i);
  if (legacyVs) return `https://dev.azure.com/${legacyVs[1]}`;

  // Bare org name — no scheme, no slashes
  if (!/[/:\s]/.test(trimmed)) return `https://dev.azure.com/${trimmed}`;

  return undefined;
}

interface AzProject {
  name: string;
  visibility?: string;
}

interface AzRepo {
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  remoteUrl?: string;
  project?: { name?: string };
}

export class AzureDevOpsPlugin implements ProviderPlugin {
  readonly name = 'azuredevops';
  readonly displayName = 'Azure DevOps';

  isConfigured(): boolean {
    const config = getConfig();
    return config.azureDevOps !== undefined;
  }

  async authenticate(): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const orgUrl = await discoverOrgUrl();
    if (!orgUrl) {
      logger.warn('[azuredevops] No organization URL found — cannot authenticate');
      return false;
    }

    try {
      await execCommand(
        'az',
        ['devops', 'project', 'list', '--organization', orgUrl, '--output', 'json'],
        { env: azEnv() },
      );
      return true;
    } catch (error) {
      logger.error('[azuredevops] Authentication failed:', error);
      return false;
    }
  }

  async listRepositories(): Promise<RepositoryInfo[]> {
    const seen = new Set<string>();
    const repos: RepositoryInfo[] = [];

    const addRepo = (info: RepositoryInfo) => {
      const key = info.url.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      repos.push(info);
    };

    // 1. Repos from repos.txt
    const txtEntries = await readReposTxt();
    for (const entry of txtEntries) {
      addRepo({
        url: entry.url,
        name: entry.repo,
        owner: `${entry.org}/${entry.project}`,
        provider: 'azuredevops',
      });
    }

    // 2. Auto-discover repos via az CLI (controlled by the per-provider toggle, default true)
    const autoDiscover = getConfig().azureDevOps?.autoDiscover ?? true;
    const orgUrl = await discoverOrgUrl();
    if (autoDiscover && orgUrl && this.isConfigured()) {
      try {
        const projectsJson = await execCommand(
          'az',
          ['devops', 'project', 'list', '--organization', orgUrl, '--output', 'json'],
          { env: azEnv() },
        );

        const projectsData = JSON.parse(projectsJson) as { value?: AzProject[] };
        const projects = projectsData.value ?? [];

        for (const project of projects) {
          try {
            const reposJson = await execCommand(
              'az',
              [
                'repos',
                'list',
                '--organization',
                orgUrl,
                '--project',
                project.name,
                '--output',
                'json',
              ],
              { env: azEnv() },
            );

            const repoList = JSON.parse(reposJson) as AzRepo[];
            const projectIsPrivate = project.visibility
              ? project.visibility.toLowerCase() !== 'public'
              : true;

            for (const repo of repoList) {
              const repoUrl =
                repo.webUrl ??
                repo.remoteUrl ??
                `${orgUrl}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repo.name)}`;
              const defaultBranch = repo.defaultBranch?.replace(/^refs\/heads\//, '');

              addRepo({
                url: repoUrl,
                name: repo.name,
                owner: `${orgUrl.replace('https://dev.azure.com/', '')}/${project.name}`,
                provider: 'azuredevops',
                isPrivate: projectIsPrivate,
                ...(defaultBranch ? { defaultBranch } : {}),
              });
            }
          } catch (error) {
            logger.warn(
              `[azuredevops] Failed to list repos for project "${project.name}":`,
              error,
            );
          }
        }
      } catch (error) {
        logger.warn('[azuredevops] Failed to list projects:', error);
      }
    }

    return repos;
  }

  async cloneRepository(
    repoUrl: string,
    targetDir: string,
    opts: PluginCallOptions = {},
  ): Promise<void> {
    const authenticatedUrl = this.getAuthenticatedUrl(repoUrl);
    const trace = opts.trace ?? { enabled: false, repoId: 0 };
    logger.info(
      `[azuredevops] Clone "${redactSecrets(repoUrl)}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );
    try {
      await retry(
        async () => {
          if (trace.enabled) {
            const logPath = await newTraceLogPath(trace.repoId, 'clone');
            logger.info(
              `[azuredevops] Debug trace enabled for "${redactSecrets(repoUrl)}" — writing to ${logPath}`,
            );
            await execGitWithTrace(
              gitArgs('clone', authenticatedUrl, targetDir),
              logPath,
              nonInteractiveGitEnv(),
            );
            void pruneOldLogs(trace.repoId);
            return;
          }
          await execCommand('git', gitArgs('clone', authenticatedUrl, targetDir), {
            env: nonInteractiveGitEnv(),
          });
        },
        {
          shouldRetry: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            // Don't retry genuine "repo gone / no access" errors — retrying
            // would only waste time before the inevitable failure.
            return !classifyGitError(msg);
          },
          onRetry: async (err, attempt) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[azuredevops] Clone attempt ${attempt} failed for "${repoUrl}", retrying: ${redactSecrets(msg)}`,
            );
            // `git clone` refuses to write into a non-empty directory, so
            // clean up any partial data from the failed attempt.
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
      `[azuredevops] Pull "${repoDir}" — debug trace ${trace.enabled ? 'enabled' : 'disabled'}`,
    );

    try {
      // `--prune` ensures deleted upstream branches disappear from
      // refs/remotes/origin/* so `set-head --auto` below can resolve the
      // current default branch correctly.
      if (trace.enabled) {
        const logPath = await newTraceLogPath(trace.repoId, 'pull');
        logger.info(
          `[azuredevops] Debug trace enabled for "${repoDir}" — writing to ${logPath}`,
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
    // If the remote has no branches at all (e.g. a freshly created,
    // still-empty Azure DevOps repo), `git remote set-head --auto` cannot
    // resolve HEAD and fails with "Cannot determine remote HEAD". That's
    // expected, not a malfunction — skip quietly with an info note.
    const remoteBranchList = await execFileAsync(
      'git',
      ['-C', repoDir, 'ls-remote', '--heads', 'origin'],
      { env: nonInteractiveGitEnv() },
    )
      .then(({ stdout }) => stdout.trim())
      .catch(() => '');
    if (remoteBranchList.length === 0) {
      logger.info(
        `[azuredevops] Remote for "${repoDir}" appears to be empty (no branches) — skipping fast-forward.`,
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
      // ref looks like "origin/main" — strip the "origin/" prefix.
      remoteDefault = ref.replace(/^origin\//, '');
    } catch (error) {
      logger.warn(
        `[azuredevops] Could not determine remote default branch for "${repoDir}":`,
        error instanceof Error ? error.message : error,
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

    // Does the local branch still exist on the remote?
    const currentTrackedOnRemote =
      !!currentLocal &&
      (await execFileAsync('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/remotes/origin/${currentLocal}`], {
        env: nonInteractiveGitEnv(),
      })
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
          `[azuredevops] Fast-forward pull failed for "${repoDir}" (branches may have diverged):`,
          error instanceof Error ? error.message : error,
        );
      }
      return;
    }

    // Current local branch no longer exists upstream — switch to the remote default.
    if (!remoteDefault) {
      logger.warn(
        `[azuredevops] Local branch "${currentLocal}" is gone upstream and no remote default could be resolved for "${repoDir}"`,
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
        `[azuredevops] Remote default branch changed ${currentLocal ?? '?'} → ${remoteDefault} for "${repoDir}", switched local checkout`,
      );
    } catch (error) {
      logger.warn(
        `[azuredevops] Failed to switch "${repoDir}" to new default branch "${remoteDefault}":`,
        error instanceof Error ? error.message : error,
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
      // Strip any embedded credentials, then rebuild from the canonical URL.
      const cleaned = current.replace(
        /https:\/\/[^/@\s]+(?::[^/@\s]+)?@dev\.azure\.com\//i,
        'https://dev.azure.com/',
      );
      // Also migrate legacy *.visualstudio.com origins to dev.azure.com —
      // the legacy endpoint suffers from flaky HTTP/2 transfers on large repos.
      const withoutLegacyCreds = cleaned.replace(
        /https:\/\/[^/@\s]+(?::[^/@\s]+)?@([^./]+)\.visualstudio\.com\//i,
        'https://$1.visualstudio.com/',
      );
      const normalized = normalizeRepoUrl(withoutLegacyCreds);
      const fresh = this.getAuthenticatedUrl(normalized);
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
    const config = getConfig();
    const normalized = normalizeRepoUrl(repoUrl);
    if (!config.azureDevOps?.pat) return normalized;

    // Strip any previously-embedded credentials so a rotated PAT always wins
    // (old clones may have the previous token baked into their remote URL).
    const cleaned = normalized.replace(
      /^(https:\/\/)[^/@\s]+(?::[^/@\s]+)?@dev\.azure\.com\//i,
      '$1dev.azure.com/',
    );

    try {
      const url = new URL(cleaned);
      // Azure DevOps accepts Basic auth with any (or empty) username and the
      // PAT as password. Using an explicit "pat" username is more portable
      // than username-only, which some git/credential-helper combos treat as
      // "missing password" and prompt for interactively.
      url.username = 'pat';
      url.password = config.azureDevOps.pat;
      return url.toString();
    } catch {
      // Fallback: simple string replacement
      return cleaned.replace('https://', `https://pat:${config.azureDevOps.pat}@`);
    }
  }
}
