import type { APIRoute } from 'astro';
import { runDiscovery } from '../../../../lib/discovery.js';
import type { DiscoveryProvider } from '../../../../lib/discovery.js';
import { logger } from '../../../../lib/logger.js';

interface DiscoverInput {
  provider?: 'github' | 'azureDevOps' | 'gitlab' | 'all';
}

export const POST: APIRoute = async ({ request }) => {
  let body: DiscoverInput = {};
  try {
    body = (await request.json()) as DiscoverInput;
  } catch {
    // empty body is fine — defaults to all providers
  }

  const providers: DiscoveryProvider[] | undefined =
    body.provider && body.provider !== 'all' ? [body.provider] : undefined;

  try {
    const result = await runDiscovery({ providers });

    const summary = result.providers.map((p) => ({
      provider: p.provider,
      authenticated: p.authenticated,
      total: p.total,
      newlyDiscovered: p.newlyDiscovered.length,
      filteredOut: p.filteredOut,
    }));

    return new Response(JSON.stringify({ ok: true, providers: summary }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // Log the full error server-side (the structured logger already redacts
    // registered secrets) but return a generic message to the client so we
    // don't leak stack-trace details. CodeQL: js/stack-trace-exposure.
    logger.error('discovery failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response(
      JSON.stringify({ error: 'Discovery failed. See server logs for details.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
};
