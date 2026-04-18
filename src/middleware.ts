// HTTP Basic Auth middleware for the Astro web UI.
// When UI_USER and UI_PASS are both set, every request must present matching
// credentials. When unset, the UI is open and a warning is logged on the
// first request so the operator notices.

import { defineMiddleware } from 'astro:middleware';
import { timingSafeEqual } from 'node:crypto';

let warnedOpen = false;

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

export const onRequest = defineMiddleware(async (context, next) => {
  const expectedUser = process.env.UI_USER;
  const expectedPass = process.env.UI_PASS;

  if (!expectedUser || !expectedPass) {
    if (!warnedOpen) {
      warnedOpen = true;
      console.warn(
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

  // Cheap CSRF mitigation for state-changing requests: same-origin only.
  const method = context.request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const fetchSite = context.request.headers.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return new Response('Cross-site requests are not allowed', { status: 403 });
    }
  }

  return next();
});
