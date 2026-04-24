// POST /api/repos/:id/archive
// Packs the repo's backup directory into a single ZIP under
// `{backupsDir}/_archived/...`, removes the original directory, and
// flips the repository's `archived` flag. Requires a JSON body with
// `confirmName` matching the repository's name.

import type { APIRoute } from 'astro';
import {
  archiveRepository,
  getRepository,
} from '../../../../lib/database.js';
import {
  archiveRepositoryFiles,
  BackupBusyError,
} from '../../../../lib/archive.js';
import { loadConfig } from '../../../../lib/config.js';
import { logger } from '../../../../lib/logger.js';

interface ArchiveBody {
  confirmName?: unknown;
}

function parseId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const POST: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === undefined) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: ArchiveBody = {};
  try {
    const text = await request.text();
    if (text.length > 0) body = JSON.parse(text) as ArchiveBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
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

  if (repo.archived === 1) {
    return new Response(
      JSON.stringify({ error: 'Repository is already archived' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (typeof body.confirmName !== 'string' || body.confirmName !== repo.name) {
    return new Response(
      JSON.stringify({ error: 'confirmName must match the repository name exactly' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const cfg = loadConfig();
  let relativeArchivePath: string;
  try {
    relativeArchivePath = await archiveRepositoryFiles(repo, cfg.backupsDir);
  } catch (err) {
    if (err instanceof BackupBusyError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    logger.error(`[repo-archive] Failed to archive #${id}: ${(err as Error).message}`);
    return new Response(
      JSON.stringify({ error: `Archive failed: ${(err as Error).message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  archiveRepository(id, relativeArchivePath);

  logger.info(
    `[repo-archive] Archived repository #${id} ${repo.provider}/${repo.owner}/${repo.name} → ${relativeArchivePath}`,
  );

  return new Response(
    JSON.stringify({ ok: true, archivePath: relativeArchivePath }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
