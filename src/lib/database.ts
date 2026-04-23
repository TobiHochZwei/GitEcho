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
  error_summary: string | null;
  backup_mode: string;
}

export interface BackupItem {
  id: number;
  run_id: number;
  repository_id: number;
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
    error_summary TEXT,
    backup_mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backup_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES backup_runs(id),
    repository_id INTEGER NOT NULL REFERENCES repositories(id),
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
  // Example (do not uncomment — illustrative only):
  // (instance) => instance.exec(`CREATE INDEX idx_items_run ON backup_items(run_id)`),
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

  const stmt = database.prepare(`
    INSERT INTO repositories (url, provider, owner, name)
    VALUES (@url, @provider, @owner, @name)
    ON CONFLICT(url) DO UPDATE SET
      provider = excluded.provider,
      owner = excluded.owner,
      name = excluded.name,
      updated_at = datetime('now')
  `);

  const result = stmt.run(repo);
  const id =
    result.changes === 1 && result.lastInsertRowid
      ? Number(result.lastInsertRowid)
      : (database
          .prepare('SELECT id FROM repositories WHERE url = ?')
          .get(repo.url) as { id: number }).id;

  return getRepository(id)!;
}

export function getRepositories(provider?: string): Repository[] {
  const database = getDatabase();

  if (provider) {
    return database
      .prepare('SELECT * FROM repositories WHERE provider = ? ORDER BY owner, name')
      .all(provider) as Repository[];
  }

  return database
    .prepare('SELECT * FROM repositories ORDER BY owner, name')
    .all() as Repository[];
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
