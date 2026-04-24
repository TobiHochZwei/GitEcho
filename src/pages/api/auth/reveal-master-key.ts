import type { APIRoute } from 'astro';
import { getUsername, touchSession, verifyCredentials } from '../../../lib/auth.js';
import { logger } from '../../../lib/logger.js';

/**
 * Reveal the MASTER_KEY to an already-authenticated user after they re-enter
 * their password. This is useful for backup / disaster-recovery so the admin
 * can copy the key without shell access to the container.
 *
 * Security:
 *  - Requires an active session cookie.
 *  - Requires the current account password to be supplied again.
 *  - The reveal action is written to the application log (without the key
 *    value itself; the logger also redacts MASTER_KEY automatically).
 */
export const POST: APIRoute = async ({ request }) => {
  const session = touchSession(request.headers.get('cookie'));
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let password = '';
  try {
    const body = (await request.json()) as { password?: string };
    password = body.password ?? '';
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!password) {
    return new Response(JSON.stringify({ ok: false, error: 'Password is required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ok = await verifyCredentials(getUsername(), password);
  if (!ok) {
    logger.warn(`[auth] Master-key reveal denied for user "${session.username}" — bad password.`);
    return new Response(JSON.stringify({ ok: false, error: 'Password is incorrect.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const masterKey = process.env.MASTER_KEY ?? '';
  if (!masterKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'MASTER_KEY is not configured on this instance.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  logger.info(`[auth] Master-key revealed to user "${session.username}".`);

  return new Response(JSON.stringify({ ok: true, masterKey }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
