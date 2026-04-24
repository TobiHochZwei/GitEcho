// Web UI authentication middleware.
//
// - Enforces that MASTER_KEY is configured (aborts the request with a clear
//   message otherwise — pairs with the entrypoint hard-fail).
// - Bootstraps default admin/admin credentials on first boot.
// - Validates the signed `gitecho_sid` session cookie, redirecting HTML
//   requests to /login and returning 401 for API requests.
// - Applies CSRF defence on non-GET/HEAD requests via Origin-header check.
// - Forces users through /settings/account when mustChangePassword is set.
// - Adds a small set of hardening headers to every response.

import { defineMiddleware } from 'astro:middleware';
import { logger } from './lib/logger.js';
import { loadConfig } from './lib/config.js';
import { initDatabase } from './lib/database.js';
import { isMasterKeyConfigured } from './lib/secrets.js';
import {
  destroySessionByCookie,
  ensureCredentialsBootstrapped,
  mustChangePassword,
  touchSession,
} from './lib/auth.js';

let dbInitialized = false;
let credentialsBootstrapped = false;

function ensureDatabaseInitialized(): void {
  if (dbInitialized) return;
  try {
    const cfg = loadConfig();
    initDatabase(cfg.dataDir);
    dbInitialized = true;
  } catch (e) {
    logger.error(`[middleware] Failed to initialize database: ${(e as Error).message}`);
  }
}

function bootstrapCredentialsOnce(): void {
  if (credentialsBootstrapped) return;
  try {
    ensureCredentialsBootstrapped();
    credentialsBootstrapped = true;
  } catch (e) {
    logger.error(`[middleware] Failed to bootstrap credentials: ${(e as Error).message}`);
  }
}

/**
 * Parse PUBLIC_URL into a normalized origin allow-list. A literal `*` token
 * (anywhere in the comma-separated list) flips the wildcard flag, which
 * tells the CSRF origin check to accept any Origin header.
 */
function allowedOrigins(): { wildcard: boolean; hosts: Set<string> } {
  const raw = process.env.PUBLIC_URL ?? '';
  const hosts = new Set<string>();
  let wildcard = false;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      wildcard = true;
      continue;
    }
    try {
      const u = new URL(trimmed);
      hosts.add(`${u.protocol}//${u.host}`);
    } catch {
      // ignore invalid entries silently; README documents the format
    }
  }
  return { wildcard, hosts };
}

function isOriginAllowed(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true; // no Origin header (e.g. curl, some proxies on same-origin POST)
  const configured = allowedOrigins();
  if (configured.wildcard) return true; // operator opted out of the CSRF origin check
  try {
    const o = new URL(origin);
    const normalized = `${o.protocol}//${o.host}`;
    const req = new URL(requestUrl);
    const reqOrigin = `${req.protocol}//${req.host}`;
    if (normalized === reqOrigin) return true;
    if (configured.hosts.has(normalized)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Paths that are reachable without an authenticated session. */
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
]);

/**
 * Prefixes for resources the server serves without auth (static assets emitted
 * by Astro). Keeps /login usable before the browser has a session cookie.
 */
const PUBLIC_PREFIXES = ['/_astro/', '/favicon'];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Paths that remain reachable even while mustChangePassword is true — they
 * let the user complete the password change without getting redirected to
 * themselves. Everything else redirects to /settings/account.
 */
const FORCE_CHANGE_ALLOWLIST = new Set<string>([
  '/settings/account',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

function addSecurityHeaders(response: Response, secure: boolean): Response {
  const h = response.headers;
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (secure && !h.has('Strict-Transport-Security')) {
    h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

function requestIsSecure(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch {
    /* ignore */
  }
  const xfp = request.headers.get('x-forwarded-proto');
  if (xfp && xfp.split(',')[0].trim().toLowerCase() === 'https') return true;
  return false;
}

function htmlWantsRedirect(request: Request, pathname: string): boolean {
  if (pathname.startsWith('/api/')) return false;
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html') || request.method === 'GET';
}

function redirectToLogin(pathname: string, search: string): Response {
  const location = `/login?redirect=${encodeURIComponent(pathname + search)}`;
  return new Response(null, { status: 302, headers: { Location: location } });
}

function unauthorizedJson(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'Not authenticated.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function masterKeyMissingResponse(pathname: string): Response {
  const msg =
    'MASTER_KEY environment variable is required. ' +
    'Generate one with `openssl rand -hex 32` and restart the container.';
  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>GitEcho — misconfigured</title>` +
      `<style>body{font:16px/1.5 system-ui;padding:3rem;max-width:44rem;margin:auto;background:#111;color:#eee}` +
      `code{background:#222;padding:.1rem .4rem;border-radius:.25rem}h1{color:#f66}</style>` +
      `<h1>GitEcho cannot start</h1><p>${msg}</p>`,
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname;
  const secure = requestIsSecure(context.request);

  // Hard fail if the vault key is not configured. Without it we cannot store
  // the password hash or provider PATs, so the entire UI is non-functional.
  if (!isMasterKeyConfigured()) {
    return addSecurityHeaders(masterKeyMissingResponse(pathname), secure);
  }

  ensureDatabaseInitialized();
  bootstrapCredentialsOnce();

  // CSRF: reject cross-site writes before touching the session.
  const method = context.request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = context.request.headers.get('origin');
    if (!isOriginAllowed(origin, context.request.url)) {
      logger.warn(
        `[auth] Rejected ${method} ${pathname} — origin ${origin ?? 'none'} not allowed. ` +
          'Set PUBLIC_URL to the URL(s) your browser uses.',
      );
      return addSecurityHeaders(
        new Response('Cross-site requests are not allowed', { status: 403 }),
        secure,
      );
    }
  }

  // Public routes (login page + login/logout APIs + static assets) don't
  // require an authenticated session.
  if (isPublicPath(pathname)) {
    const res = await next();
    return addSecurityHeaders(res, secure);
  }

  // Validate the session cookie.
  const cookieHeader = context.request.headers.get('cookie');
  const session = touchSession(cookieHeader);
  if (!session) {
    // Defensively clear any stale/invalid cookie the browser sent.
    destroySessionByCookie(cookieHeader);
    if (htmlWantsRedirect(context.request, pathname)) {
      return addSecurityHeaders(redirectToLogin(pathname, url.search), secure);
    }
    return addSecurityHeaders(unauthorizedJson(), secure);
  }

  // Force the default-password user through the change flow.
  if (mustChangePassword() && !FORCE_CHANGE_ALLOWLIST.has(pathname)) {
    if (pathname.startsWith('/api/')) {
      return addSecurityHeaders(
        new Response(
          JSON.stringify({ ok: false, error: 'Password change required.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
        secure,
      );
    }
    return addSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: { Location: '/settings/account?forceChange=1' },
      }),
      secure,
    );
  }

  context.locals.user = { username: session.username };
  const res = await next();
  return addSecurityHeaders(res, secure);
});
