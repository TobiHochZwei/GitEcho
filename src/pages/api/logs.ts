import type { APIRoute } from 'astro';
import { queryLogs } from '../../lib/logger.js';
import type { LogLevel } from '../../lib/logger.js';

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const GET: APIRoute = async ({ url }) => {
  const search = url.searchParams.get('search') ?? undefined;
  const rawLevels = parseList(url.searchParams.get('levels'));
  const levels = rawLevels.filter((l): l is LogLevel =>
    (VALID_LEVELS as string[]).includes(l),
  );
  const sources = parseList(url.searchParams.get('sources'));
  const before = url.searchParams.get('before') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  const result = queryLogs({
    search,
    levels: levels.length > 0 ? levels : undefined,
    sources: sources.length > 0 ? sources : undefined,
    before,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
