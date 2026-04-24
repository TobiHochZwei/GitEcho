import type { APIRoute } from 'astro';
import {
  buildSessionCookie,
  changePassword,
  createSession,
  destroyAllSessions,
  requestIsSecure,
  touchSession,
} from '../../../lib/auth.js';

export const POST: APIRoute = async ({ request }) => {
  const session = touchSession(request.headers.get('cookie'));
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let currentPassword = '';
  let newPassword = '';
  let newUsername: string | undefined;
  const ctype = request.headers.get('content-type') ?? '';
  try {
    if (ctype.includes('application/json')) {
      const body = (await request.json()) as {
        currentPassword?: string;
        newPassword?: string;
        newUsername?: string;
      };
      currentPassword = body.currentPassword ?? '';
      newPassword = body.newPassword ?? '';
      newUsername = body.newUsername;
    } else {
      const form = await request.formData();
      currentPassword = String(form.get('currentPassword') ?? '');
      newPassword = String(form.get('newPassword') ?? '');
      const un = form.get('newUsername');
      if (un !== null) newUsername = String(un);
    }
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const result = await changePassword(currentPassword, newPassword, newUsername);
  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false, error: result.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // changePassword() already cleared every session including ours; mint a new
  // one so the caller isn't kicked out after rotating their own credentials.
  destroyAllSessions();
  const sid = createSession(newUsername?.trim() || session.username);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildSessionCookie(sid, requestIsSecure(request)),
    },
  });
};
