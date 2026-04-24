import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { listLogFiles } from '../../../lib/logger.js';
import type { LogEntry, LogLevel } from '../../../lib/logger.js';

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface DownloadFilter {
  search?: string;
  levels?: LogLevel[];
  sources?: string[];
}

function hasFilters(f: DownloadFilter): boolean {
  return Boolean(f.search) || (f.levels && f.levels.length > 0) || (f.sources && f.sources.length > 0);
}

function parseLine(raw: string): LogEntry | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const obj = JSON.parse(trimmed) as Partial<LogEntry>;
    if (!obj.ts || !obj.level || !obj.message) return undefined;
    return {
      ts: String(obj.ts),
      level: obj.level as LogLevel,
      source: String(obj.source ?? 'unknown'),
      pid: Number(obj.pid ?? 0),
      message: String(obj.message),
      meta: obj.meta,
    };
  } catch {
    return undefined;
  }
}

function matches(entry: LogEntry, f: DownloadFilter): boolean {
  if (f.levels && f.levels.length > 0 && !f.levels.includes(entry.level)) return false;
  if (f.sources && f.sources.length > 0 && !f.sources.includes(entry.source)) return false;
  if (f.search) {
    const needle = f.search.toLowerCase();
    const hay = (entry.message + ' ' + (entry.meta ? JSON.stringify(entry.meta) : '')).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/**
 * Streams a concatenation of all log files (oldest archive first, then the
 * current log). The output is a single JSONL blob for easy grep/jq use.
 *
 * Optional query parameters apply the same filters as /api/logs:
 *   - search:  case-insensitive substring match
 *   - levels:  comma-separated list (debug,info,warn,error)
 *   - sources: comma-separated list (e.g. server,worker)
 * If no filters are supplied the original raw concatenation is returned
 * (preserves existing behaviour).
 */
export const GET: APIRoute = async ({ url }) => {
  const rawLevels = parseList(url.searchParams.get('levels'));
  const filter: DownloadFilter = {
    search: url.searchParams.get('search') ?? undefined,
    levels: rawLevels.filter((l): l is LogLevel => (VALID_LEVELS as string[]).includes(l)),
    sources: parseList(url.searchParams.get('sources')),
  };

  const files = listLogFiles();
  // Oldest first: reverse the list returned by listLogFiles (current, .1..5).
  files.reverse();

  let body: string;
  let filenameSuffix = '';

  if (!hasFilters(filter)) {
    const parts: string[] = [];
    for (const f of files) {
      try {
        parts.push(readFileSync(f, 'utf-8'));
      } catch {
        /* ignore */
      }
    }
    body = parts.join('');
  } else {
    const lines: string[] = [];
    for (const f of files) {
      let content = '';
      try {
        content = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (const raw of content.split(/\r?\n/)) {
        const entry = parseLine(raw);
        if (!entry) continue;
        if (!matches(entry, filter)) continue;
        lines.push(JSON.stringify(entry));
      }
    }
    body = lines.length > 0 ? lines.join('\n') + '\n' : '';
    filenameSuffix = '-filtered';
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="gitecho-logs${filenameSuffix}-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}.jsonl"`,
      'Cache-Control': 'no-store',
    },
  });
};
