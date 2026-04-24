// Per-repository read + update endpoint.
//
// GET   → repository row + recent backup history.
// PATCH → accepts { notes?: string | null, skipBackup?: boolean } and
//         persists what's provided. Notes are capped at 4000 characters.

import type { APIRoute } from 'astro';
import {
  getRepositoryWithHistory,
  REPOSITORY_NOTES_MAX_LENGTH,
  setRepositorySkipBackup,
  updateRepositoryNotes,
} from '../../../lib/database.js';

interface PatchBody {
  notes?: string | null;
  skipBackup?: boolean;
}

function parseId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const GET: APIRoute = async ({ params }) => {
  const id = parseId(params.id);
  if (id === undefined) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const result = getRepositoryWithHistory(id);
  if (!result) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (id === undefined) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') {
      return new Response(JSON.stringify({ error: 'notes must be a string or null' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (typeof body.notes === 'string' && body.notes.length > REPOSITORY_NOTES_MAX_LENGTH) {
      return new Response(
        JSON.stringify({
          error: `notes exceeds ${REPOSITORY_NOTES_MAX_LENGTH} characters`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    updateRepositoryNotes(id, body.notes);
  }

  if (body.skipBackup !== undefined) {
    if (typeof body.skipBackup !== 'boolean') {
      return new Response(JSON.stringify({ error: 'skipBackup must be a boolean' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    setRepositorySkipBackup(id, body.skipBackup);
  }

  const result = getRepositoryWithHistory(id);
  if (!result) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
};
