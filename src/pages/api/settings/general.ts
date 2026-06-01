import type { APIRoute } from 'astro';
import { patchSettings } from '../../../lib/settings.js';

interface GeneralInput {
  backupMode?: 'option1' | 'option2' | 'option3';
  cronSchedule?: string;
  cronTimezone?: string;
  cronEnabled?: boolean;
  runBackupOnStart?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  retention?: {
    dailyDays?: unknown;
    monthlyCount?: unknown;
    yearlyCount?: unknown;
  };
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

  // Retention: each tier must be a non-negative integer. Persist all three
  // together so the policy is always internally consistent.
  let retention: { dailyDays: number; monthlyCount: number; yearlyCount: number } | undefined;
  if (body.retention !== undefined) {
    const parseTier = (value: unknown, label: string): number | { error: string } => {
      // Require a real number — don't coerce null/''/[] to 0, which would
      // silently disable a tier for a malformed request.
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        return { error: `retention.${label} must be a non-negative integer` };
      }
      return value;
    };
    const dailyDays = parseTier(body.retention.dailyDays, 'dailyDays');
    const monthlyCount = parseTier(body.retention.monthlyCount, 'monthlyCount');
    const yearlyCount = parseTier(body.retention.yearlyCount, 'yearlyCount');
    for (const t of [dailyDays, monthlyCount, yearlyCount]) {
      if (typeof t === 'object') {
        return new Response(JSON.stringify({ error: t.error }), { status: 400 });
      }
    }
    retention = {
      dailyDays: dailyDays as number,
      monthlyCount: monthlyCount as number,
      yearlyCount: yearlyCount as number,
    };
  }

  patchSettings({
    backupMode: body.backupMode,
    cronSchedule: body.cronSchedule,
    cronTimezone: body.cronTimezone,
    cronEnabled: typeof body.cronEnabled === 'boolean' ? body.cronEnabled : undefined,
    runBackupOnStart: typeof body.runBackupOnStart === 'boolean' ? body.runBackupOnStart : undefined,
    logLevel: body.logLevel,
    ...(retention ? { retention } : {}),
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
