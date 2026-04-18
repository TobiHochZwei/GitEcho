import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../../../lib/config.js';

const execFileAsync = promisify(execFile);

export const POST: APIRoute = async ({ request }) => {
  let pat: string | undefined;
  try {
    const body = (await request.json()) as { pat?: string };
    pat = body?.pat;
  } catch {
    // ignore — fall back to stored token
  }

  const stored = getConfig().github?.pat;
  const token = pat || stored;

  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'No GitHub PAT available (provide one or save it first).' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      env: { ...process.env, GH_TOKEN: token },
      timeout: 15000,
    });
    return new Response(JSON.stringify({ ok: true, message: (stdout + '\n' + stderr).trim() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    return new Response(JSON.stringify({ ok: false, error: e.stderr?.trim() || e.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
