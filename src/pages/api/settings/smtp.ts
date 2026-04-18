import type { APIRoute } from 'astro';
import { isMasterKeyConfigured } from '../../../lib/secrets.js';
import { patchSettings, writeSecret } from '../../../lib/settings.js';

interface SmtpInput {
  host?: string;
  port?: number;
  user?: string;
  pass?: string; // blank = unchanged
  from?: string;
  to?: string;
  notifyOnSuccess?: boolean;
  patExpiryWarnDays?: number;
  clearPass?: boolean;
}

export const PUT: APIRoute = async ({ request }) => {
  let body: SmtpInput;
  try {
    body = (await request.json()) as SmtpInput;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const smtpPatch: { host?: string; port?: number; user?: string; from?: string; to?: string } = {};
  if (body.host !== undefined) smtpPatch.host = body.host || undefined;
  if (body.port !== undefined) smtpPatch.port = Number(body.port) || undefined;
  if (body.user !== undefined) smtpPatch.user = body.user || undefined;
  if (body.from !== undefined) smtpPatch.from = body.from || undefined;
  if (body.to !== undefined) smtpPatch.to = body.to || undefined;

  if (body.clearPass) {
    writeSecret('smtp.pass', undefined);
  } else if (body.pass) {
    if (!isMasterKeyConfigured()) {
      return new Response(
        JSON.stringify({ error: 'MASTER_KEY environment variable is required to save the SMTP password.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    writeSecret('smtp.pass', body.pass);
  }

  patchSettings({
    smtp: smtpPatch,
    notifyOnSuccess: body.notifyOnSuccess,
    patExpiryWarnDays: body.patExpiryWarnDays,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
