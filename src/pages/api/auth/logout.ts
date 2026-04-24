import type { APIRoute } from 'astro';
import {
  buildClearSessionCookie,
  destroySessionByCookie,
  requestIsSecure,
} from '../../../lib/auth.js';

function respond(request: Request, method: 'get' | 'post'): Response {
  destroySessionByCookie(request.headers.get('cookie'));
  const cookie = buildClearSessionCookie(requestIsSecure(request));
  if (method === 'get') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/login?signedOut=1',
        'Set-Cookie': cookie,
      },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}

export const GET: APIRoute = async ({ request }) => respond(request, 'get');
export const POST: APIRoute = async ({ request }) => respond(request, 'post');
