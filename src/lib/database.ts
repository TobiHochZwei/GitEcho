import * as BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

type DatabaseInstance = BetterSqlite3.Database;
type DatabaseCtor = new (filename?: string | Buffer, options?: BetterSqlite3.Options) => DatabaseInstance;

// Resolve the constructor — handles both CJS interop shapes at runtime
const Database = (
  'default' in BetterSqlite3
    ? (BetterSqlite3 as unknown as { default: DatabaseCtor }).default
    : BetterSqlite3
) as unknown as DatabaseCtor;

// ─── Type definitions ────────────────────────────────────────────────

export interface Repository {
  id: number;
  url: string;
  provider: string;
  owner: string;
  name: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_error: string | null;
  checksum: string | null;
  notes: string | null;
  skip_backup: number;
  debug_trace: number;
  archived: number;
  archived_at: string | null;
  archive_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  repos_total: number;
  repos_success: number;
  repos_failed: number;
  repos_unavailable: number;
  repos_skipped: number;
  error_summary: string | null;
  backup_mode: string;
}

export interface BackupItem {
  id: number;
  run_id: number;
  repository_id: number | null;
  status: string;
  error: string | null;
  checksum: string | null;
  zip_path: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface BackupStats {
  lastBackupAt: string | null;
  totalRepos: number;
  lastRunStatus: string | null;
  hadRecentBackup: boolean;
  unavailableCount: number;
}

// ─── Module-level singleton ──────────────────────────────────────────

let db: DatabaseInstance | undefined;

// ─── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    last_sync_at TEXT,
    last_sync_status TEXT,
    last_error TEXT,
    checksum TEXT,
    notes TEXT,
    skip_backup INTEGER NOT NULL DEFAULT 0,
    debug_trace INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    archive_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    repos_total INTEGER DEFAULT 0,
    repos_success INTEGER DEFAULT 0,
    repos_failed INTEGER DEFAULT 0,
    repos_unavailable INTEGER DEFAULT 0,
    repos_skipped INTEGER DEFAULT 0,
    error_summary TEXT,
    backup_mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backup_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES backup_runs(id),
    repository_id INTEGER REFERENCES repositories(id),
    status TEXT NOT NULL,
    error TEXT,
    checksum TEXT,
    zip_path TEXT,
    started_at TEXT,
    completed_at TEXT
  );
