// GET /api/repos/:id/debug-logs → JSON list of captured git-trace files.
// GET /api/repos/:id/debug-logs?file=<name> → stream the log as text.
//
// Files live under `{dataDir}/debug-logs/repo-<id>/`. Only basenames of
// files that actually exist in that directory are returned/served, so
// user-supplied `file` cannot path-traverse.

import type { APIRoute } from 'astro';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getConfig } from '../../../../lib/config.js';
import { getRepositoryWithHistory } from '../../../../lib/database.js';

function parseId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function logsDirFor(repoId: number): string {
  return path.join(getConfig().dataDir, 'debug-logs', `repo-${repoId}`);
}

export const GET: APIRoute = async ({ params, url }) => {
  const id = parseId(params.id);
  if (id === undefined) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const exists = getRepositoryWithHistory(id);
  if (!exists) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const dir = logsDirFor(id);
  const requestedFile = url.searchParams.get('file');

  if (requestedFile) {
    // Guard against traversal — only accept a plain basename that
    // resolves to something inside the logs directory.
    const base = path.basename(requestedFile);
    if (!base.endsWith('.log') || base !== requestedFile) {
      return new Response(JSON.stringify({ error: 'Invalid file name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const full = path.join(dir, base);
    try {
      const s = await stat(full);
      if (!s.isFile()) throw new Error('not a file');
      const stream = Readable.toWeb(createReadStream(full)) as ReadableStream;
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(s.size),
          'Content-Disposition': `attachment; filename="${base}"`,
        },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Log not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // List mode
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }

  const files = await Promise.all(
    entries
      .filter((f) => f.endsWith('.log'))
      .map(async (f) => {
        try {
          const s = await stat(path.join(dir, f));
          return { name: f, size: s.size, mtime: s.mtime.toISOString() };
        } catch {
          return null;
        }
      }),
  );

  const list = files
    .filter((x): x is { name: string; size: number; mtime: string } => x !== null)
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

  return new Response(JSON.stringify({ files: list }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
