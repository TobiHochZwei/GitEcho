import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  isRetentionDisabled,
  pruneDir,
  selectForDeletion,
  sweepRetention,
  type RetentionPolicy,
  type SnapshotFile,
} from '../../src/lib/backup/retention.ts';

const DAY = 24 * 60 * 60 * 1000;

/** Build a snapshot file whose mtime is `daysAgo` days before `now`. */
function snap(name: string, daysAgo: number, now: number): SnapshotFile {
  return { path: name, mtimeMs: now - daysAgo * DAY };
}

describe('isRetentionDisabled', () => {
  it('is disabled when every tier is zero', () => {
    assert.equal(isRetentionDisabled({ dailyDays: 0, monthlyCount: 0, yearlyCount: 0 }), true);
  });

  it('is enabled when any tier is positive', () => {
    assert.equal(isRetentionDisabled({ dailyDays: 1, monthlyCount: 0, yearlyCount: 0 }), false);
    assert.equal(isRetentionDisabled({ dailyDays: 0, monthlyCount: 1, yearlyCount: 0 }), false);
    assert.equal(isRetentionDisabled({ dailyDays: 0, monthlyCount: 0, yearlyCount: 1 }), false);
  });
});

describe('selectForDeletion', () => {
  // Fixed reference point so calendar-month/year bucketing is deterministic.
  const now = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15

  it('deletes nothing when the policy is disabled', () => {
    const files = [snap('a', 0, now), snap('b', 100, now), snap('c', 1000, now)];
    const policy: RetentionPolicy = { dailyDays: 0, monthlyCount: 0, yearlyCount: 0 };
    assert.deepEqual(selectForDeletion(files, policy, now), []);
  });

  it('deletes nothing for an empty input', () => {
    const policy: RetentionPolicy = { dailyDays: 14, monthlyCount: 12, yearlyCount: 3 };
    assert.deepEqual(selectForDeletion([], policy, now), []);
  });

  it('keeps everything inside the daily window', () => {
    const files = [snap('d0', 0, now), snap('d5', 5, now), snap('d13', 13, now)];
    const policy: RetentionPolicy = { dailyDays: 14, monthlyCount: 0, yearlyCount: 0 };
    assert.deepEqual(selectForDeletion(files, policy, now), []);
  });

  it('always keeps the single newest snapshot even outside every window', () => {
    const files = [snap('old1', 400, now), snap('old2', 800, now)];
    const policy: RetentionPolicy = { dailyDays: 1, monthlyCount: 0, yearlyCount: 0 };
    const deleted = selectForDeletion(files, policy, now).map((f) => f.path);
    assert.deepEqual(deleted, ['old2']); // old1 (newest) is kept
  });

  it('keeps the newest snapshot per month within the monthly window', () => {
    // Several snapshots across April, May, June 2026.
    const files: SnapshotFile[] = [
      { path: 'jun-15', mtimeMs: Date.UTC(2026, 5, 15) },
      { path: 'jun-02', mtimeMs: Date.UTC(2026, 5, 2) },
      { path: 'may-28', mtimeMs: Date.UTC(2026, 4, 28) },
      { path: 'may-10', mtimeMs: Date.UTC(2026, 4, 10) },
      { path: 'apr-20', mtimeMs: Date.UTC(2026, 3, 20) },
      { path: 'apr-05', mtimeMs: Date.UTC(2026, 3, 5) },
    ];
    // Daily off; keep newest per month for the 3 most recent months.
    const policy: RetentionPolicy = { dailyDays: 0, monthlyCount: 3, yearlyCount: 0 };
    const deleted = selectForDeletion(files, policy, now)
      .map((f) => f.path)
      .sort();
    // Kept: jun-15 (newest overall + month), may-28, apr-20. Deleted the rest.
    assert.deepEqual(deleted, ['apr-05', 'jun-02', 'may-10']);
  });

  it('keeps the newest snapshot per year within the yearly window', () => {
    const files: SnapshotFile[] = [
      { path: 'y2026-b', mtimeMs: Date.UTC(2026, 5, 15) },
      { path: 'y2026-a', mtimeMs: Date.UTC(2026, 0, 3) },
      { path: 'y2025-b', mtimeMs: Date.UTC(2025, 11, 31) },
      { path: 'y2025-a', mtimeMs: Date.UTC(2025, 2, 1) },
      { path: 'y2024', mtimeMs: Date.UTC(2024, 6, 9) },
    ];
    const policy: RetentionPolicy = { dailyDays: 0, monthlyCount: 0, yearlyCount: 2 };
    const deleted = selectForDeletion(files, policy, now)
      .map((f) => f.path)
      .sort();
    // Kept: y2026-b (newest year 2026), y2025-b (newest year 2025).
    // y2024 is outside the 2-year window; y2026-a/y2025-a are not newest-in-year.
    assert.deepEqual(deleted, ['y2024', 'y2025-a', 'y2026-a']);
  });

  it('never deletes a protected path (current checksum artifact)', () => {
    const files = [snap('new', 0, now), snap('old', 900, now), snap('protected', 950, now)];
    const policy: RetentionPolicy = { dailyDays: 1, monthlyCount: 0, yearlyCount: 0 };
    const deleted = selectForDeletion(files, policy, now, new Set(['protected'])).map((f) => f.path);
    assert.deepEqual(deleted, ['old']); // protected kept despite being oldest
  });

  it('combines tiers as a union (kept if it matches any rule)', () => {
    const files: SnapshotFile[] = [
      { path: 'today', mtimeMs: now },
      { path: 'lastweek', mtimeMs: now - 7 * DAY },
      { path: 'may', mtimeMs: Date.UTC(2026, 4, 20) },
      { path: 'apr', mtimeMs: Date.UTC(2026, 3, 20) },
      { path: 'y2024', mtimeMs: Date.UTC(2024, 6, 1) },
      { path: 'y2023', mtimeMs: Date.UTC(2023, 6, 1) },
    ];
    const policy: RetentionPolicy = { dailyDays: 14, monthlyCount: 2, yearlyCount: 2 };
    const deleted = selectForDeletion(files, policy, now)
      .map((f) => f.path)
      .sort();
    // today/lastweek: daily window. Months present: 2026-06, 2026-05, 2026-04;
    // monthly=2 keeps newest of the 2 most recent (Jun, May) -> 'apr' falls out.
    // Years present: 2026, 2024, 2023; yearly=2 keeps newest of Jun-2026 + 2024.
    // So 'apr' (no rule) and 'y2023' (outside yearly window) are deleted.
    assert.deepEqual(deleted, ['apr', 'y2023']);
  });
});

