// Higher-level stat helpers used by the dashboard. The storage-usage
// FS walk is expensive on large mirrors (many objects in .git), so we
// keep the result both in memory AND in a small JSON file next to the
// SQLite DB. That way:
//   * the dashboard SSR path never has to walk the FS (uses cache),
//   * the cache survives process restarts,
//   * the worker refreshes the cache after every backup run so it's
//     usually seconds-fresh when the user opens the dashboard.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from './config.js';
import { getDatabase, type BackupRun } from './database.js';

// In-memory TTL used only inside the *same* process. The persistent
// cache file is checked first and, since the worker keeps it fresh,
// this rarely matters.
const STORAGE_MEM_TTL_MS = 60 * 1000;

/** Current on-disk cache format version. Bump on shape changes. */
const STORAGE_CACHE_VERSION = 1;

let storageMemCache: { value: StorageUsage; at: number } | null = null;

export interface StorageUsage {
  totalBytes: number;
  byProvider: Record<string, number>;
  /** ISO timestamp. Empty string when no walk has ever run. */
  computedAt: string;
}

interface StorageCacheFile {
  v: number;
  totalBytes: number;
  byProvider: Record<string, number>;
  computedAt: string;
}

export interface RunHistoryPoint {
  id: number;
  startedAt: string;
  status: string;
  total: number;
  success: number;
  failed: number;
}

export interface ExtendedStats {
  totalRepos: number;
  lastBackupAt: string | null;
  lastBackupAgeSeconds: number | null;
  lastRunStatus: string | null;
  hadRecentBackup: boolean;
  successRate30: number | null;
  failedRuns7d: number;
  unavailableCount: number;
}

/** Path of the persistent cache file inside `dataDir`. */
function storageCachePath(): string {
  return join(getConfig().dataDir, 'storage-cache.json');
}

function readStorageCacheFile(): StorageUsage | null {
  try {
    const raw = readFileSync(storageCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StorageCacheFile>;
    if (parsed.v !== STORAGE_CACHE_VERSION) return null;
    if (typeof parsed.totalBytes !== 'number') return null;
    return {
      totalBytes: parsed.totalBytes,
      byProvider: parsed.byProvider ?? {},
      computedAt: parsed.computedAt ?? '',
    };
  } catch {
    return null;
  }
}

function writeStorageCacheFile(value: StorageUsage): void {
  const payload: StorageCacheFile = {
    v: STORAGE_CACHE_VERSION,
    totalBytes: value.totalBytes,
    byProvider: value.byProvider,
    computedAt: value.computedAt,
  };
  const path = storageCachePath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // Cache write failure is non-fatal — we just lose the persistent
    // cache for this round and will re-walk next time.
  }
}

/**
 * Recursively sum file sizes under `dir`. Uses `withFileTypes` so we
 * avoid an extra `statSync` per entry, which is the slow part on
 * Windows bind mounts and large `.git/objects` trees.
 */
function dirSize(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      total += dirSize(full);
    } else if (ent.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // ignore racing deletions
      }
    }
  }
  return total;
}

function walkStorage(backupsDir: string): StorageUsage {
  const byProvider: Record<string, number> = {};
  let total = 0;
  if (existsSync(backupsDir)) {
    let providers: Dirent[] = [];
    try {
      providers = readdirSync(backupsDir, { withFileTypes: true });
    } catch {
      providers = [];
    }
    for (const ent of providers) {
      if (!ent.isDirectory()) continue;
      const size = dirSize(join(backupsDir, ent.name));
      byProvider[ent.name] = size;
      total += size;
    }
  }
  return {
    totalBytes: total,
    byProvider,
    computedAt: new Date().toISOString(),
  };
}

export interface GetStorageUsageOptions {
  /** Force a full walk, ignoring both in-memory and on-disk cache. */
  force?: boolean;
  /**
   * Maximum cache age accepted. Defaults to `Infinity` so the dashboard
   * SSR path never blocks on a walk — the worker refreshes the cache
   * after every backup run, and users can press "Recompute" to force.
   */
  maxAgeMs?: number;
}

/**
 * Return the current storage usage. By default returns the cached
 * value without ever walking the filesystem — the worker refreshes the
 * cache after each backup run. Pass `{ force: true }` for an explicit
 * recompute (wired to the Recompute button) or a finite `maxAgeMs` if
 * you want automatic refresh after some age.
 */