`;

// ─── Versioned migrations ────────────────────────────────────────────
//
// Append-only list of schema migrations. Each entry takes the database
// from version `index` to version `index + 1`. Rules:
//
//   1. NEVER edit or remove a previously-shipped migration. Only append.
//   2. Each migration runs inside a transaction together with the
//      `PRAGMA user_version` bump (handled by `runMigrations`), so a
//      crash leaves the DB at the previous version.
//   3. For destructive changes (drop/rename column, change type) follow
//      SQLite's 4-step recipe inside the migration: create new table →
//      INSERT … SELECT → DROP old → RENAME new.
//
// See DEVELOPMENT.md §10 for the full strategy.
const MIGRATIONS: ReadonlyArray<(instance: DatabaseInstance) => void> = [
  // v0 → v1: allow backup_items.repository_id to be NULL so a repository
  // can be deleted while its historical run entries remain for audit.
  // SQLite requires the 4-step table rewrite to change a column's NOT NULL.
  (instance) => {
    instance.exec(`
      CREATE TABLE backup_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES backup_runs(id),
        repository_id INTEGER REFERENCES repositories(id),
        status TEXT NOT NULL,
        error TEXT,
        checksum TEXT,
        zip_path TEXT,
        started_at TEXT,
        completed_at TEXT
      );
      INSERT INTO backup_items_new (id, run_id, repository_id, status, error, checksum, zip_path, started_at, completed_at)
        SELECT id, run_id, repository_id, status, error, checksum, zip_path, started_at, completed_at FROM backup_items;
      DROP TABLE backup_items;
      ALTER TABLE backup_items_new RENAME TO backup_items;
    `);
  },
];

// ─── Database initialization ─────────────────────────────────────────

export function initDatabase(dataDir: string): DatabaseInstance {
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'gitecho.db');
  const instance = new Database(dbPath);

  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.exec(SCHEMA);

  // Idempotent migrations for older databases that pre-date a column.
  // These remain in place to self-heal installs that existed before the
  // versioned migration runner was introduced.
  migrateAddColumnIfMissing(instance, 'backup_runs', 'repos_unavailable', 'INTEGER DEFAULT 0');
  migrateAddColumnIfMissing(instance, 'backup_runs', 'repos_skipped', 'INTEGER DEFAULT 0');
  migrateAddColumnIfMissing(instance, 'repositories', 'notes', 'TEXT');
  migrateAddColumnIfMissing(
    instance,
    'repositories',
    'skip_backup',
    'INTEGER NOT NULL DEFAULT 0',
  );
  migrateAddColumnIfMissing(
    instance,
    'repositories',
    'debug_trace',
    'INTEGER NOT NULL DEFAULT 0',
  );
  migrateAddColumnIfMissing(
    instance,
    'repositories',
    'archived',
    'INTEGER NOT NULL DEFAULT 0',
  );
  migrateAddColumnIfMissing(instance, 'repositories', 'archived_at', 'TEXT');
  migrateAddColumnIfMissing(instance, 'repositories', 'archive_path', 'TEXT');

  runMigrations(instance);

  db = instance;
  return instance;
}

function migrateAddColumnIfMissing(
  instance: DatabaseInstance,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = instance
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runMigrations(instance: DatabaseInstance): void {
  const current = instance.pragma('user_version', { simple: true }) as number;

  // Both fresh installs (after `SCHEMA`) and pre-versioning installs
  // (after the legacy `migrateAddColumnIfMissing` helpers above) end up
  // at the same schema shape with `user_version === 0`. From here, any
  // appended migration runs on both — so authors of new migrations
  // should only encode NEW changes, never re-do what `SCHEMA` or the
  // legacy helpers already do.
  for (let v = current; v < MIGRATIONS.length; v++) {
    const next = v + 1;
    logger.info(`[db] migrating v${v} → v${next}`);
    instance.transaction(() => {
      MIGRATIONS[v](instance);
      instance.pragma(`user_version = ${next}`);
    })();
  }
}

export function getDatabase(): DatabaseInstance {
  if (!db) {
    throw new Error(
      'Database not initialized. Call initDatabase(dataDir) first.',
    );
  }
  return db;
}

// ─── Repository CRUD ─────────────────────────────────────────────────

export function upsertRepository(repo: {
  url: string;
  provider: string;
  owner: string;
  name: string;
}): Repository {
  const database = getDatabase();

  // INSERT … ON CONFLICT DO UPDATE does NOT reliably update
  // `lastInsertRowid` on the UPDATE path in better-sqlite3 — the value may
  // point at an unrelated row from an earlier INSERT in the same
  // connection. Always look the row up by its unique `url` to be safe.
  database
    .prepare(
      `
        INSERT INTO repositories (url, provider, owner, name)
        VALUES (@url, @provider, @owner, @name)
        ON CONFLICT(url) DO UPDATE SET
          provider = excluded.provider,
          owner = excluded.owner,
          name = excluded.name,
          updated_at = datetime('now')
      `,
    )
    .run(repo);

  const row = database
    .prepare('SELECT * FROM repositories WHERE url = ?')
    .get(repo.url) as Repository | undefined;

  if (!row) {
    throw new Error(
      `[db] upsertRepository: no row found for ${repo.url} after insert. ` +
        'Database write may have failed.',
    );
  }
  return row;
}

export function getRepositories(
  provider?: string,
  opts: { includeArchived?: boolean; onlyArchived?: boolean } = {},
): Repository[] {
  const database = getDatabase();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.onlyArchived) {
    clauses.push('archived = 1');
  } else if (!opts.includeArchived) {
    clauses.push('archived = 0');
  }

  if (provider) {
    clauses.push('provider = ?');
    params.push(provider);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM repositories ${where} ORDER BY owner, name`)
    .all(...params) as Repository[];
}

export function getRepository(id: number): Repository | undefined {
  const database = getDatabase();
  return database.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as
    | Repository
    | undefined;
}

export function getRepositoryByUrl(url: string): Repository | undefined {
  const database = getDatabase();
  return database.prepare('SELECT * FROM repositories WHERE url = ?').get(url) as
    | Repository
    | undefined;
}

/** True when no repository row exists with the given URL (case-insensitive,
 * `.git` suffix tolerant). Used by the discovery pipeline to detect a
 * "first sighting" before upserting. */
