import type { APIRoute } from 'astro';
import { initDatabase, getBackupRuns } from '../../../lib/database.js';
import { getConfig, isBackupCapable } from '../../../lib/config.js';
import { inspectBackupLock, tryAcquireBackupLock } from '../../../lib/backup-lock.js';
import { registerAllPlugins } from '../../../lib/plugins/register.js';
import { runBackupCycle } from '../../../lib/scheduler.js';
import { logger } from '../../../lib/logger.js';

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
  // Find the currently running run, if any, so the UI can offer a
  // cancel action without needing a separate endpoint.
  let runningRunId: number | null = null;
  try {
    const latest = getBackupRuns(5).find((r) => r.status === 'running');
    if (latest) runningRunId = latest.id;
  } catch {
    runningRunId = null;
  }
  return new Response(
    JSON.stringify({
      running: Boolean(lock),
      lock,
      runningRunId,
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
  // Kick off in background; respond immediately so the UI can poll status.
  // Use the full cycle helper so UI-triggered runs produce the same
  // consolidated email report (successes, failures, PAT warnings, crash
  // reports) as scheduled runs.
  runBackupCycle()
    .catch((err) => logger.error('[trigger] runBackupCycle failed:', err))
    .finally(() => handle.release());
  return new Response(JSON.stringify({ ok: true, started: true }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};
