// POST /api/repos/:id/unarchive
// Clears the archived flag so the repo is picked up by discovery and the
// backup engine again. Also deletes the archive ZIP (it would otherwise
// linger without a UI to clean it up) and removes the URL from the
// provider exclusion blacklist.
//
// Historical backup data is NOT restored — the next backup cycle starts
// from a fresh clone/snapshot. This is called out in the UI confirmation.

import type { APIRoute } from 'astro';
import {
  getRepository,
  unarchiveRepository,
} from '../../../../lib/database.js';
import {
  BackupBusyError,
  deleteArchiveZip,
  providerToSettingsKey,
} from '../../../../lib/archive.js';
import { loadConfig } from '../../../../lib/config.js';
import { removeExcludedUrl } from '../../../../lib/settings.js';
import { logger } from '../../../../lib/logger.js';

function parseId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const POST: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === undefined) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const repo = getRepository(id);
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (repo.archived !== 1) {
    return new Response(
      JSON.stringify({ error: 'Repository is not archived' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const cfg = loadConfig();
  try {
    deleteArchiveZip(repo, cfg.backupsDir, repo.archive_path);
  } catch (err) {
    if (err instanceof BackupBusyError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw err;
  }

  unarchiveRepository(id);

  const settingsKey = providerToSettingsKey(repo.provider);
  let unblacklisted = false;
  if (settingsKey) {
    try {
      unblacklisted = removeExcludedUrl(settingsKey, repo.url);
    } catch (e) {
      logger.warn(`[repo-unarchive] Failed to unblacklist ${repo.url}: ${(e as Error).message}`);
    }
  }

  logger.info(
    `[repo-unarchive] Reactivated repository #${id} ${repo.provider}/${repo.owner}/${repo.name}` +
      (unblacklisted ? ' — removed from provider blacklist' : ''),
  );

  return new Response(
    JSON.stringify({ ok: true, unblacklisted }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
