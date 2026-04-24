// Trigger a backup run for a single repository.
//
// Mirrors /api/backup/trigger but scoped to one repo id. Shares the
// global backup lock so single-repo runs and full cycles can never
// overlap.

import type { APIRoute } from 'astro';
import { getRepository, initDatabase } from '../../../../lib/database.js';
import { getConfig, isBackupCapable } from '../../../../lib/config.js';
import { tryAcquireBackupLock } from '../../../../lib/backup-lock.js';
import { registerAllPlugins } from '../../../../lib/plugins/register.js';
import { runBackup } from '../../../../lib/backup/engine.js';
import { logger } from '../../../../lib/logger.js';

let pluginsRegistered = false;

function ensureInit() {
  const cfg = getConfig();
  initDatabase(cfg.dataDir);
  if (!pluginsRegistered) {
    registerAllPlugins();
    pluginsRegistered = true;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ params }) => {
  ensureInit();

  const rawId = params.id;
  const id = rawId ? Number.parseInt(rawId, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return json({ ok: false, error: `Invalid repository id: ${rawId}` }, 400);
  }

  const repo = getRepository(id);
  if (!repo) {
    return json({ ok: false, error: `Repository #${id} not found` }, 404);
  }
  if (repo.archived === 1) {
    return json({ ok: false, error: 'Repository is archived — cannot back up.' }, 400);
  }
  if (repo.skip_backup === 1) {
    return json(
      {
        ok: false,
        error: 'Repository is excluded from backups. Disable the skip toggle first.',
      },
      400,
    );
  }

  if (!isBackupCapable()) {
    return json(
      { ok: false, error: 'No provider configured. Add a PAT in Settings → Providers.' },
      400,
    );
  }

  const handle = tryAcquireBackupLock();
  if (!handle) {
    return json({ ok: false, error: 'A backup is already running.' }, 409);
  }

  // Fire-and-forget; respond immediately so the UI can poll status via
  // GET /api/backup/trigger (shared lock).
  runBackup({ repositoryId: id })
    .catch((err) => logger.error(`[trigger] runBackup(repo #${id}) failed:`, err))
    .finally(() => handle.release());

  return json({ ok: true, started: true, repositoryId: id }, 202);
};
