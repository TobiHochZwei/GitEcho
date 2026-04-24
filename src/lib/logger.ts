// Central structured logger for both the Astro server and the worker process.
//
// Features:
//   - Writes to stdout/stderr (preserving Docker log behaviour) AND to a
//     JSONL file under DATA_DIR/gitecho.log.
//   - Size-based rotation: LOG_MAX_BYTES (default 10 MB), keeps 5 archives.
//   - Per-process in-memory ring (last 1000 entries) — used only for tailing
//     within the same process, the UI reads from disk so it sees all sources.
//   - Automatic redaction of known secret values (PATs, MASTER_KEY, SMTP_PASS).
//   - Runtime level controlled by loadSettings().logLevel, fallback to env
//     LOG_LEVEL, fallback to 'info'.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string; // ISO timestamp
  level: LogLevel;
  source: string; // 'server' | 'worker'
  pid: number;
  message: string;
  meta?: Record<string, unknown>;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ARCHIVES = 5; // gitecho.log.1 .. gitecho.log.5
const RING_SIZE = 1000;

function dataDir(): string {
  return process.env.DATA_DIR ?? '/data';
}

export function logFilePath(): string {
  return join(dataDir(), 'gitecho.log');
}

export function archivePath(n: number): string {
  return `${logFilePath()}.${n}`;
}

function maxBytes(): number {
  const raw = process.env.LOG_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Level resolution
// ---------------------------------------------------------------------------

let overrideLevel: LogLevel | undefined;

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

/** Returns the effective level (override takes precedence over env). */
export function effectiveLevel(): LogLevel {
  return overrideLevel ?? envLevel();
}

/**
 * Override the log level at runtime. Called by the settings loader when
 * settings.json is read so UI changes take effect without a restart.
 * Pass undefined to clear the override and fall back to env LOG_LEVEL.
 */
export function setLevel(level: LogLevel | undefined): void {
  overrideLevel = level;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function collectSecrets(): string[] {
  const values = new Set<string>();
  for (const key of ['GITHUB_PAT', 'AZUREDEVOPS_PAT', 'GITLAB_PAT', 'MASTER_KEY', 'SMTP_PASS', 'UI_PASS']) {
    const v = process.env[key];
    if (v && v.length >= 6) values.add(v);
  }
  return Array.from(values);
}

function redactString(input: string): string {
  let out = input;
  for (const s of collectSecrets()) {
    if (!s) continue;
    // Simple substring replace; safe because secrets are exact values from env.
    while (out.includes(s)) {
      out = out.replace(s, '***');
    }
  }
  // Also redact secrets coming from the loaded settings (UI-managed PATs etc.)
  for (const s of runtimeSecrets) {
    if (!s || s.length < 6) continue;
    while (out.includes(s)) {
      out = out.replace(s, '***');
    }
  }
  // Generic "classic" GitHub PAT pattern (ghp_..., github_pat_...)
  out = out.replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, '***');
  // Generic GitLab PAT pattern (glpat-..., ~20+ chars)
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '***');
  // Strip credentials embedded in URLs: https://user:pass@host and https://token@host
  out = out.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1***:***@');
  out = out.replace(/(https?:\/\/)[^/@\s:]{6,}@/gi, '$1***@');
  return out;
}

/**
 * Remove known secrets and credentials-in-URLs from an arbitrary string.
 * Safe to call on error messages, email bodies, and DB-bound fields.
 */
export function redactSecrets(input: string): string {
  return redactString(input);
}

// Secrets registered at runtime (e.g. from settings.json by the config loader).
const runtimeSecrets = new Set<string>();

