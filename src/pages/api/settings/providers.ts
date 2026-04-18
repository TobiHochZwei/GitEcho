import type { APIRoute } from 'astro';
import { isMasterKeyConfigured } from '../../../lib/secrets.js';
import { patchSettings, writeSecret } from '../../../lib/settings.js';

interface ProvidersInput {
  github?: {
    pat?: string; // empty string means "unchanged"
    patExpires?: string;
    autoDiscover?: boolean;
    clear?: boolean; // true => remove PAT entirely
  };
  azureDevOps?: {
    pat?: string;
    patExpires?: string;
    org?: string;
    clear?: boolean;
  };
}

export const PUT: APIRoute = async ({ request }) => {
  let body: ProvidersInput;
  try {
    body = (await request.json()) as ProvidersInput;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const settingsPatch: {
    github?: { patExpires?: string; autoDiscover?: boolean };
    azureDevOps?: { patExpires?: string; org?: string };
  } = {};

  if (body.github) {
    settingsPatch.github = {};
    if (body.github.patExpires !== undefined) settingsPatch.github.patExpires = body.github.patExpires || undefined;
    if (body.github.autoDiscover !== undefined) settingsPatch.github.autoDiscover = Boolean(body.github.autoDiscover);

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
  }

  if (body.azureDevOps) {
    settingsPatch.azureDevOps = {};
    if (body.azureDevOps.patExpires !== undefined) settingsPatch.azureDevOps.patExpires = body.azureDevOps.patExpires || undefined;
    if (body.azureDevOps.org !== undefined) settingsPatch.azureDevOps.org = body.azureDevOps.org || undefined;

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
  }

  patchSettings(settingsPatch);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
