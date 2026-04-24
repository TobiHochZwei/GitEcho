import type { APIRoute } from 'astro';
import { getConfig } from '../../../lib/config.js';

function normalizeHost(input: string | undefined): string {
  if (!input) return 'gitlab.com';
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase() || 'gitlab.com';
}

export const POST: APIRoute = async ({ request }) => {
  let body: { pat?: string; host?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // ignore — fall back to stored token
  }

  const cfg = getConfig().gitlab;
  const token = body.pat || cfg?.pat;
  const host = normalizeHost(body.host || cfg?.host);

  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'No GitLab PAT available (provide one or save it first).' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Use GitLab's REST API directly — a single HTTP call is more portable than
  // shelling out to `glab` and yields a friendlier error message on failure.
  const url = `https://${host}/api/v4/user`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return new Response(
      JSON.stringify({ ok: false, error: `GitLab API ${res.status}: ${text.slice(0, 300)}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const user = (await res.json().catch(() => ({}))) as { username?: string; name?: string };
  const who = user.username || user.name || 'unknown user';
  return new Response(
    JSON.stringify({ ok: true, message: `Authenticated on ${host} as ${who}.` }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
