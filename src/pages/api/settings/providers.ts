import type { APIRoute } from 'astro';
import { isMasterKeyConfigured } from '../../../lib/secrets.js';
import { patchSettings, writeSecret } from '../../../lib/settings.js';
import type { DiscoveryFilterSettings } from '../../../lib/settings.js';
import { runDiscovery } from '../../../lib/discovery.js';
import type { DiscoveryProvider } from '../../../lib/discovery.js';
import { logger } from '../../../lib/logger.js';

interface ProviderInputCommon {
  pat?: string;
  patExpires?: string;
  autoDiscover?: boolean;
  autoCleanupReposTxt?: boolean;
  notifyOnNewRepo?: boolean;
  filters?: DiscoveryFilterSettings;
  clear?: boolean;
}

interface ProvidersInput {
  github?: ProviderInputCommon;
  azureDevOps?: ProviderInputCommon & { org?: string };
}

function sanitizeFilters(input: unknown): DiscoveryFilterSettings | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const f = input as Record<string, unknown>;
  const out: DiscoveryFilterSettings = {};

  const toList = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof v === 'string')
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return undefined;
  };

  const allow = toList(f.ownerAllowList);
  if (allow !== undefined) out.ownerAllowList = allow;
  const deny = toList(f.ownerDenyList);
  if (deny !== undefined) out.ownerDenyList = deny;
  if (f.visibility === 'public' || f.visibility === 'private' || f.visibility === 'all') {
    out.visibility = f.visibility;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const PUT: APIRoute = async ({ request }) => {
  let body: ProvidersInput;
  try {
    body = (await request.json()) as ProvidersInput;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const settingsPatch: {
    github?: {
      patExpires?: string;
      autoDiscover?: boolean;
      autoCleanupReposTxt?: boolean;
      notifyOnNewRepo?: boolean;
      filters?: DiscoveryFilterSettings;
    };
    azureDevOps?: {
      patExpires?: string;
      autoDiscover?: boolean;
      org?: string;
      autoCleanupReposTxt?: boolean;
      notifyOnNewRepo?: boolean;
      filters?: DiscoveryFilterSettings;
    };
  } = {};

  const providersToDiscover: DiscoveryProvider[] = [];

  if (body.github) {
    settingsPatch.github = {};
    if (body.github.patExpires !== undefined)
      settingsPatch.github.patExpires = body.github.patExpires || undefined;
    if (body.github.autoDiscover !== undefined)
      settingsPatch.github.autoDiscover = Boolean(body.github.autoDiscover);
    if (body.github.autoCleanupReposTxt !== undefined)
      settingsPatch.github.autoCleanupReposTxt = Boolean(body.github.autoCleanupReposTxt);
    if (body.github.notifyOnNewRepo !== undefined)
      settingsPatch.github.notifyOnNewRepo = Boolean(body.github.notifyOnNewRepo);
    if (body.github.filters !== undefined)
      settingsPatch.github.filters = sanitizeFilters(body.github.filters);

    if (body.github.clear) {
      writeSecret('github.pat', undefined);
    } else if (body.github.pat) {
      if (!isMasterKeyConfigured()) {
        return new Response(
          JSON.stringify({ error: 'MASTER_KEY environment variable is required to save secrets.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      writeSecret('github.pat', body.github.pat);
    }
    providersToDiscover.push('github');
  }

  if (body.azureDevOps) {
    settingsPatch.azureDevOps = {};
    if (body.azureDevOps.patExpires !== undefined)
      settingsPatch.azureDevOps.patExpires = body.azureDevOps.patExpires || undefined;
    if (body.azureDevOps.org !== undefined)
      settingsPatch.azureDevOps.org = body.azureDevOps.org || undefined;
    if (body.azureDevOps.autoDiscover !== undefined)
      settingsPatch.azureDevOps.autoDiscover = Boolean(body.azureDevOps.autoDiscover);
    if (body.azureDevOps.autoCleanupReposTxt !== undefined)
      settingsPatch.azureDevOps.autoCleanupReposTxt = Boolean(
        body.azureDevOps.autoCleanupReposTxt,
      );
    if (body.azureDevOps.notifyOnNewRepo !== undefined)
      settingsPatch.azureDevOps.notifyOnNewRepo = Boolean(body.azureDevOps.notifyOnNewRepo);
    if (body.azureDevOps.filters !== undefined)
      settingsPatch.azureDevOps.filters = sanitizeFilters(body.azureDevOps.filters);

    if (body.azureDevOps.clear) {
      writeSecret('azureDevOps.pat', undefined);
    } else if (body.azureDevOps.pat) {
      if (!isMasterKeyConfigured()) {
        return new Response(
          JSON.stringify({ error: 'MASTER_KEY environment variable is required to save secrets.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      writeSecret('azureDevOps.pat', body.azureDevOps.pat);
    }
    providersToDiscover.push('azureDevOps');
  }

  patchSettings(settingsPatch);

  // Fire-and-forget background discovery so the UI can show updated repos
  // without blocking the HTTP response. Errors are logged inside runDiscovery.
  let discoveryStarted = false;
  if (providersToDiscover.length > 0) {
    discoveryStarted = true;
    setImmediate(() => {
      runDiscovery({ providers: providersToDiscover }).catch((err) => {
        logger.error('[providers] Background discovery failed:', err);
      });
    });
  }

  return new Response(JSON.stringify({ ok: true, discoveryStarted }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
