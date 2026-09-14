import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  createBackupItem,
  createBackupRun,
  deleteBackupRun,
  deleteRepository,
  getBackupItems,
  getBackupRuns,
  getRepository,
  initDatabase,
  updateBackupItem,
  upsertRepository,
} from '../../src/lib/database.ts';

const repository = {
  url: 'https://example.test/owner/repo.git',
  provider: 'github',
  owner: 'owner',
  name: 'repo',
};

describe('database compatibility', () => {
  let dir: string;
  let db: Database.Database | undefined;
  const originalDataDir = process.env.DATA_DIR;
  const originalConfigDir = process.env.CONFIG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-database-test-'));
    process.env.DATA_DIR = dir;
    process.env.CONFIG_DIR = dir;
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalConfigDir === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = originalConfigDir;
  });

  it('initializes and reopens a WAL database without losing records', () => {
    db = initDatabase(dir);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
    const repo = upsertRepository(repository);
    db.close();

    db = initDatabase(dir);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
    assert.deepEqual(getRepository(repo.id), repo);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  });

  it('migrates a populated legacy schema and preserves backup history', () => {
    const legacy = new Database(path.join(dir, 'gitecho.db'));
    try {
      legacy.exec(readFileSync(new URL('../fixtures/legacy-database.sql', import.meta.url), 'utf8'));
      assert.equal(legacy.pragma('user_version', { simple: true }), 0);
    } finally {
      legacy.close();
    }

    db = initDatabase(dir);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
    const repo = getRepository(42);
    assert.ok(repo);
    assert.equal(repo.name, 'repo');
    assert.equal(repo.vcs_type, 'git');
    assert.equal(repo.remote_path, null);
    assert.equal(repo.is_private, null);
    assert.equal(repo.skip_backup, 0);
    assert.equal(repo.archived, 0);
    const [item] = getBackupItems(7);
    assert.equal(item.id, 9);
    assert.equal(item.checksum, 'legacy-checksum');
    assert.equal(item.source_metadata, null);
    assert.equal(deleteRepository(42), true);
    assert.equal(getBackupItems(7)[0].repository_id, null);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('returns the original upserted ID after another row was inserted', () => {
    db = initDatabase(dir);
    const first = upsertRepository({
      ...repository,
      vcsType: 'tfvc',
      remotePath: '$/Repo/Main',
      isPrivate: true,
    });
    const second = upsertRepository({ ...repository, url: `${repository.url}/other`, name: 'other' });
    const updated = upsertRepository({ ...repository, name: 'renamed' });

    assert.notEqual(first.id, second.id);
    assert.equal(updated.id, first.id);
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.vcs_type, 'tfvc');
    assert.equal(updated.remote_path, '$/Repo/Main');
    assert.equal(updated.is_private, 1);
    assert.equal(getRepository(second.id)?.name, 'other');
  });

  it('binds values and NULLs while returning numeric run and item IDs', () => {
    db = initDatabase(dir);
    const repo = upsertRepository(repository);
    const run = createBackupRun('option1');
    const item = createBackupItem({ runId: run.id, repositoryId: repo.id });
    assert.equal(typeof run.id, 'number');
    assert.equal(typeof item.id, 'number');
    assert.ok(run.id > 0 && item.id > 0);
    assert.equal(item.run_id, run.id);
    updateBackupItem(item.id, { status: 'failed', error: "can't read", checksum: 'checksum' });
    assert.equal(getBackupItems(run.id)[0].error, "can't read");
    updateBackupItem(item.id, { status: 'success', error: null, checksum: null });
    assert.equal(getBackupItems(run.id)[0].error, null);
    assert.equal(getBackupItems(run.id)[0].checksum, null);
  });

  it('rejects foreign-key violations without leaving an item behind', () => {
    db = initDatabase(dir);
    const run = createBackupRun('option1');
    assert.throws(
      () => createBackupItem({ runId: run.id, repositoryId: 9999 }),
      { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
    );
    assert.deepEqual(getBackupItems(run.id), []);
  });

  it('rolls back both steps when a repository deletion fails', () => {
    db = initDatabase(dir);
    const repo = upsertRepository(repository);
    const run = createBackupRun('option1');
    createBackupItem({ runId: run.id, repositoryId: repo.id });
    db.exec(`
      CREATE TRIGGER reject_repository_delete BEFORE DELETE ON repositories
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END;
    `);
    assert.throws(() => deleteRepository(repo.id), /test rollback/);
    assert.ok(getRepository(repo.id));
    assert.equal(getBackupItems(run.id)[0].repository_id, repo.id);
    assert.equal(db.inTransaction, false);
  });

  it('deletes a run and its items without deleting the repository', () => {
    db = initDatabase(dir);
    const repo = upsertRepository(repository);
    const run = createBackupRun('option1');
    createBackupItem({ runId: run.id, repositoryId: repo.id });
    assert.equal(deleteBackupRun(run.id), true);
    assert.deepEqual(getBackupItems(run.id), []);
    assert.deepEqual(getBackupRuns(), []);
    assert.ok(getRepository(repo.id));
  });

  it('keeps uncommitted changes invisible to a second WAL connection', () => {
    db = initDatabase(dir);
    const reader = new Database(path.join(dir, 'gitecho.db'));
    try {
      const count = reader.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM repositories');
      db.transaction(() => {
        upsertRepository(repository);
        assert.equal(count.get()?.count, 0);
      })();
      assert.equal(count.get()?.count, 1);
    } finally {
      reader.close();
    }
  });
});
