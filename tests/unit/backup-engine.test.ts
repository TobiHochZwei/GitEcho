import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runBackup } from '../../src/lib/backup/engine.ts';
import { getBackupRuns, initDatabase } from '../../src/lib/database.ts';
import { getPluginRegistry, type ProviderPlugin } from '../../src/lib/plugins/interface.ts';

function fakePlugin(overrides: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    name: 'github',
    displayName: 'GitHub',
    isConfigured: () => true,
    authenticate: async () => true,
    listRepositories: async () => [],
    cloneRepository: async () => {},
    pullRepository: async () => {},
    getAuthenticatedUrl: (url) => url,
    ...overrides,
  };
}

describe('runBackup provider failures', () => {
  let dir: string;
  let db: ReturnType<typeof initDatabase>;
  const saved = {
    DATA_DIR: process.env.DATA_DIR,
    CONFIG_DIR: process.env.CONFIG_DIR,
    BACKUPS_DIR: process.env.BACKUPS_DIR,
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-engine-test-'));
    process.env.DATA_DIR = dir;
    process.env.CONFIG_DIR = dir;
    process.env.BACKUPS_DIR = path.join(dir, 'backups');
    db = initDatabase(dir);
  });

  afterEach(() => {
    db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the run partial_failure when authentication fails', async () => {
    getPluginRegistry().register(fakePlugin({ authenticate: async () => false }));

    const result = await runBackup();

    assert.equal(result.totalRepos, 0);
    assert.equal(result.failedCount, 1);
    assert.match(result.failures[0].error, /Authentication failed/);
    assert.equal(getBackupRuns(1)[0].status, 'partial_failure');
  });

  it('marks the run partial_failure when listing repositories throws', async () => {
    getPluginRegistry().register(
      fakePlugin({
        listRepositories: async () => {
          throw new Error('boom');
        },
      }),
    );

    const result = await runBackup();

    assert.equal(result.failedCount, 1);
    assert.match(result.failures[0].error, /boom/);
    assert.equal(getBackupRuns(1)[0].status, 'partial_failure');
  });
});
