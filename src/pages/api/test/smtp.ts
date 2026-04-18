import type { APIRoute } from 'astro';
import nodemailer from 'nodemailer';
import { getConfig } from '../../../lib/config.js';

interface TestInput {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
}

export const POST: APIRoute = async ({ request }) => {
  let body: TestInput = {};
  try {
    body = (await request.json()) as TestInput;
  } catch {
    // ignore
  }

  const stored = getConfig().smtp;
  const host = body.host || stored?.host;
  const port = body.port || stored?.port || 587;
  const user = body.user || stored?.user;
  const pass = body.pass || stored?.pass;
  const from = body.from || stored?.from;
  const to = body.to || stored?.to;

  const missing: string[] = [];
  if (!host) missing.push('host');
  if (!user) missing.push('user');
  if (!pass) missing.push('pass');
  if (!from) missing.push('from');
  if (!to) missing.push('to');
  if (missing.length) {
    return new Response(JSON.stringify({ ok: false, error: `Missing SMTP fields: ${missing.join(', ')}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: host!,
      port: port!,
      secure: port === 465,
      auth: { user: user!, pass: pass! },
    });
    await transporter.verify();
    await transporter.sendMail({
      from: from!,
      to: to!,
      subject: '✅ GitEcho test email',
      text: 'This is a test email from GitEcho confirming your SMTP configuration works.',
    });
    return new Response(JSON.stringify({ ok: true, message: `Test email sent to ${to}.` }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
