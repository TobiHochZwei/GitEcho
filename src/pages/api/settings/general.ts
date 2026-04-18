import type { APIRoute } from 'astro';
import { patchSettings } from '../../../lib/settings.js';

interface GeneralInput {
  backupMode?: 'option1' | 'option2' | 'option3';
  cronSchedule?: string;
}

function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
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

  patchSettings({
    backupMode: body.backupMode,
    cronSchedule: body.cronSchedule,
  });

  return new Response(JSON.stringify({ ok: true, note: 'Cron schedule changes require a worker restart to take effect.' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
