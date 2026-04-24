// HTTP Basic Auth middleware for the Astro web UI.
// When UI_USER and UI_PASS are both set, every request must present matching
// credentials. When unset, the UI is open and a warning is logged on the
// first request so the operator notices.

import { defineMiddleware } from 'astro:middleware';
import { timingSafeEqual } from 'node:crypto';
import { logger } from './lib/logger.js';
import { loadConfig } from './lib/config.js';
import { initDatabase } from './lib/database.js';

let warnedOpen = false;
let dbInitialized = false;

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

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function unauthorizedResponse(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="GitEcho", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/** Parse PUBLIC_URL into a set of normalized allowed origins. */
function allowedOrigins(): Set<string> {
  const raw = process.env.PUBLIC_URL ?? '';
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      out.add(`${u.protocol}//${u.host}`);
    } catch {
      // ignore invalid entries silently; README documents the format
    }
  }
  return out;
}

function isOriginAllowed(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true; // no Origin header (e.g. curl, older browser on GET-like POST)
  try {
    const o = new URL(origin);
    const normalized = `${o.protocol}//${o.host}`;
    const req = new URL(requestUrl);
    const reqOrigin = `${req.protocol}//${req.host}`;
    if (normalized === reqOrigin) return true;
    const configured = allowedOrigins();
    if (configured.has(normalized)) return true;
    return false;
  } catch {
    return false;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  ensureDatabaseInitialized();

  const expectedUser = process.env.UI_USER;
  const expectedPass = process.env.UI_PASS;

  if (!expectedUser || !expectedPass) {
    if (!warnedOpen) {
      warnedOpen = true;
      logger.warn(
        '[auth] UI_USER / UI_PASS are not set — the GitEcho web UI is unauthenticated. ' +
          'Anyone with network access can view repos and (if MASTER_KEY is set) read settings.',
      );
    }
    return next();
  }

  const header = context.request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return unauthorizedResponse();
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf-8');
  } catch {
    return unauthorizedResponse();
  }

  const colon = decoded.indexOf(':');
  if (colon < 0) return unauthorizedResponse();

  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  const userOk = constantTimeEqual(user, expectedUser);
  const passOk = constantTimeEqual(pass, expectedPass);
  if (!userOk || !passOk) {
    return unauthorizedResponse();
  }

  // CSRF mitigation for state-changing requests: accept only requests whose
  // Origin matches the request host OR is explicitly listed in PUBLIC_URL.
  // This keeps the UI working behind reverse proxies (Synology DSM portal,
  // Traefik, nginx) while still rejecting cross-site writes.
  const method = context.request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = context.request.headers.get('origin');
    if (!isOriginAllowed(origin, context.request.url)) {
      logger.warn(
        `[auth] Rejected ${method} ${new URL(context.request.url).pathname} — origin ${origin ?? 'none'} not allowed. ` +
          'Set PUBLIC_URL to the URL(s) your browser uses.',
      );
      return new Response('Cross-site requests are not allowed', { status: 403 });
    }
  }

  return next();
});
