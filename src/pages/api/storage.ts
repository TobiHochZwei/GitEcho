import type { APIRoute } from 'astro';
import { getConfig } from '../../lib/config.js';
import { getStorageUsage } from '../../lib/stats.js';

export const GET: APIRoute = async ({ url }) => {
  const force = url.searchParams.get('force') === '1';
  try {
    const cfg = getConfig();
    const usage = getStorageUsage(cfg.backupsDir, force);
    return new Response(JSON.stringify({ ok: true, ...usage }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