export function getStorageUsage(
  backupsDir: string,
  options: GetStorageUsageOptions | boolean = {},
): StorageUsage {
  // Preserve backward compatibility: getStorageUsage(dir, true) === force.
  const opts: GetStorageUsageOptions =
    typeof options === 'boolean' ? { force: options } : options;
  const force = opts.force === true;
  const maxAgeMs = opts.maxAgeMs ?? Number.POSITIVE_INFINITY;
  const now = Date.now();

  if (!force) {
    // In-memory cache (same process only).
    if (storageMemCache && now - storageMemCache.at < STORAGE_MEM_TTL_MS) {
      const ageMs = computedAtAgeMs(storageMemCache.value.computedAt, now);
      if (ageMs <= maxAgeMs) return storageMemCache.value;
    }
    // Persistent cache (shared across processes / restarts).
    const onDisk = readStorageCacheFile();
    if (onDisk) {
      const ageMs = computedAtAgeMs(onDisk.computedAt, now);
      if (ageMs <= maxAgeMs) {
        storageMemCache = { value: onDisk, at: now };
        return onDisk;
      }
    } else if (maxAgeMs === Number.POSITIVE_INFINITY) {
      // No cache yet and caller explicitly does not want to block the
      // request: return a zero placeholder instead of walking.
      return { totalBytes: 0, byProvider: {}, computedAt: '' };
    }
  }

  const value = walkStorage(backupsDir);
  storageMemCache = { value, at: now };
  writeStorageCacheFile(value);
  return value;
}

function computedAtAgeMs(computedAt: string, now: number): number {
  if (!computedAt) return Number.POSITIVE_INFINITY;
  const t = Date.parse(computedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - t);
}

export function getRunHistory(limit = 30): RunHistoryPoint[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, started_at, status, repos_total, repos_success, repos_failed
       FROM backup_runs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as BackupRun[];
  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      status: r.status,
      total: r.repos_total,
      success: r.repos_success,
      failed: r.repos_failed,
    }));
}

export function getExtendedStats(): ExtendedStats {
  const db = getDatabase();
  const totalRepos = (
    db.prepare('SELECT COUNT(*) as count FROM repositories').get() as { count: number }
  ).count;

  const latest = db
    .prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1')
    .get() as BackupRun | undefined;

  const lastBackupAt = latest?.completed_at ?? latest?.started_at ?? null;
  const lastBackupAgeSeconds = lastBackupAt
    ? Math.max(0, Math.round((Date.now() - new Date(lastBackupAt).getTime()) / 1000))
    : null;

  const recentSuccess = db
    .prepare(
      `SELECT COUNT(*) as count FROM backup_runs
       WHERE status = 'success' AND completed_at >= datetime('now', '-24 hours')`,
    )
    .get() as { count: number };

  const last30 = db
    .prepare(
      `SELECT status, repos_total, repos_success, repos_failed FROM (
         SELECT * FROM backup_runs ORDER BY id DESC LIMIT 30
       )`,
    )
    .all() as Array<{ status: string; repos_total: number; repos_success: number; repos_failed: number }>;
  let successRate30: number | null = null;
  if (last30.length > 0) {
    // Repo-level success rate: sum successful repos / (successful + failed
    // repos) across the last 30 runs. A single-repo failure in an
    // otherwise-green run of 100 should only count as 1%, not 100%.
    // Cancelled runs represent a deliberate user action, not a failure —
    // exclude them so manual cancellations don't drag the indicator down.
    const considered = last30.filter((r) => r.status !== 'cancelled');
    let successSum = 0;
    let failedSum = 0;
    for (const r of considered) {
      successSum += r.repos_success ?? 0;
      failedSum += r.repos_failed ?? 0;
    }
    const denom = successSum + failedSum;
    if (denom > 0) {
      successRate30 = Math.round((successSum / denom) * 100);
    }
  }

  const failed7d = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM backup_runs
         WHERE status != 'success' AND status != 'cancelled'
           AND started_at >= datetime('now', '-7 days')`,
      )
      .get() as { count: number }
  ).count;

  let unavailableCount = 0;
  try {
    unavailableCount = (
      db
        .prepare(`SELECT COUNT(*) as count FROM repositories WHERE last_sync_status = 'unavailable'`)
        .get() as { count: number }
    ).count;
  } catch {
    unavailableCount = 0;
  }

  return {
    totalRepos,
    lastBackupAt,
    lastBackupAgeSeconds,
    lastRunStatus: latest?.status ?? null,
    hadRecentBackup: recentSuccess.count > 0,
    successRate30,
    failedRuns7d: failed7d,
    unavailableCount,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'Never';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function daysUntil(dateIso: string | Date | null | undefined): number | null {
  if (!dateIso) return null;
  const d = typeof dateIso === 'string' ? new Date(dateIso) : dateIso;
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}
