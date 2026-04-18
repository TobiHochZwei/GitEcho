// Higher-level stat helpers used by the dashboard. Caches expensive
// filesystem walks (storage usage) for a short TTL.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase, type BackupRun } from './database.js';

const STORAGE_TTL_MS = 5 * 60 * 1000;

let storageCache: { value: StorageUsage; computedAt: number } | null = null;

export interface StorageUsage {
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

function dirSize(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      total += dirSize(full);
    } else if (st.isFile()) {
      total += st.size;
    }
  }
  return total;
}

export function getStorageUsage(backupsDir: string, force = false): StorageUsage {
  const now = Date.now();
  if (!force && storageCache && now - storageCache.computedAt < STORAGE_TTL_MS) {
    return storageCache.value;
  }
  const byProvider: Record<string, number> = {};
  let total = 0;
  if (existsSync(backupsDir)) {
    let providers: string[] = [];
    try {
      providers = readdirSync(backupsDir);
    } catch {
      providers = [];
    }
    for (const p of providers) {
      const full = join(backupsDir, p);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const size = dirSize(full);
      byProvider[p] = size;
      total += size;
    }
  }
  const value: StorageUsage = {
    totalBytes: total,
    byProvider,
    computedAt: new Date().toISOString(),
  };
  storageCache = { value, computedAt: now };
  return value;
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
      `SELECT status, repos_total FROM (
         SELECT * FROM backup_runs ORDER BY id DESC LIMIT 30
       )`,
    )
    .all() as Array<{ status: string; repos_total: number }>;
  let successRate30: number | null = null;
  if (last30.length > 0) {
    const ok = last30.filter((r) => r.status === 'success').length;
    successRate30 = Math.round((ok / last30.length) * 100);
  }

  const failed7d = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM backup_runs
         WHERE status != 'success' AND started_at >= datetime('now', '-7 days')`,
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
