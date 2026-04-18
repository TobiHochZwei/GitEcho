import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig } from '../../../lib/config.js';

const execFileAsync = promisify(execFile);

function normalizeOrgUrl(input: string): string {
  if (input.startsWith('https://')) return input;
  return `https://dev.azure.com/${input}`;
}

export const POST: APIRoute = async ({ request }) => {
  let body: { pat?: string; org?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // ignore
  }

  const cfg = getConfig().azureDevOps;
  const token = body.pat || cfg?.pat;
  const orgRaw = body.org || cfg?.org;
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'No Azure DevOps PAT available.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!orgRaw) {
    return new Response(JSON.stringify({ ok: false, error: 'Azure DevOps organization is required (env AZUREDEVOPS_ORG or settings).' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const org = normalizeOrgUrl(orgRaw);

  try {
    const { stdout } = await execFileAsync(
      'az',
      ['devops', 'project', 'list', '--organization', org, '--output', 'json'],
      { env: { ...process.env, AZURE_DEVOPS_EXT_PAT: token }, timeout: 20000 },
    );
    const parsed = JSON.parse(stdout) as { value?: { name: string }[] };
    const projects = parsed.value ?? [];
    return new Response(
      JSON.stringify({ ok: true, message: `Authenticated. Found ${projects.length} project(s).` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const e = err as Error & { stderr?: string };
    return new Response(JSON.stringify({ ok: false, error: e.stderr?.trim() || e.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
