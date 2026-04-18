import type { APIRoute } from 'astro';
import { addRepoUrl, listRepoUrls, removeRepoUrl } from '../../lib/repos-file.js';

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ repos: listRepoUrls() }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.url || typeof body.url !== 'string') {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const result = addRepoUrl(body.url);
  if (!result.added) {
    return new Response(JSON.stringify({ error: result.reason }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request, url }) => {
  let target = url.searchParams.get('url') ?? undefined;
  if (!target) {
    try {
      const body = (await request.json()) as { url?: string };
      target = body?.url;
    } catch {
      // ignore
    }
  }
  if (!target) {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const removed = removeRepoUrl(target);
  if (!removed) {
    return new Response(JSON.stringify({ error: 'URL not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
