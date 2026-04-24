import type { APIRoute } from 'astro';
import { getConfig } from '../../../../lib/config.js';
import {
  initDatabase,
  getBackupRuns,
  isRunCancellationRequested,
  requestRunCancellation,
} from '../../../../lib/database.js';
import { logger } from '../../../../lib/logger.js';

function ensureInit() {
  const cfg = getConfig();
  initDatabase(cfg.dataDir);
}

/**
 * Request graceful cancellation of a backup run. The engine polls the
 * flag between repositories and stops the loop once the currently running
 * repo has finished — no in-flight archives or clones are interrupted,
 * so no half-written files are ever left on disk.
 *
 * Returns:
 *   202 — cancellation requested (or already pending; idempotent)
 *   404 — run not found
 *   409 — run is not in `running` state (already finished, cancelled, …)
 */
export const POST: APIRoute = async ({ params }) => {
  ensureInit();
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid run id.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Look up the run so we can distinguish "not found" from "not running".
  const run = getBackupRuns(1000).find((r) => r.id === id);
  if (!run) {
    return new Response(JSON.stringify({ ok: false, error: 'Run not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (run.status !== 'running') {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Run #${id} is not running (status: ${run.status}).`,
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Idempotent — if cancellation was already requested, just return 202.
  if (isRunCancellationRequested(id)) {
    return new Response(
      JSON.stringify({ ok: true, id, alreadyRequested: true }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const updated = requestRunCancellation(id);
  if (!updated) {
    // Race: status flipped away from `running` between the read and the
    // write. Report 409 so the client can refresh.
    return new Response(
      JSON.stringify({ ok: false, error: `Run #${id} is no longer running.` }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  logger.info(`[runs] Cancellation requested for run #${id}`);
  return new Response(JSON.stringify({ ok: true, id }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};
