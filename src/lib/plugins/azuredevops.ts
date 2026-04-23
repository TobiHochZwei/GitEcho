import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

import { getConfig } from '../config.js';
import { rethrowAsUnavailableIfMatch } from './errors.js';
import type { ProviderPlugin, RepositoryInfo } from './interface.js';

const execFileAsync = promisify(execFile);

// Matches https://dev.azure.com/{org}/{project}/_git/{repo}
const AZURE_DEVOPS_URL_RE =
  /^https:\/\/dev\.azure\.com\/(?<org>[^/]+)\/(?<project>[^/]+)\/_git\/(?<repo>[^/\s]+)$/;

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
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${msg}`);
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

  async cloneRepository(repoUrl: string, targetDir: string): Promise<void> {
    const authenticatedUrl = this.getAuthenticatedUrl(repoUrl);
    try {
      await execCommand('git', ['clone', authenticatedUrl, targetDir]);
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoUrl);
    }
  }

  async pullRepository(repoDir: string): Promise<void> {
    try {
      await execCommand('git', ['-C', repoDir, 'fetch', '--all']);
    } catch (error) {
      rethrowAsUnavailableIfMatch(error, repoDir);
    }

    try {
      await execCommand('git', ['-C', repoDir, 'pull', '--ff-only']);
    } catch (error) {
      logger.warn(
        `[azuredevops] Fast-forward pull failed for "${repoDir}" (branches may have diverged):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  getAuthenticatedUrl(repoUrl: string): string {
    const config = getConfig();
    if (!config.azureDevOps?.pat) return repoUrl;

    try {
      const url = new URL(repoUrl);
      url.username = config.azureDevOps.pat;
      return url.toString();
    } catch {
      // Fallback: simple string replacement
      return repoUrl.replace('https://', `https://${config.azureDevOps.pat}@`);
    }
  }
}
