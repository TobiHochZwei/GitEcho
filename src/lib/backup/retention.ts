// Snapshot/zip retention — Grandfather-Father-Son (GFS) pruning.
//
// Both TFVC `snapshots/` directories and option3 `zips/` directories
// accumulate timestamped `.zip` artifacts that are SHA-256 deduplicated but
// otherwise never removed. This module applies a tiered retention policy so
// long-running instances don't grow without bound.
//
// A snapshot is KEPT when it matches ANY of the configured rules:
//   - daily   : it is newer than `dailyDays` days
//   - monthly : it is the newest snapshot in its calendar month, and that
//               month is within the most recent `monthlyCount` months
//   - yearly  : it is the newest snapshot in its calendar year, and that
//               year is within the most recent `yearlyCount` years
//
// Safety rails (always applied, regardless of policy):
//   - the single newest snapshot is never deleted
//   - a snapshot whose absolute path is in `protectedPaths` is never deleted
//     (used to protect the artifact matching the repository's current checksum)
//
// Retention is opt-in: when every rule is zero the policy is treated as
// "disabled" and nothing is ever deleted.

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';

// Snapshot artifacts are named `<repo>_<ISO timestamp>.zip`, where the
// timestamp is `new Date().toISOString()` with `:` and `.` replaced by `-`
// (e.g. `repo_2026-06-01T11-32-31-506Z.zip`). When pruning a repository's
// root directory (the option2 layout, where ZIPs live next to a git working
// tree) we match ONLY this pattern, so genuine repository content named
// `*.zip` is never mistaken for a prunable snapshot.
const SNAPSHOT_NAME = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/i;

export interface RetentionPolicy {
  /** Keep all snapshots newer than this many days. 0 disables the daily rule. */
  dailyDays: number;
  /** Keep the newest snapshot per month for this many recent months. 0 disables. */
  monthlyCount: number;
  /** Keep the newest snapshot per year for this many recent years. 0 disables. */
  yearlyCount: number;
}

