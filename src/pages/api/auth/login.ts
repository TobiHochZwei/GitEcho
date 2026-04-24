import type { APIRoute } from 'astro';
import {
  buildSessionCookie,
  createSession,
  getUsername,
  mustChangePassword,
  requestIsSecure,
  verifyCredentials,
} from '../../../lib/auth.js';
import { logger } from '../../../lib/logger.js';

// Very small sliding-window rate limiter keyed by client IP. Restricts brute
// force on the login endpoint without introducing a Redis dep. The window
// state lives in module scope and resets on container restart — acceptable
// trade-off for a single-instance self-hosted tool.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function isThrottled(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => t > now - ATTEMPT_WINDOW_MS);
  attempts.set(ip, list);
  return list.length >= MAX_ATTEMPTS;
}

function recordAttempt(ip: string): void {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => t > now - ATTEMPT_WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
}

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  if (isThrottled(ip)) {
    logger.warn(`[auth] Login throttled for ${ip} — too many failed attempts.`);
    return new Response(JSON.stringify({ ok: false, error: 'Too many attempts. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '900' },
    });
  }

  let username = '';
  let password = '';
  const ctype = request.headers.get('content-type') ?? '';
  try {
    if (ctype.includes('application/json')) {
      const body = (await request.json()) as { username?: string; password?: string };
      username = (body.username ?? '').trim();
      password = body.password ?? '';
    } else {
      const form = await request.formData();
      username = String(form.get('username') ?? '').trim();
      password = String(form.get('password') ?? '');
    }
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!username || !password) {
    recordAttempt(ip);
    return new Response(JSON.stringify({ ok: false, error: 'Username and password required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ok = await verifyCredentials(username, password);
  if (!ok) {
    recordAttempt(ip);
    logger.warn(`[auth] Failed login for "${username}" from ${ip}.`);
    return new Response(JSON.stringify({ ok: false, error: 'Invalid credentials.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sid = createSession(getUsername());
  const cookie = buildSessionCookie(sid, requestIsSecure(request));
  logger.info(`[auth] Sign-in OK for "${username}" from ${ip}.`);
  return new Response(
    JSON.stringify({ ok: true, mustChangePassword: mustChangePassword() }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie,
      },
    },
  );
};
