import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

// ── Isolate config/storage to a throwaway temp directory ──────────────
const workDir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-tfvc-test-'));
const dataDir = path.join(workDir, 'data');
const configDir = path.join(workDir, 'config');
const backupsDir = path.join(workDir, 'backups');

process.env.DATA_DIR = dataDir;
process.env.CONFIG_DIR = configDir;
process.env.BACKUPS_DIR = backupsDir;
process.env.AZUREDEVOPS_PAT = 'test-pat';
process.env.AZUREDEVOPS_PAT_EXPIRES = '2099-01-01';

import { backupTfvcSnapshot } from '../../src/lib/backup/tfvc.ts';
import {
  createBackupItem,
  createBackupRun,
  initDatabase,
  updateBackupItem,
  updateRepositorySync,
  upsertRepository,
} from '../../src/lib/database.ts';
import { buildTfvcIdentifier } from '../../src/lib/tfvc-identifier.ts';

const REPO_URL = buildTfvcIdentifier('contoso', 'PaymentsApp', '$/PaymentsApp/Main');
const repoArg = {
  url: REPO_URL,
  provider: 'azuredevops',
  owner: 'contoso/PaymentsApp',
  name: 'Main',
  remotePath: '$/PaymentsApp/Main',
};

interface FakeResponseInit {
  ok: boolean;
  status?: number;
  contentType?: string;
  json?: unknown;
  body?: Uint8Array;
  text?: string;
}

function fakeResponse(init: FakeResponseInit): Response {
  const headers = new Map<string, string>();
  if (init.contentType) headers.set('content-type', init.contentType);
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => init.json,
    text: async () => init.text ?? '',
    arrayBuffer: async () => (init.body ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

const changesetResponse = (id: number) =>
  fakeResponse({
    ok: true,
    contentType: 'application/json',
    json: {
      value: [
        { changesetId: id, author: { displayName: 'Dev' }, comment: 'msg', createdDate: '2026-05-27T00:00:00Z' },
      ],
    },
  });

function isChangesetUrl(url: string): boolean {
  return url.includes('/_apis/tfvc/changesets');
}

before(() => {
  initDatabase(dataDir);
});

after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // The SQLite handle may still hold the db file open on Windows; the OS
    // temp dir is reclaimed eventually, so a failed cleanup is non-fatal.
  }
});

beforeEach(() => {
  mock.restoreAll();
});

describe('backupTfvcSnapshot', () => {
  it('rejects a malformed identifier without calling the network', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('network should not be called');
    });
    const result = await backupTfvcSnapshot({ ...repoArg, url: 'not-a-tfvc-id' }, backupsDir);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Invalid TFVC repository identifier/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('downloads a snapshot and records the changeset revision', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (isChangesetUrl(url)) return changesetResponse(42);
      return fakeResponse({
        ok: true,
        contentType: 'application/zip',
        body: new Uint8Array([1, 2, 3, 4]),
      });
    });

    const result = await backupTfvcSnapshot(repoArg, backupsDir);
    assert.equal(result.success, true);
    assert.equal(result.sourceRevision, '42');
    assert.equal(result.artifactKind, 'snapshot');
    assert.ok(result.zipPath, 'expected a written snapshot path');
    assert.ok(existsSync(result.zipPath!), 'snapshot file should exist on disk');

    const snapshotsDir = path.join(backupsDir, 'azuredevops', 'contoso/PaymentsApp', 'Main', 'snapshots');
    const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.zip'));
    assert.equal(files.length, 1);
  });

  it('maps 401/403/404 responses to unavailable', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (isChangesetUrl(url)) return changesetResponse(7);
      return fakeResponse({ ok: false, status: 403, text: 'Forbidden' });
    });

    const result = await backupTfvcSnapshot(repoArg, backupsDir);
    assert.equal(result.success, false);
    assert.equal(result.unavailable, true);
    assert.equal(result.sourceRevision, '7');
  });

  it('fails when the export returns JSON instead of an archive', async () => {
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (isChangesetUrl(url)) return changesetResponse(8);
      return fakeResponse({
        ok: true,
        contentType: 'application/json',
        text: '{"message":"path not found"}',
      });
    });

    const result = await backupTfvcSnapshot(repoArg, backupsDir);
    assert.equal(result.success, false);
    assert.notEqual(result.unavailable, true);
    assert.match(result.error ?? '', /JSON instead of an archive/);
  });

  it('skips the export when the changeset is unchanged since the last success', async () => {
    // Seed a prior successful backup at changeset 99 with a known checksum.
    const repo = upsertRepository({
      url: REPO_URL,
      provider: 'azuredevops',
      owner: 'contoso/PaymentsApp',
      name: 'Main',
      vcsType: 'tfvc',
      remotePath: '$/PaymentsApp/Main',
    });
    updateRepositorySync(repo.id, 'success', undefined, 'cached-checksum');
    const run = createBackupRun('option1');
    const item = createBackupItem({ runId: run.id, repositoryId: repo.id });
    updateBackupItem(item.id, { status: 'success', source_revision: '99' });

    let itemsCalled = false;
    mock.method(globalThis, 'fetch', async (url: string) => {
      if (isChangesetUrl(url)) return changesetResponse(99);
      itemsCalled = true;
      return fakeResponse({ ok: true, contentType: 'application/zip', body: new Uint8Array([9]) });
    });

    const result = await backupTfvcSnapshot(repoArg, backupsDir);
    assert.equal(result.success, true);
    assert.equal(result.sourceRevision, '99');
    assert.equal(result.checksum, 'cached-checksum');
    assert.equal(result.zipPath, undefined, 'no new snapshot should be written');
    assert.equal(itemsCalled, false, 'the items/download endpoint must not be hit');
  });
});
