// Filesystem mutex used to serialize backup runs across the web and worker
// processes. Both call acquire() before running runBackup(); only one wins
// at a time. The lock file holds the owning PID + an ISO timestamp so a
// stale lock (process crashed) can be safely reclaimed.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LOCK_FILE = '.backup.lock';

interface LockBody {
  pid: number;
  startedAt: string;
}

function lockPath(): string {
  const dataDir = process.env.DATA_DIR ?? '/data';
  return join(dataDir, LOCK_FILE);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Sending signal 0 just checks whether the process exists and is reachable
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // exists but we can't signal it — treat as alive
  }
}

function readLock(path: string): LockBody | undefined {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as LockBody;
  } catch {
    return undefined;
  }
}

function tryCreateLock(path: string, body: LockBody): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    // O_EXCL | O_CREAT — fails if the file already exists, atomic
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify(body, null, 2), { encoding: 'utf-8' });
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface LockHandle {
  release(): void;
  body: LockBody;
}

/**
 * Try to acquire the backup lock. Returns a handle on success, or undefined if
 * another live process is currently running a backup.
 */
export function tryAcquireBackupLock(): LockHandle | undefined {
  const path = lockPath();
  const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString() };

  if (tryCreateLock(path, body)) {
    return makeHandle(path, body);
  }

  // Lock exists — check if it's stale
  const existing = readLock(path);
  if (!existing || !isPidAlive(existing.pid)) {
    console.warn('[backup-lock] Removing stale lock for pid', existing?.pid);
    try {
      unlinkSync(path);
    } catch {
      // Race: another process cleaned up first
    }
    if (tryCreateLock(path, body)) {
      return makeHandle(path, body);
    }
  }

  return undefined;
}

function makeHandle(path: string, body: LockBody): LockHandle {
  let released = false;
  return {
    body,
    release(): void {
      if (released) return;
      released = true;
      try {
        if (existsSync(path)) {
          // Only remove the lock if it still belongs to us (defensive)
          const current = readLock(path);
          if (!current || current.pid === body.pid) {
            unlinkSync(path);
          }
        }
      } catch (err) {
        console.error('[backup-lock] Failed to release lock:', err);
      }
    },
  };
}

/** Inspect the lock without acquiring. */
export function inspectBackupLock(): LockBody | undefined {
  const path = lockPath();
  if (!existsSync(path)) return undefined;
  const body = readLock(path);
  if (!body) return undefined;
  if (!isPidAlive(body.pid)) return undefined;
  return body;
}