export function isNewRepository(url: string): boolean {
  const database = getDatabase();
  const normalized = url.replace(/\.git$/, '').toLowerCase();
  const row = database
    .prepare(
      `SELECT 1 FROM repositories
       WHERE LOWER(REPLACE(url, '.git', '')) = ?
       LIMIT 1`,
    )
    .get(normalized);
  return row === undefined;
}

export function updateRepositorySync(
  id: number,
  status: string,
  error?: string,
  checksum?: string,
): void {
  const database = getDatabase();

  database
    .prepare(
      `UPDATE repositories
       SET last_sync_at = datetime('now'),
           last_sync_status = @status,
           last_error = @error,
           checksum = COALESCE(@checksum, checksum),
           updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, status, error: error ?? null, checksum: checksum ?? null });
}

/**
 * Persist freeform user notes for a repository. Notes are capped at 4000
 * characters server-side and stored as NULL when empty/whitespace-only.
 * Returns true when a row was updated.
 */
export const REPOSITORY_NOTES_MAX_LENGTH = 4000;

export function updateRepositoryNotes(id: number, notes: string | null): boolean {
  const database = getDatabase();
  let value: string | null = null;
  if (notes !== null && notes !== undefined) {
    const trimmed = notes.trim();
    if (trimmed.length > 0) {
      value =
        trimmed.length > REPOSITORY_NOTES_MAX_LENGTH
          ? trimmed.slice(0, REPOSITORY_NOTES_MAX_LENGTH)
          : trimmed;
    }
  }
  const result = database
    .prepare(
      `UPDATE repositories
          SET notes = @notes,
              updated_at = datetime('now')
        WHERE id = @id`,
    )
    .run({ id, notes: value });
  return result.changes > 0;
}

/**
 * Toggle the "exclude from future backups" flag. The repository stays in
 * the DB (so notes and history remain visible) but the backup engine skips
 * it entirely while the flag is set.
 */
export function setRepositorySkipBackup(id: number, skip: boolean): boolean {
  const database = getDatabase();
  const result = database
    .prepare(
      `UPDATE repositories
          SET skip_backup = @skip,
              updated_at = datetime('now')
        WHERE id = @id`,
    )
    .run({ id, skip: skip ? 1 : 0 });
  return result.changes > 0;
}

/**
 * Toggle per-repository verbose git tracing. When enabled, the next
 * clone/fetch for this repo runs with GIT_TRACE / GIT_CURL_VERBOSE /
 * GIT_TRACE_PACKET / GIT_TRACE_PERFORMANCE set and the child's stderr
 * is streamed to a timestamped log file under `{dataDir}/debug-logs/`.
 * Intended only for diagnosing transport failures on a specific repo;
 * the logs are verbose and may contain redacted-but-still-sensitive
 * protocol details.
 */
export function setRepositoryDebugTrace(id: number, enabled: boolean): boolean {
  const database = getDatabase();
  const result = database
    .prepare(
      `UPDATE repositories
          SET debug_trace = @enabled,
              updated_at = datetime('now')
        WHERE id = @id`,
    )
    .run({ id, enabled: enabled ? 1 : 0 });
  return result.changes > 0;
}

/**
 * Mark a repository as archived. Stores the path (relative to `backupsDir`)
 * of the archive ZIP produced for it. Archived repos are excluded from
 * discovery, the backup engine, and the default active-repos listing.
 */
export function archiveRepository(id: number, archivePath: string): boolean {
  const database = getDatabase();
  const result = database
    .prepare(
      `UPDATE repositories
          SET archived = 1,
              archived_at = datetime('now'),
              archive_path = @archivePath,
              updated_at = datetime('now')
        WHERE id = @id`,
    )
    .run({ id, archivePath });
  return result.changes > 0;
}

/** Reverse archive state. Does not restore any files on disk. */
export function unarchiveRepository(id: number): boolean {
  const database = getDatabase();
  const result = database
    .prepare(
      `UPDATE repositories
          SET archived = 0,
              archived_at = NULL,
              archive_path = NULL,
              updated_at = datetime('now')
        WHERE id = @id`,
    )
    .run({ id });
  return result.changes > 0;
}

/**
 * Permanently delete a repository row. Historical `backup_items` rows are
 * preserved for audit purposes with their `repository_id` set to NULL so
 * the FK does not block the delete.
 */
export function deleteRepository(id: number): boolean {
  const database = getDatabase();
  const tx = database.transaction((repoId: number) => {
    database
      .prepare('UPDATE backup_items SET repository_id = NULL WHERE repository_id = ?')
      .run(repoId);
    return database.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
  });
  const result = tx(id);
  return result.changes > 0;
}

/**
 * Look up the debug-trace flag by repo URL. Used by provider plugins that
 * only receive the URL (not the row id) when cloning or pulling.
 * Returns false when the repository is unknown or the flag is off.
 */
export function getRepositoryDebugTraceByUrl(url: string): {
  enabled: boolean;
  id: number | null;
} {
  const database = getDatabase();
  const row = database
    .prepare('SELECT id, debug_trace FROM repositories WHERE url = ?')
    .get(url) as { id: number; debug_trace: number } | undefined;
  if (!row) return { enabled: false, id: null };
  return { enabled: row.debug_trace === 1, id: row.id };
}

export interface RepositoryBackupHistoryEntry {
  item_id: number;
  run_id: number;
  status: string;
  error: string | null;
  checksum: string | null;
  zip_path: string | null;
  started_at: string | null;
  completed_at: string | null;
  run_started_at: string;
  run_status: string;
}

/**
 * Fetch a repository plus the most recent backup attempts for it, joined
 * with the owning run. Newest first.
 */
export function getRepositoryWithHistory(
  id: number,
  historyLimit = 20,
): { repo: Repository; history: RepositoryBackupHistoryEntry[] } | undefined {
  const database = getDatabase();
  const repo = database
    .prepare('SELECT * FROM repositories WHERE id = ?')
    .get(id) as Repository | undefined;
  if (!repo) return undefined;

  const history = database
    .prepare(
      `SELECT bi.id           AS item_id,
              bi.run_id        AS run_id,
              bi.status        AS status,
              bi.error         AS error,
              bi.checksum      AS checksum,
              bi.zip_path      AS zip_path,
              bi.started_at    AS started_at,
              bi.completed_at  AS completed_at,
              br.started_at    AS run_started_at,
              br.status        AS run_status
         FROM backup_items bi
         JOIN backup_runs br ON br.id = bi.run_id
        WHERE bi.repository_id = ?
        ORDER BY bi.id DESC
        LIMIT ?`,
    )
    .all(id, historyLimit) as RepositoryBackupHistoryEntry[];

  return { repo, history };
}

// ─── Backup runs ─────────────────────────────────────────────────────

export function createBackupRun(mode: string): BackupRun {
  const database = getDatabase();

  const result = database
    .prepare(
      `INSERT INTO backup_runs (started_at, status, backup_mode)
       VALUES (datetime('now'), 'running', @mode)`,
    )
    .run({ mode });

  return database
    .prepare('SELECT * FROM backup_runs WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as BackupRun;
}

export function updateBackupRun(id: number, updates: Partial<BackupRun>): void {
  const database = getDatabase();

  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  if (updates.completed_at !== undefined) {
    fields.push('completed_at = @completed_at');
    values.completed_at = updates.completed_at;
  }
  if (updates.status !== undefined) {
    fields.push('status = @status');
    values.status = updates.status;
  }
  if (updates.repos_total !== undefined) {
    fields.push('repos_total = @repos_total');
    values.repos_total = updates.repos_total;
  }
  if (updates.repos_success !== undefined) {
    fields.push('repos_success = @repos_success');
    values.repos_success = updates.repos_success;
  }
  if (updates.repos_failed !== undefined) {
    fields.push('repos_failed = @repos_failed');
    values.repos_failed = updates.repos_failed;
  }
  if (updates.repos_unavailable !== undefined) {
    fields.push('repos_unavailable = @repos_unavailable');
    values.repos_unavailable = updates.repos_unavailable;
  }
  if (updates.repos_skipped !== undefined) {
    fields.push('repos_skipped = @repos_skipped');
    values.repos_skipped = updates.repos_skipped;
  }
  if (updates.error_summary !== undefined) {
    fields.push('error_summary = @error_summary');
    values.error_summary = updates.error_summary;
  }
  if (updates.backup_mode !== undefined) {
    fields.push('backup_mode = @backup_mode');
    values.backup_mode = updates.backup_mode;
  }

  if (fields.length === 0) return;

  database
    .prepare(`UPDATE backup_runs SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function getLatestBackupRun(): BackupRun | undefined {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1')
    .get() as BackupRun | undefined;
}

export function getBackupRuns(limit = 20): BackupRun[] {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as BackupRun[];
}

// ─── Backup items ────────────────────────────────────────────────────

export function createBackupItem(item: {
  runId: number;
  repositoryId: number;
}): BackupItem {
  const database = getDatabase();

  const result = database
    .prepare(
      `INSERT INTO backup_items (run_id, repository_id, status, started_at)
       VALUES (@runId, @repositoryId, 'pending', datetime('now'))`,
    )
    .run({ runId: item.runId, repositoryId: item.repositoryId });

  return database
    .prepare('SELECT * FROM backup_items WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as BackupItem;
}

export function updateBackupItem(id: number, updates: Partial<BackupItem>): void {
  const database = getDatabase();

  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  if (updates.status !== undefined) {
    fields.push('status = @status');
    values.status = updates.status;
  }
  if (updates.error !== undefined) {
    fields.push('error = @error');
    values.error = updates.error;
  }
  if (updates.checksum !== undefined) {
    fields.push('checksum = @checksum');
    values.checksum = updates.checksum;
  }
  if (updates.zip_path !== undefined) {
    fields.push('zip_path = @zip_path');
    values.zip_path = updates.zip_path;
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = @completed_at');
    values.completed_at = updates.completed_at;
  }
  if (updates.started_at !== undefined) {
    fields.push('started_at = @started_at');
    values.started_at = updates.started_at;
  }

  if (fields.length === 0) return;

  database
    .prepare(`UPDATE backup_items SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function getBackupItems(runId: number): BackupItem[] {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM backup_items WHERE run_id = ? ORDER BY id')
    .all(runId) as BackupItem[];
}

/**
 * Delete a backup run and its per-repository items. Returns true if a row
 * was removed. Intended for cleaning up stuck or obsolete runs from the UI.
 */
export function deleteBackupRun(id: number): boolean {
  const database = getDatabase();
  const tx = database.transaction((runId: number) => {
    database.prepare('DELETE FROM backup_items WHERE run_id = ?').run(runId);
    return database.prepare('DELETE FROM backup_runs WHERE id = ?').run(runId);
  });
  const result = tx(id);
  return result.changes > 0;
}

/**
 * Mark any run still in the `running` state as failed. Used to reconcile
 * runs that were orphaned by a process crash or container restart.
 * Returns the number of rows updated.
 */
export function markStuckRunsFailed(reason = 'Process terminated before run completed'): number {
  const database = getDatabase();
  const result = database
    .prepare(
      `UPDATE backup_runs
          SET status = 'failed',
              completed_at = COALESCE(completed_at, datetime('now')),
              error_summary = COALESCE(error_summary, ?)
        WHERE status = 'running'`,
    )
    .run(reason);
  return result.changes;
}

// ─── Stats ───────────────────────────────────────────────────────────

export function getBackupStats(): BackupStats {
  const database = getDatabase();

  const totalRepos = (
    database.prepare('SELECT COUNT(*) as count FROM repositories').get() as {
      count: number;
    }
  ).count;

  const latestRun = database
    .prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1')
    .get() as BackupRun | undefined;

  const recentSuccess = database
    .prepare(
      `SELECT COUNT(*) as count FROM backup_runs
       WHERE status = 'success'
         AND completed_at >= datetime('now', '-24 hours')`,
    )
    .get() as { count: number };

  return {
    lastBackupAt: latestRun?.completed_at ?? latestRun?.started_at ?? null,
    totalRepos,
    lastRunStatus: latestRun?.status ?? null,
    hadRecentBackup: recentSuccess.count > 0,
    unavailableCount: (
      database
        .prepare(`SELECT COUNT(*) as count FROM repositories WHERE last_sync_status = 'unavailable'`)
        .get() as { count: number }
    ).count,
  };
}

export function getUnavailableRepositories(): Repository[] {
  const database = getDatabase();
  return database
    .prepare(
      `SELECT * FROM repositories WHERE last_sync_status = 'unavailable' ORDER BY owner, name`,
    )
    .all() as Repository[];
}
