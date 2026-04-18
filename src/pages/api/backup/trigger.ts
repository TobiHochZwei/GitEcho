import type { APIRoute } from 'astro';
import { initDatabase } from '../../../lib/database.js';
import { getConfig, isBackupCapable } from '../../../lib/config.js';
import { inspectBackupLock, tryAcquireBackupLock } from '../../../lib/backup-lock.js';
import { registerAllPlugins } from '../../../lib/plugins/register.js';
import { runBackup } from '../../../lib/backup/engine.js';

let pluginsRegistered = false;

function ensureInit() {
  const cfg = getConfig();
  initDatabase(cfg.dataDir);
  if (!pluginsRegistered) {
    registerAllPlugins();
    pluginsRegistered = true;
  }
}

export const GET: APIRoute = async () => {
  ensureInit();
  const lock = inspectBackupLock();
  return new Response(
    JSON.stringify({
      running: Boolean(lock),
      lock,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};

export const POST: APIRoute = async () => {
  ensureInit();
  if (!isBackupCapable()) {
    return new Response(
      JSON.stringify({ ok: false, error: 'No provider configured. Add a PAT in Settings → Providers.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const handle = tryAcquireBackupLock();
  if (!handle) {
    return new Response(JSON.stringify({ ok: false, error: 'A backup is already running.' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Kick off in background; respond immediately so the UI can poll status
  runBackup()
    .catch((err) => console.error('[trigger] runBackup failed:', err))
    .finally(() => handle.release());
  return new Response(JSON.stringify({ ok: true, started: true }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};
