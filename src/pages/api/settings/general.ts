import type { APIRoute } from 'astro';
import { patchSettings } from '../../../lib/settings.js';

interface GeneralInput {
  backupMode?: 'option1' | 'option2' | 'option3';
  cronSchedule?: string;
  cronTimezone?: string;
  cronEnabled?: boolean;
  runBackupOnStart?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PUT: APIRoute = async ({ request }) => {
  let body: GeneralInput;
  try {
    body = (await request.json()) as GeneralInput;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (body.cronSchedule !== undefined && !isValidCron(body.cronSchedule)) {
    return new Response(JSON.stringify({ error: 'Invalid cron expression' }), { status: 400 });
  }
  if (body.cronTimezone !== undefined && !isValidTimezone(body.cronTimezone)) {
    return new Response(
      JSON.stringify({ error: 'Invalid timezone. Use an IANA name like "Europe/Berlin" or "UTC".' }),
      { status: 400 },
    );
  }
  if (
    body.backupMode !== undefined &&
    body.backupMode !== 'option1' &&
    body.backupMode !== 'option2' &&
    body.backupMode !== 'option3'
  ) {
    return new Response(
      JSON.stringify({ error: 'backupMode must be option1, option2, or option3' }),
      { status: 400 },
    );
  }
  if (
    body.logLevel !== undefined &&
    body.logLevel !== 'debug' &&
    body.logLevel !== 'info' &&
    body.logLevel !== 'warn' &&
    body.logLevel !== 'error'
  ) {
    return new Response(
      JSON.stringify({ error: 'logLevel must be debug, info, warn, or error' }),
      { status: 400 },
    );
  }

  patchSettings({
    backupMode: body.backupMode,
    cronSchedule: body.cronSchedule,
    cronTimezone: body.cronTimezone,
    cronEnabled: typeof body.cronEnabled === 'boolean' ? body.cronEnabled : undefined,
    runBackupOnStart: typeof body.runBackupOnStart === 'boolean' ? body.runBackupOnStart : undefined,
    logLevel: body.logLevel,
  });

  // Cron-schedule / timezone changes still need a worker restart to pick up
  // the new cron expression. Toggling cronEnabled / runBackupOnStart takes
  // effect on the next tick (or next boot) without a restart.
  const note =
    body.cronSchedule !== undefined || body.cronTimezone !== undefined
      ? 'Cron schedule or timezone changes require a worker restart to take effect.'
      : undefined;

  return new Response(JSON.stringify({ ok: true, ...(note ? { note } : {}) }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
