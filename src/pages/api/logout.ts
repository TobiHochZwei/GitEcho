import type { APIRoute } from 'astro';

// HTTP Basic Auth "logout" trick: respond with 401 to force the browser
// to drop cached credentials, then redirect to /.
export const GET: APIRoute = async () => {
  return new Response(
    '<!doctype html><meta http-equiv="refresh" content="0; url=/"><p>Signed out. <a href="/">Return to dashboard</a>.</p>',
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="GitEcho-loggedout", charset="UTF-8"',
        'Content-Type': 'text/html; charset=utf-8',
      },
    },
  );
};