/** A retention candidate: an absolute file path plus its modification time. */
export interface SnapshotFile {
  path: string;
  mtimeMs: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True when the policy would never delete anything. */
export function isRetentionDisabled(policy: RetentionPolicy): boolean {
  return (
    policy.dailyDays <= 0 && policy.monthlyCount <= 0 && policy.yearlyCount <= 0
  );
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function yearKey(d: Date): string {
  return String(d.getUTCFullYear());
}

/**
 * Given a set of snapshot files and a policy, return the subset that should be
 * DELETED. Pure function (no I/O) so it is straightforward to unit test.
 */
export function selectForDeletion(
  files: SnapshotFile[],
  policy: RetentionPolicy,
  now: number = Date.now(),
  protectedPaths: ReadonlySet<string> = new Set(),
): SnapshotFile[] {
  if (files.length === 0 || isRetentionDisabled(policy)) return [];

  // Newest first.
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keep = new Set<string>();

  // Always keep the single newest snapshot.
  keep.add(sorted[0].path);

  // Always keep explicitly protected paths (e.g. current-checksum artifact).
  for (const f of sorted) {
    if (protectedPaths.has(f.path)) keep.add(f.path);
  }

  // Daily rule: everything newer than the cutoff.
  if (policy.dailyDays > 0) {
    const cutoff = now - policy.dailyDays * MS_PER_DAY;
    for (const f of sorted) {
      if (f.mtimeMs >= cutoff) keep.add(f.path);
    }
  }

  // Monthly rule: newest snapshot per calendar month, limited to the most
  // recent N distinct months that actually contain snapshots.
  if (policy.monthlyCount > 0) {
    const seen = new Map<string, string>(); // monthKey -> path (first = newest)
    for (const f of sorted) {
      const key = monthKey(new Date(f.mtimeMs));
      if (!seen.has(key)) seen.set(key, f.path);
    }
    const monthsNewestFirst = [...seen.keys()].sort().reverse();
    for (const key of monthsNewestFirst.slice(0, policy.monthlyCount)) {
      keep.add(seen.get(key)!);
    }
  }

  // Yearly rule: newest snapshot per calendar year, limited to the most
  // recent N distinct years that actually contain snapshots.
  if (policy.yearlyCount > 0) {
    const seen = new Map<string, string>(); // yearKey -> path (first = newest)
    for (const f of sorted) {
      const key = yearKey(new Date(f.mtimeMs));
      if (!seen.has(key)) seen.set(key, f.path);
    }
    const yearsNewestFirst = [...seen.keys()].sort().reverse();
    for (const key of yearsNewestFirst.slice(0, policy.yearlyCount)) {
      keep.add(seen.get(key)!);
    }
  }

  return sorted.filter((f) => !keep.has(f.path));
}

/**
 * List the `.zip` files in a directory as retention candidates. When
 * `onlySnapshotNames` is true, only files matching the `<repo>_<timestamp>.zip`
 * snapshot pattern are returned — used for repository-root (option2) dirs so
 * we never touch unrelated `.zip` files. Symlinked files are skipped so a
 * stray symlink can never cause deletion of a target outside the tree.
 */
function listZips(dir: string, onlySnapshotNames: boolean): SnapshotFile[] {
  if (!existsSync(dir)) return [];
  const out: SnapshotFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    if (onlySnapshotNames && !SNAPSHOT_NAME.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = lstatSync(full);
      if (st.isFile()) out.push({ path: full, mtimeMs: st.mtimeMs });
    } catch {
      // File vanished between readdir and stat — ignore.
    }
  }
  return out;
}

/**
 * Apply the policy to a single directory of `.zip` snapshots. Returns the
 * number of files deleted. Best-effort: a failure to delete one file is
 * logged and does not stop the rest.
 */
export function pruneDir(
  dir: string,
  policy: RetentionPolicy,
  options: {
    now?: number;
    protectedPaths?: ReadonlySet<string>;
    onlySnapshotNames?: boolean;
  } = {},
): number {
  const files = listZips(dir, options.onlySnapshotNames ?? false);
  const toDelete = selectForDeletion(
    files,
    policy,
    options.now ?? Date.now(),
    options.protectedPaths ?? new Set(),
  );
  let deleted = 0;
  for (const f of toDelete) {
    try {
      rmSync(f.path, { force: true });
      deleted++;
    } catch (err) {
      logger.warn(
        `[retention] Failed to delete ${f.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return deleted;
}

/**
 * Walk every repository's artifact directories under `backupsDir` and apply
 * the retention policy. Targets:
 *   - `snapshots/` (TFVC) and `zips/` (option3) — every `.zip` is a snapshot.
 *   - repository-root dirs holding `<repo>_<timestamp>.zip` files directly
 *     (the option2 layout) — only timestamp-named ZIPs are pruned.
 *
 * Best-effort and side-effect-only: returns the total number of deleted files.
 */
export function sweepRetention(backupsDir: string, policy: RetentionPolicy): number {
  if (isRetentionDisabled(policy)) return 0;
  if (!existsSync(backupsDir)) return 0;

  let totalDeleted = 0;
  for (const { dir, dedicated } of findArtifactDirs(backupsDir)) {
    totalDeleted += pruneDir(dir, policy, { onlySnapshotNames: !dedicated });
  }
  if (totalDeleted > 0) {
    logger.info(
      `[retention] Pruned ${totalDeleted} old snapshot${totalDeleted === 1 ? '' : 's'} ` +
        `(policy: ${policy.dailyDays}d/${policy.monthlyCount}m/${policy.yearlyCount}y)`,
    );
  }
  return totalDeleted;
}

/** An artifact directory plus how its ZIPs should be treated. */
interface ArtifactDir {
  dir: string;
  /**
   * When true (`snapshots/`, `zips/`) every `.zip` is a snapshot. When false
   * (a repository root, option2 layout) only timestamp-named ZIPs are pruned.
   */
  dedicated: boolean;
}

/**
 * Recursively locate artifact directories beneath `root`. The backup tree is
 * shallow (`<provider>/<owner>/<name>/...`) but owners can contain slashes
 * (e.g. `org/project`), so we walk generically. Symlinked directories are
 * skipped so pruning can never escape the backups tree.
 */
function findArtifactDirs(root: string): ArtifactDir[] {
  const found: ArtifactDir[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    let hasLooseSnapshot = false;
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name === 'snapshots' || name === 'zips') {
          found.push({ dir: full, dedicated: true });
          // Don't descend into dedicated artifact dirs themselves.
          continue;
        }
        // Skip git mirror clones / working trees — not retention targets.
        if (name === 'clone') continue;
        walk(full);
      } else if (st.isFile() && SNAPSHOT_NAME.test(name)) {
        // A repository root holding option2 ZIPs directly.
        hasLooseSnapshot = true;
      }
    }
    if (hasLooseSnapshot) {
      found.push({ dir, dedicated: false });
    }
  };
  walk(root);
  return found;
}
