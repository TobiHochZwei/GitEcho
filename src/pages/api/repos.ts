import type { APIRoute } from 'astro';
import { addRepoUrl, classifyUrl, listRepoUrls, removeRepoUrl } from '../../lib/repos-file.js';
import { addExcludedUrl, removeExcludedUrl } from '../../lib/settings.js';

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
  let exclude = url.searchParams.get('exclude') === '1';
  if (!target) {
    try {
      const body = (await request.json()) as { url?: string; exclude?: boolean };
      target = body?.url;
      if (body?.exclude) exclude = true;
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
  let excluded = false;
  if (exclude) {
    const kind = classifyUrl(target);
    if (kind === 'github') {
      addExcludedUrl('github', target);
      excluded = true;
    } else if (kind === 'azuredevops') {
      addExcludedUrl('azureDevOps', target);
      excluded = true;
    }
  }
  return new Response(JSON.stringify({ ok: true, excluded }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

/** Remove a URL from the provider discovery blacklist. */
export const PATCH: APIRoute = async ({ request }) => {
  let body: { url?: string; unexclude?: boolean };
  try {
    body = (await request.json()) as { url?: string; unexclude?: boolean };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!body.url || !body.unexclude) {
    return new Response(JSON.stringify({ error: 'url and unexclude=true are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const kind = classifyUrl(body.url);
  if (!kind) {
    return new Response(JSON.stringify({ error: 'Unknown provider for URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const removed =
    kind === 'github'
      ? removeExcludedUrl('github', body.url)
      : removeExcludedUrl('azureDevOps', body.url);
  return new Response(JSON.stringify({ ok: true, removed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
