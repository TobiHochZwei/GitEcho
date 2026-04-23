import type { APIRoute } from 'astro';
import { getConfig } from '../../../lib/config.js';
import { initDatabase, deleteBackupRun } from '../../../lib/database.js';
import { inspectBackupLock } from '../../../lib/backup-lock.js';
import { logger } from '../../../lib/logger.js';

function ensureInit() {
  const cfg = getConfig();
  initDatabase(cfg.dataDir);
}

export const DELETE: APIRoute = async ({ params, url }) => {
  ensureInit();
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid run id.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Safety: if a backup is actively running, refuse to delete runs unless the
  // caller explicitly opts in with ?force=1. This prevents accidentally nuking
  // the row that the live run is writing to.
  const lock = inspectBackupLock();
  const force = url.searchParams.get('force') === '1';
  if (lock && !force) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'A backup is currently running. Retry once it finishes, or pass ?force=1.',
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const removed = deleteBackupRun(id);
    if (!removed) {
      return new Response(JSON.stringify({ ok: false, error: 'Run not found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    logger.info(`[runs] Deleted backup run #${id}`);
    return new Response(JSON.stringify({ ok: true, id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    logger.error('[runs] Failed to delete run:', err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
