// Bulk repository delete endpoint.
//
// POST { ids: number[] } → permanently delete each repository (files + DB row
// + provider blacklist), mirroring the single-repo DELETE in [id].ts but
// without the per-repo name confirmation (the UI confirms the whole batch).
//
// Returns a per-id summary. If a backup starts mid-batch, the cascade throws
// BackupBusyError and the request aborts with 409 (already-deleted repos are
// reported in `deleted`).

import type { APIRoute } from 'astro';
import { getRepository } from '../../../lib/database.js';
import { BackupBusyError } from '../../../lib/archive.js';
import { deleteRepositoryCascade } from '../../../lib/repo-delete.js';
import { inspectBackupLock } from '../../../lib/backup-lock.js';
import { loadConfig } from '../../../lib/config.js';

interface BulkDeleteBody {
  ids?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  let body: BulkDeleteBody = {};
  try {
    const text = await request.text();
    if (text.length > 0) body = JSON.parse(text) as BulkDeleteBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(body.ids)) {
    return new Response(JSON.stringify({ error: 'ids must be an array of repository ids' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate + de-duplicate ids (positive integers only).
  const ids = [
    ...new Set(
      body.ids.filter(
        (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
      ),
    ),
  ];

  if (ids.length === 0) {
    return new Response(JSON.stringify({ error: 'No valid repository ids provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Up-front busy check for nicer UX. The per-item BackupBusyError thrown by
  // deleteRepositoryFiles remains the authoritative race guard.
  if (inspectBackupLock()) {
    return new Response(
      JSON.stringify({ error: 'A backup is currently running. Try again once it finishes.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const cfg = loadConfig();
  const deleted: number[] = [];
  const notFound: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];

  for (const id of ids) {
    const repo = getRepository(id);
    if (!repo) {
      notFound.push(id);
      continue;
    }
    try {
      deleteRepositoryCascade(repo, cfg);
      deleted.push(id);
    } catch (err) {
      if (err instanceof BackupBusyError) {
        return new Response(
          JSON.stringify({ error: err.message, deleted, notFound, failed }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      failed.push({ id, error: (err as Error).message });
    }
  }

  return new Response(
    JSON.stringify({ ok: failed.length === 0, deleted, notFound, failed }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
