// Shared repository discovery pipeline.
//
// Used both:
//  - At the start of every backup cycle (replaces the inline loop that lived
//    in src/lib/backup/engine.ts).
//  - On-demand from the Settings UI (PUT /api/settings/providers fires a
//    background sweep; POST /api/settings/providers/discover is a manual
//    "Discover now" button).
//
// Responsibilities:
//   1. Authenticate each configured provider and call listRepositories().
//   2. Apply per-provider filters (owner allow/deny, visibility).
//   3. Persist results via upsertRepository() and detect first sightings.
//   4. Optionally append new URLs to /config/repos.txt.
//   5. Optionally email a "new repos discovered" notification.

import { getConfig } from './config.js';
import { isNewRepository, upsertRepository } from './database.js';
import type { ProviderPlugin, RepositoryInfo } from './plugins/interface.js';
import { getPluginRegistry } from './plugins/interface.js';
import { addRepoUrl } from './repos-file.js';
import type { DiscoveryFilterSettings } from './settings.js';
import { notifyNewRepositories } from './smtp.js';

export type DiscoveryProvider = 'github' | 'azureDevOps';

export interface DiscoveredRepo {
  repo: RepositoryInfo;
  plugin: ProviderPlugin;
}

export interface DiscoveryProviderResult {
  provider: DiscoveryProvider;
  total: number;
  newlyDiscovered: RepositoryInfo[];
  filteredOut: number;
  appendedToReposTxt: number;
  authenticated: boolean;
}

export interface DiscoveryResult {
  providers: DiscoveryProviderResult[];
  /** Flat list of repos that survived filtering — caller can reuse instead of re-listing. */
  repos: DiscoveredRepo[];
}

export interface RunDiscoveryOptions {
  /** Restrict to a subset of providers (defaults to every configured plugin). */
  providers?: DiscoveryProvider[];
  /** Force append-to-repos.txt regardless of per-provider setting. */
  appendToReposTxt?: boolean;
  /** Suppress the "new repos found" SMTP notification (useful for backup cycles). */
  notify?: boolean;
}

const PLUGIN_NAME_TO_SETTING: Record<string, DiscoveryProvider> = {
  github: 'github',
  azuredevops: 'azureDevOps',
};

function settingKeyFromPlugin(pluginName: string): DiscoveryProvider | undefined {
  return PLUGIN_NAME_TO_SETTING[pluginName];
}

function passesOwnerFilter(owner: string, filters: DiscoveryFilterSettings | undefined): boolean {
  if (!filters) return true;
  const lower = owner.toLowerCase();
  // For Azure DevOps owner is "<org>/<project>"; match either segment so
  // users can allow/deny by org or by project.
  const segments = lower.split('/').filter(Boolean);

  const allow = filters.ownerAllowList?.map((o) => o.trim().toLowerCase()).filter(Boolean) ?? [];
  if (allow.length > 0) {
    const matched = allow.some((a) => lower === a || segments.includes(a));
    if (!matched) return false;
  }

  const deny = filters.ownerDenyList?.map((o) => o.trim().toLowerCase()).filter(Boolean) ?? [];
  if (deny.length > 0) {
    const blocked = deny.some((d) => lower === d || segments.includes(d));
    if (blocked) return false;
  }

  return true;
}

function passesVisibilityFilter(
  isPrivate: boolean | undefined,
  filters: DiscoveryFilterSettings | undefined,
): boolean {
  const visibility = filters?.visibility ?? 'all';
  if (visibility === 'all') return true;
  // When a repo doesn't expose visibility we let it through to avoid
  // accidentally dropping every entry.
  if (isPrivate === undefined) return true;
  if (visibility === 'private') return isPrivate;
  return !isPrivate;
}

export function applyFilters(
  repos: RepositoryInfo[],
  filters: DiscoveryFilterSettings | undefined,
): { kept: RepositoryInfo[]; dropped: number } {
  if (!filters) return { kept: repos, dropped: 0 };
  const kept: RepositoryInfo[] = [];
  let dropped = 0;
  for (const repo of repos) {
    if (passesOwnerFilter(repo.owner, filters) && passesVisibilityFilter(repo.isPrivate, filters)) {
      kept.push(repo);
    } else {
      dropped++;
    }
  }
  return { kept, dropped };
}

export async function runDiscovery(opts: RunDiscoveryOptions = {}): Promise<DiscoveryResult> {
  const config = getConfig();
  const allPlugins = getPluginRegistry().getConfigured();

  const wanted = opts.providers;
  const plugins = wanted
    ? allPlugins.filter((p) => {
        const key = settingKeyFromPlugin(p.name);
        return key !== undefined && wanted.includes(key);
      })
    : allPlugins;

  const result: DiscoveryResult = { providers: [], repos: [] };

  for (const plugin of plugins) {
    const settingKey = settingKeyFromPlugin(plugin.name);
    const providerCfg = settingKey ? config[settingKey] : undefined;
    const filters = providerCfg?.filters;

    const providerResult: DiscoveryProviderResult = {
      provider: settingKey ?? (plugin.name as DiscoveryProvider),
      total: 0,
      newlyDiscovered: [],
      filteredOut: 0,
      appendedToReposTxt: 0,
      authenticated: false,
    };

    try {
      console.log(`[discovery] Authenticating with ${plugin.displayName}...`);
      const authOk = await plugin.authenticate();
      providerResult.authenticated = authOk;
      if (!authOk) {
        console.error(`[discovery] Authentication failed for ${plugin.displayName}`);
        result.providers.push(providerResult);
        continue;
      }

      console.log(`[discovery] Listing repositories from ${plugin.displayName}...`);
      const listed = await plugin.listRepositories();
      const { kept, dropped } = applyFilters(listed, filters);
      providerResult.total = kept.length;
      providerResult.filteredOut = dropped;

      const shouldAppend = opts.appendToReposTxt ?? providerCfg?.autoAppendToReposTxt ?? false;

      for (const repo of kept) {
        const isNew = isNewRepository(repo.url);
        upsertRepository({
          url: repo.url,
          provider: repo.provider,
          owner: repo.owner,
          name: repo.name,
        });
        result.repos.push({ plugin, repo });

        if (isNew) {
          providerResult.newlyDiscovered.push(repo);
          if (shouldAppend) {
            const { added } = addRepoUrl(repo.url);
            if (added) providerResult.appendedToReposTxt++;
          }
        }
      }

      console.log(
        `[discovery] ${plugin.displayName}: ${providerResult.total} repos (${providerResult.newlyDiscovered.length} new, ${providerResult.filteredOut} filtered out)`,
      );

      const notifyEnabled = opts.notify ?? true;
      const wantsNotify = providerCfg?.notifyOnNewRepo ?? true;
      if (notifyEnabled && wantsNotify && providerResult.newlyDiscovered.length > 0) {
        try {
          await notifyNewRepositories(
            plugin.displayName,
            providerResult.newlyDiscovered.map((r) => ({
              url: r.url,
              owner: r.owner,
              name: r.name,
            })),
          );
        } catch (err) {
          console.warn(
            `[discovery] Failed to send new-repo notification for ${plugin.displayName}:`,
            err,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[discovery] Error discovering from ${plugin.displayName}: ${message}`);
    }

    result.providers.push(providerResult);
  }

  return result;
}