// ── Filesystem-level tests for the real sweep ────────────────────────────

const DAILY_ONLY: RetentionPolicy = { dailyDays: 1, monthlyCount: 0, yearlyCount: 0 };

/** Make a `<repo>_<timestamp>.zip` name whose timestamp is `daysAgo` old. */
function snapName(repo: string, daysAgo: number): { name: string; mtime: Date } {
  const mtime = new Date(Date.now() - daysAgo * DAY);
  const ts = mtime.toISOString().replace(/[:.]/g, '-');
  return { name: `${repo}_${ts}.zip`, mtime };
}

/** Write a `.zip` with a given age (mtime) into `dir`. Returns the full path. */
function writeSnapshot(dir: string, repo: string, daysAgo: number): string {
  mkdirSync(dir, { recursive: true });
  const { name, mtime } = snapName(repo, daysAgo);
  const full = path.join(dir, name);
  writeFileSync(full, 'x');
  const t = mtime.getTime() / 1000;
  utimesSync(full, t, t);
  return full;
}

describe('sweepRetention (filesystem)', () => {
  const roots: string[] = [];
  const newRoot = (): string => {
    const r = mkdtempSync(path.join(os.tmpdir(), 'gitecho-retention-test-'));
    roots.push(r);
    return r;
  };

  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        // Windows file lock — ignore.
      }
    }
  });

  it('does nothing when the policy is disabled', () => {
    const root = newRoot();
    const zips = path.join(root, 'azuredevops', 'org', 'repo', 'zips');
    const old = writeSnapshot(zips, 'repo', 400);
    const deleted = sweepRetention(root, { dailyDays: 0, monthlyCount: 0, yearlyCount: 0 });
    assert.equal(deleted, 0);
    assert.ok(existsSync(old));
  });

  it('prunes old TFVC snapshots/ but keeps the newest', () => {
    const root = newRoot();
    const snaps = path.join(root, 'azuredevops', 'contoso/PaymentsApp', 'Main', 'snapshots');
    const fresh = writeSnapshot(snaps, 'Main', 0);
    const old1 = writeSnapshot(snaps, 'Main', 100);
    const old2 = writeSnapshot(snaps, 'Main', 200);
    const deleted = sweepRetention(root, DAILY_ONLY);
    assert.equal(deleted, 2);
    assert.ok(existsSync(fresh));
    assert.ok(!existsSync(old1));
    assert.ok(!existsSync(old2));
  });

  it('prunes option3 zips/ but never the clone/ mirror', () => {
    const root = newRoot();
    const repoDir = path.join(root, 'github', 'acme', 'widget');
    const zips = path.join(repoDir, 'zips');
    const fresh = writeSnapshot(zips, 'widget', 0);
    const old = writeSnapshot(zips, 'widget', 365);
    // A clone/ dir that happens to contain a timestamp-looking zip must be left alone.
    const cloneZip = writeSnapshot(path.join(repoDir, 'clone'), 'widget', 365);
    const deleted = sweepRetention(root, DAILY_ONLY);
    assert.equal(deleted, 1);
    assert.ok(existsSync(fresh));
    assert.ok(!existsSync(old));
    assert.ok(existsSync(cloneZip), 'clone/ contents must never be pruned');
  });

  it('prunes option2 root ZIPs but ignores non-snapshot .zip files', () => {
    const root = newRoot();
    const repoDir = path.join(root, 'gitlab', 'group/sub', 'project');
    const fresh = writeSnapshot(repoDir, 'project', 0);
    const old = writeSnapshot(repoDir, 'project', 90);
    // Repository content that merely ends in .zip must not match the snapshot
    // pattern and must survive pruning.
    mkdirSync(repoDir, { recursive: true });
    const content = path.join(repoDir, 'vendored-lib.zip');
    writeFileSync(content, 'x');
    const deleted = sweepRetention(root, DAILY_ONLY);
    assert.equal(deleted, 1);
    assert.ok(existsSync(fresh));
    assert.ok(!existsSync(old));
    assert.ok(existsSync(content), 'non-snapshot .zip files must never be pruned');
  });
});

describe('pruneDir', () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('respects onlySnapshotNames=true (option2-style dir)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-prunedir-test-'));
    roots.push(dir);
    const fresh = writeSnapshot(dir, 'repo', 0);
    const old = writeSnapshot(dir, 'repo', 50);
    writeFileSync(path.join(dir, 'data.zip'), 'x'); // not a snapshot name
    const deleted = pruneDir(dir, DAILY_ONLY, { onlySnapshotNames: true });
    assert.equal(deleted, 1);
    assert.ok(existsSync(fresh));
    assert.ok(!existsSync(old));
    assert.ok(existsSync(path.join(dir, 'data.zip')));
  });
});