/** Register a secret value so the logger and redactSecrets() will mask it. */
export function registerSecret(secret: string | undefined | null): void {
  if (!secret || secret.length < 6) return;
  runtimeSecrets.add(secret);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

const ring: LogEntry[] = [];
let fileWriteDisabled = false;

function ensureDirOk(): boolean {
  if (fileWriteDisabled) return false;
  try {
    mkdirSync(dirname(logFilePath()), { recursive: true });
    return true;
  } catch {
    fileWriteDisabled = true;
    return false;
  }
}

function maybeRotate(): void {
  try {
    if (!existsSync(logFilePath())) return;
    const size = statSync(logFilePath()).size;
    if (size < maxBytes()) return;

    // Best-effort lock to avoid two processes rotating simultaneously.
    const lockPath = `${logFilePath()}.rotlock`;
    let lockFd: number | undefined;
    try {
      lockFd = openSync(lockPath, 'wx');
    } catch {
      return; // someone else is rotating
    }
    try {
      // Re-check size under lock.
      if (!existsSync(logFilePath())) return;
      if (statSync(logFilePath()).size < maxBytes()) return;

      // Drop oldest
      const oldest = archivePath(MAX_ARCHIVES);
      if (existsSync(oldest)) {
        try {
          unlinkSync(oldest);
        } catch {
          /* ignore */
        }
      }
      for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
        const from = archivePath(i);
        const to = archivePath(i + 1);
        if (existsSync(from)) {
          try {
            renameSync(from, to);
          } catch {
            /* ignore */
          }
        }
      }
      try {
        renameSync(logFilePath(), archivePath(1));
      } catch {
        /* ignore */
      }
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* rotation is best-effort */
  }
}

function writeEntry(entry: LogEntry): void {
  // Ring
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  // Console mirror
  const tag = `[${entry.source}]`;
  const metaStr = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  const line = `${entry.ts} ${tag} ${entry.message}${metaStr}`;
  if (entry.level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (entry.level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  // File
  if (!ensureDirOk()) return;
  try {
    maybeRotate();
    appendFileSync(logFilePath(), JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
  } catch {
    fileWriteDisabled = true;
  }
}

function source(): string {
  return process.env.GITECHO_PROCESS || 'server';
}

function formatMessage(args: unknown[]): { message: string; meta?: Record<string, unknown> } {
  // Mirror console.* semantics: concatenate string-ish, capture an Error if present.
  const parts: string[] = [];
  let meta: Record<string, unknown> | undefined;
  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.message);
      meta = { ...(meta || {}), stack: a.stack };
    } else if (typeof a === 'string') {
      parts.push(a);
    } else {
      try {
        parts.push(JSON.stringify(a));
      } catch {
        parts.push(String(a));
      }
    }
  }
  return { message: redactString(parts.join(' ')), meta };
}

function log(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] < LEVELS[effectiveLevel()]) return;
  const { message, meta } = formatMessage(args);
  writeEntry({
    ts: new Date().toISOString(),
    level,
    source: source(),
    pid: process.pid,
    message,
    meta,
  });
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', args),
  info: (...args: unknown[]) => log('info', args),
  log: (...args: unknown[]) => log('info', args),
  warn: (...args: unknown[]) => log('warn', args),
  error: (...args: unknown[]) => log('error', args),
};

// ---------------------------------------------------------------------------
// Reader — used by the /api/logs endpoint
// ---------------------------------------------------------------------------

export interface LogQuery {
  search?: string;
  levels?: LogLevel[];
  sources?: string[];
  before?: string; // ISO ts cursor (exclusive)
  limit?: number;
}

export interface LogQueryResult {
  entries: LogEntry[];
  nextBefore?: string;
  fileAvailable: boolean;
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
    return {
      ts: new Date(0).toISOString(),
      level: 'info',
      source: 'raw',
      pid: 0,
      message: trimmed,
    };
  }
}

function matches(entry: LogEntry, q: LogQuery): boolean {
  if (q.levels && q.levels.length > 0 && !q.levels.includes(entry.level)) return false;
  if (q.sources && q.sources.length > 0 && !q.sources.includes(entry.source)) return false;
  if (q.before && !(entry.ts < q.before)) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    const hay = (entry.message + ' ' + (entry.meta ? JSON.stringify(entry.meta) : '')).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function queryLogs(q: LogQuery): LogQueryResult {
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  const fileAvailable = existsSync(logFilePath());
  const files: string[] = [];
  if (fileAvailable) files.push(logFilePath());
  for (let i = 1; i <= MAX_ARCHIVES; i++) {
    if (existsSync(archivePath(i))) files.push(archivePath(i));
  }

  // Collect entries across files, newest first. For simplicity read each
  // file fully (rotation caps size to LOG_MAX_BYTES); reverse the lines.
  const collected: LogEntry[] = [];
  for (const f of files) {
    let content = '';
    try {
      content = readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i]);
      if (!entry) continue;
      if (!matches(entry, q)) continue;
      collected.push(entry);
      if (collected.length >= limit + 1) break;
    }
    if (collected.length >= limit + 1) break;
  }

  const hasMore = collected.length > limit;
  const entries = collected.slice(0, limit);
  return {
    entries,
    nextBefore: hasMore ? entries[entries.length - 1]?.ts : undefined,
    fileAvailable,
  };
}

export function listLogFiles(): string[] {
  const out: string[] = [];
  if (existsSync(logFilePath())) out.push(logFilePath());
  for (let i = 1; i <= MAX_ARCHIVES; i++) {
    if (existsSync(archivePath(i))) out.push(archivePath(i));
  }
  return out;
}
