// scripts/seed-demo.ts
//
// Seed a fictional dataset into `.dev/demo/{data,config,backups}` so we
// can boot the app against it and capture documentation screenshots.
//
// Run with:   npm run seed:demo
//
// The script is idempotent — it wipes `.dev/demo/` first so successive
// runs always produce the same result. The MASTER_KEY (and the demo
// data dirs) come from `.env.demo`, which `tsx --env-file=.env.demo`
// loads before this script executes.
//
// Naming convention: every fictional repo is obviously fake (Middle-earth /
// Hogwarts / Starfleet / Wayne Enterprises / Rebel Alliance) so a
// reader of the docs immediately sees these are demo screenshots.

import archiver from 'archiver';
import bcrypt from 'bcryptjs';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { initDatabase, getDatabase } from '../src/lib/database.js';
import { encryptSecret } from '../src/lib/secrets.js';
import type { PersistedSecrets, PersistedSettings } from '../src/lib/settings.js';

// ─── env / paths ─────────────────────────────────────────────────────

if (!process.env.MASTER_KEY) {
  console.error('MASTER_KEY is not set. Did you copy .env.demo.example to .env.demo?');
  process.exit(1);
}

const DATA_DIR = resolve(process.env.DATA_DIR ?? '.dev/demo/data');
const CONFIG_DIR = resolve(process.env.CONFIG_DIR ?? '.dev/demo/config');
const BACKUPS_DIR = resolve(process.env.BACKUPS_DIR ?? '.dev/demo/backups');
const DEMO_ROOT = resolve('.dev/demo');

console.log(`[seed] DATA_DIR=${DATA_DIR}`);
console.log(`[seed] CONFIG_DIR=${CONFIG_DIR}`);
console.log(`[seed] BACKUPS_DIR=${BACKUPS_DIR}`);

// ─── 1. wipe + recreate ──────────────────────────────────────────────

if (existsSync(DEMO_ROOT)) {
  rmSync(DEMO_ROOT, { recursive: true, force: true });
}
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(CONFIG_DIR, { recursive: true });
mkdirSync(BACKUPS_DIR, { recursive: true });

// ─── 2. database ─────────────────────────────────────────────────────

const db = initDatabase(DATA_DIR);

// ─── helpers ─────────────────────────────────────────────────────────

function isoMinusDays(days: number, hour = 2, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function isoOffset(base: string, seconds: number): string {
  const d = new Date(base);
  d.setUTCSeconds(d.getUTCSeconds() + seconds);
  return d.toISOString();
}

function fakeChecksum(seed: string): string {
  // Deterministic 64-hex-char "SHA-256" so screenshots are reproducible.
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  let out = '';
  for (let i = 0; i < 8; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    out += (h1 >>> 0).toString(16).padStart(8, '0');
    out += (h2 >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

function writeText(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

async function zipFromEntries(
  outputPath: string,
  entries: Array<{ name: string; content: string }>,
): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  await new Promise<void>((resolveFn, rejectFn) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolveFn());
    output.on('error', rejectFn);
    archive.on('error', rejectFn);
    archive.pipe(output);
    for (const e of entries) archive.append(e.content, { name: e.name });
    void archive.finalize();
  });
}

// ─── 3. fictional repositories ───────────────────────────────────────

interface RepoSeed {
  url: string;
  provider: 'github' | 'azuredevops' | 'gitlab';
  owner: string;
  name: string;
  status: 'success' | 'failed' | 'unavailable' | 'pending';
  notes?: string;
  skipBackup?: boolean;
  debugTrace?: boolean;
  lastError?: string;
  archived?: boolean;
  /** Days ago the last sync happened. */
  lastSyncDaysAgo?: number;
}

const REPOS: RepoSeed[] = [
  // Middle-earth (GitHub)
  {
    url: 'https://github.com/middle-earth-foundation/palantir-api',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'palantir-api',
    status: 'success',
    notes: 'Long-distance scrying gateway. Owns the /vision endpoints.',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/middle-earth-foundation/the-one-ring',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'the-one-ring',
    status: 'success',
    notes:
      'Single-binding library. Exposes a forge() factory and a destroy() teardown — do not call destroy() in prod.',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/middle-earth-foundation/mordor-monitoring',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'mordor-monitoring',
    status: 'unavailable',
    lastError: 'Repository not found on GitHub (HTTP 404). It may have been deleted upstream.',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/middle-earth-foundation/rivendell-docs',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'rivendell-docs',
    status: 'success',
    debugTrace: true,
    notes: 'Verbose git tracing enabled while diagnosing intermittent fetch hangs over Tor proxy.',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/middle-earth-foundation/hobbit-shire-cli',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'hobbit-shire-cli',
    status: 'success',
    skipBackup: true,
    notes: 'Excluded from future backups — frozen at v1.0 and mirrored elsewhere.',
    lastSyncDaysAgo: 5,
  },
  {
    url: 'https://github.com/middle-earth-foundation/gandalf-auth',
    provider: 'github',
    owner: 'middle-earth-foundation',
    name: 'gandalf-auth',
    status: 'failed',
    lastError: 'fatal: unable to access: server certificate verification failed (CAfile mismatch)',
    lastSyncDaysAgo: 0,
  },

  // Hogwarts (GitHub)
  {
    url: 'https://github.com/hogwarts-school/spellbook-service',
    provider: 'github',
    owner: 'hogwarts-school',
    name: 'spellbook-service',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/hogwarts-school/daily-prophet-cms',
    provider: 'github',
    owner: 'hogwarts-school',
    name: 'daily-prophet-cms',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/hogwarts-school/horcrux-legacy-api',
    provider: 'github',
    owner: 'hogwarts-school',
    name: 'horcrux-legacy-api',
    status: 'success',
    archived: true,
    notes: 'Sunset 2025-Q4. Kept around for compliance — see archive ZIP.',
    lastSyncDaysAgo: 30,
  },

  // Starfleet (GitHub)
  {
    url: 'https://github.com/starfleet-command/warp-core-driver',
    provider: 'github',
    owner: 'starfleet-command',
    name: 'warp-core-driver',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://github.com/starfleet-command/holodeck-sdk',
    provider: 'github',
    owner: 'starfleet-command',
    name: 'holodeck-sdk',
    status: 'success',
    lastSyncDaysAgo: 0,
  },

  // Wayne Enterprises (Azure DevOps)
  {
    url: 'https://dev.azure.com/wayne-enterprises/gotham-apps/_git/bat-signal-service',
    provider: 'azuredevops',
    owner: 'gotham-apps',
    name: 'bat-signal-service',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://dev.azure.com/wayne-enterprises/gotham-apps/_git/wayne-tower-iot',
    provider: 'azuredevops',
    owner: 'gotham-apps',
    name: 'wayne-tower-iot',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://dev.azure.com/wayne-enterprises/arkham-research/_git/joker-detector',
    provider: 'azuredevops',
    owner: 'arkham-research',
    name: 'joker-detector',
    status: 'failed',
    lastError: 'TF401019: The Git repository with name or identifier joker-detector does not exist.',
    lastSyncDaysAgo: 0,
  },

  // Rebel Alliance (GitLab)
  {
    url: 'https://gitlab.com/rebel-alliance/millennium-falcon-nav',
    provider: 'gitlab',
    owner: 'rebel-alliance',
    name: 'millennium-falcon-nav',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://gitlab.com/rebel-alliance/death-star-plans',
    provider: 'gitlab',
    owner: 'rebel-alliance',
    name: 'death-star-plans',
    status: 'success',
    archived: true,
    notes: 'Mission accomplished. Kept for historical reference only.',
    lastSyncDaysAgo: 60,
  },
  {
    url: 'https://gitlab.com/rebel-alliance/x-wing-telemetry',
    provider: 'gitlab',
    owner: 'rebel-alliance',
    name: 'x-wing-telemetry',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
  {
    url: 'https://gitlab.com/rebel-alliance/rebel-comms-broker',
    provider: 'gitlab',
    owner: 'rebel-alliance',
    name: 'rebel-comms-broker',
    status: 'success',
    lastSyncDaysAgo: 0,
  },
];

// Insert repositories
const insertRepo = db.prepare(`
  INSERT INTO repositories (
    url, provider, owner, name,
    last_sync_at, last_sync_status, last_error, checksum,
    notes, skip_backup, debug_trace,
    archived, archived_at, archive_path,
    created_at, updated_at
  ) VALUES (
    @url, @provider, @owner, @name,
    @last_sync_at, @last_sync_status, @last_error, @checksum,
    @notes, @skip_backup, @debug_trace,
    @archived, @archived_at, @archive_path,
    @created_at, @updated_at
  )
`);

const repoIdByUrl = new Map<string, number>();
const baselineCreated = isoMinusDays(45, 9, 13);
const today = new Date();

for (const r of REPOS) {
  const lastSyncAt = r.lastSyncDaysAgo !== undefined
    ? isoMinusDays(r.lastSyncDaysAgo, 2, 17)
    : isoMinusDays(0, 2, 17);
  const archivePath = r.archived
    ? `_archived/${r.provider}/${r.owner}/${r.name}.zip`
    : null;
  const result = insertRepo.run({
    url: r.url,
    provider: r.provider,
    owner: r.owner,
    name: r.name,
    last_sync_at: lastSyncAt,
    last_sync_status: r.status,
    last_error: r.lastError ?? null,
    checksum: r.status === 'success' ? fakeChecksum(r.url) : null,
    notes: r.notes ?? null,
    skip_backup: r.skipBackup ? 1 : 0,
    debug_trace: r.debugTrace ? 1 : 0,
    archived: r.archived ? 1 : 0,
    archived_at: r.archived ? isoMinusDays(7, 11, 5) : null,
    archive_path: archivePath,
    created_at: baselineCreated,
    updated_at: lastSyncAt,
  });
  repoIdByUrl.set(r.url, Number(result.lastInsertRowid));
}

console.log(`[seed] inserted ${REPOS.length} repositories`);

// ─── 4. backup runs (30 days history) ────────────────────────────────

interface RunSeed {
  daysAgo: number;
  durationSec: number;
  status: 'success' | 'failed' | 'partial_failure' | 'cancelled' | 'unavailable';
  errorSummary?: string;
  cancellationRequested?: boolean;
  /** Repo URLs that should be marked failed in this run. */
  failedRepos?: string[];
  /** Repo URLs that should be marked unavailable in this run. */
  unavailableRepos?: string[];
  /** Repo URLs whose item should be skipped (e.g. partial cancellation). */
  skippedRepos?: string[];
}

// Build a 30-day history with realistic mix.
const RUNS: RunSeed[] = [];
for (let d = 29; d >= 0; d--) {
  if (d === 12) {
    RUNS.push({
      daysAgo: d,
      durationSec: 47,
      status: 'partial_failure',
      errorSummary: '1 repository failed during this run.',
      failedRepos: ['https://github.com/middle-earth-foundation/gandalf-auth'],
    });
  } else if (d === 8) {
    RUNS.push({
      daysAgo: d,
      durationSec: 19,
      status: 'cancelled',
      errorSummary: 'Cancelled by user',
      cancellationRequested: true,
      skippedRepos: REPOS.filter((r) => !r.archived && !r.skipBackup)
        .slice(8)
        .map((r) => r.url),
    });
  } else if (d === 5) {
    RUNS.push({
      daysAgo: d,
      durationSec: 31,
      status: 'partial_failure',
      errorSummary: '2 repositories failed; 1 unavailable upstream.',
      failedRepos: [
        'https://github.com/middle-earth-foundation/gandalf-auth',
        'https://dev.azure.com/wayne-enterprises/arkham-research/_git/joker-detector',
      ],
      unavailableRepos: ['https://github.com/middle-earth-foundation/mordor-monitoring'],
    });
  } else if (d === 3) {
    RUNS.push({
      daysAgo: d,
      durationSec: 4,
      status: 'failed',
      errorSummary:
        'GitHub PAT rejected: HTTP 401 Bad credentials. Check the token at /settings/providers.',
    });
  } else if (d === 1) {
    RUNS.push({
      daysAgo: d,
      durationSec: 38,
      status: 'partial_failure',
      errorSummary: '1 repository failed; 1 unavailable upstream.',
      failedRepos: ['https://github.com/middle-earth-foundation/gandalf-auth'],
      unavailableRepos: ['https://github.com/middle-earth-foundation/mordor-monitoring'],
    });
  } else if (d === 0) {
    RUNS.push({
      daysAgo: d,
      durationSec: 42,
      status: 'partial_failure',
      errorSummary: '1 repository failed; 1 unavailable upstream.',
      failedRepos: ['https://github.com/middle-earth-foundation/gandalf-auth'],
      unavailableRepos: ['https://github.com/middle-earth-foundation/mordor-monitoring'],
    });
  } else {
    // Normal successful nightly run.
    RUNS.push({
      daysAgo: d,
      durationSec: 28 + (d % 9) * 3,
      status: 'success',
    });
  }
}

const insertRun = db.prepare(`
  INSERT INTO backup_runs (
    started_at, completed_at, status,
    repos_total, repos_success, repos_failed, repos_unavailable, repos_skipped,
    error_summary, backup_mode, cancellation_requested
  ) VALUES (
    @started_at, @completed_at, @status,
    @repos_total, @repos_success, @repos_failed, @repos_unavailable, @repos_skipped,
    @error_summary, @backup_mode, @cancellation_requested
  )
`);

const insertItem = db.prepare(`
  INSERT INTO backup_items (
    run_id, repository_id, status, error, checksum, zip_path, started_at, completed_at
  ) VALUES (
    @run_id, @repository_id, @status, @error, @checksum, @zip_path, @started_at, @completed_at
  )
`);

const activeRepos = REPOS.filter((r) => !r.archived && !r.skipBackup);
const runIds: number[] = [];

for (const run of RUNS) {
  const startedAt = isoMinusDays(run.daysAgo, 2, 0);
  const completedAt = isoOffset(startedAt, run.durationSec);

  const failed = new Set(run.failedRepos ?? []);
  const unavailable = new Set(run.unavailableRepos ?? []);
  const skipped = new Set(run.skippedRepos ?? []);

  const items: Array<{
    repo: RepoSeed;
    status: string;
    error: string | null;
    checksum: string | null;
    zipPath: string | null;
    startedAt: string;
    completedAt: string | null;
  }> = [];

  let cursor = startedAt;
  let succ = 0;
  let fail = 0;
  let unav = 0;
  let skip = 0;

  for (const repo of activeRepos) {
    if (skipped.has(repo.url)) {
      // Cancelled before reaching this repo — emit no item row, count as skipped.
      skip += 1;
      continue;
    }
    const itemDur = 1 + Math.floor(Math.random() * 4);
    const itemStarted = cursor;
    const itemEnd = isoOffset(itemStarted, itemDur);
    cursor = itemEnd;

    let status: string;
    let error: string | null = null;
    let checksum: string | null = null;
    let zipPath: string | null = null;

    if (failed.has(repo.url)) {
      status = 'failed';
      error = repo.lastError ?? 'Backup failed';
      fail += 1;
    } else if (unavailable.has(repo.url)) {
      status = 'unavailable';
      error = repo.lastError ?? 'Repository unavailable upstream';
      unav += 1;
    } else if (run.status === 'failed') {
      status = 'failed';
      error = 'Run aborted before this repository was processed.';
      fail += 1;
    } else {
      status = 'success';
      checksum = fakeChecksum(`${repo.url}@${run.daysAgo}`);
      zipPath = `${repo.provider}/${repo.owner}/${repo.name}/${startedAt
        .replace(/[:.]/g, '-')
        .replace('Z', '')}.zip`;
      succ += 1;
    }

    items.push({
      repo,
      status,
      error,
      checksum,
      zipPath,
      startedAt: itemStarted,
      completedAt: itemEnd,
    });
  }

  const result = insertRun.run({
    started_at: startedAt,
    completed_at: run.status === 'failed' ? isoOffset(startedAt, run.durationSec) : completedAt,
    status: run.status,
    repos_total: activeRepos.length,
    repos_success: succ,
    repos_failed: fail,
    repos_unavailable: unav,
    repos_skipped: skip,
    error_summary: run.errorSummary ?? null,
    backup_mode: 'option2',
    cancellation_requested: run.cancellationRequested ? 1 : 0,
  });
  const runId = Number(result.lastInsertRowid);
  runIds.push(runId);

  for (const it of items) {
    insertItem.run({
      run_id: runId,
      repository_id: repoIdByUrl.get(it.repo.url) ?? null,
      status: it.status,
      error: it.error,
      checksum: it.checksum,
      zip_path: it.zipPath,
      started_at: it.startedAt,
      completed_at: it.completedAt,
    });
  }
}

console.log(`[seed] inserted ${RUNS.length} backup runs`);

// ─── 5. on-disk artefacts ────────────────────────────────────────────

// Option1-style cloned tree for /browse demo.
function seedOption1Tree(provider: string, owner: string, name: string): void {
  const base = join(BACKUPS_DIR, provider, owner, name);
  writeText(
    join(base, 'README.md'),
    `# ${name}\n\nFictional repository used for the GitEcho documentation screenshots.\n\nThis content is intentionally generic and contains no functional code.\n`,
  );
  writeText(
    join(base, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '1.4.2',
        description: 'Demo manifest — fictional package, do not install.',
        license: 'MIT',
      },
      null,
      2,
    ),
  );
  writeText(
    join(base, 'src', 'index.ts'),
    `// ${name} — demo source file used only for screenshots.\nexport function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
  );
  writeText(
    join(base, 'src', 'lib', 'utils.ts'),
    `export const PI_FAKE = 3.14;\nexport const VERSION = '1.4.2';\n`,
  );
  writeText(
    join(base, 'docs', 'CHANGELOG.md'),
    `# Changelog\n\n## 1.4.2 — fictional release\n- This file is part of the GitEcho demo dataset.\n`,
  );
  writeText(
    join(base, '.git', 'HEAD'),
    `ref: refs/heads/main\n`,
  );
  writeText(
    join(base, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.invalid/${owner}/${name}.git\n`,
  );
}

// Pick a couple of repos to materialise as option1 trees (those will
// drive the /browse screenshots even though backup mode is option2 —
// having both shapes on disk lets us screenshot both modes).
seedOption1Tree('github', 'middle-earth-foundation', 'palantir-api');
seedOption1Tree('github', 'middle-earth-foundation', 'the-one-ring');
seedOption1Tree('github', 'starfleet-command', 'warp-core-driver');

// Option2 ZIPs for active repos.
async function seedOption2Zips(): Promise<void> {
  for (const r of REPOS) {
    if (r.archived || r.skipBackup || r.status !== 'success') continue;
    const dir = join(BACKUPS_DIR, r.provider, r.owner, r.name);
    for (let i = 0; i < 3; i++) {
      const stamp = isoMinusDays(i, 2, 0).replace(/[:.]/g, '-').replace('Z', '');
      const zipPath = join(dir, `${stamp}.zip`);
      await zipFromEntries(zipPath, [
        {
          name: `${r.name}/README.md`,
          content: `# ${r.name}\n\nDemo backup for ${r.provider}/${r.owner}/${r.name}.\n`,
        },
        {
          name: `${r.name}/src/index.ts`,
          content: `export const REPO = '${r.name}';\n`,
        },
      ]);
    }
  }
}

// Option3 mirror + zips for one starfleet repo.
async function seedOption3(): Promise<void> {
  const r = REPOS.find((x) => x.name === 'holodeck-sdk')!;
  const base = join(BACKUPS_DIR, r.provider, r.owner, r.name);
  // mirror dir (bare-clone shape)
  writeText(
    join(base, 'mirror', 'HEAD'),
    `ref: refs/heads/main\n`,
  );
  writeText(
    join(base, 'mirror', 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tbare = true\n`,
  );
  writeText(
    join(base, 'mirror', 'description'),
    `Unnamed repository; edit this file 'description' to name the repository.\n`,
  );
  writeText(join(base, 'mirror', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n`);
  // zips subdir
  for (let i = 0; i < 3; i++) {
    const stamp = isoMinusDays(i, 2, 0).replace(/[:.]/g, '-').replace('Z', '');
    await zipFromEntries(join(base, 'zips', `${stamp}.zip`), [
      { name: `${r.name}/README.md`, content: `# ${r.name}\nDemo option3 backup.\n` },
    ]);
  }
}

// Archive ZIPs for archived repos.
async function seedArchives(): Promise<void> {
  for (const r of REPOS) {
    if (!r.archived) continue;
    const dest = join(BACKUPS_DIR, '_archived', r.provider, r.owner, `${r.name}.zip`);
    await zipFromEntries(dest, [
      {
        name: `${r.name}/README.md`,
        content: `# ${r.name}\n\nArchived demo repository — preserved for historical reference.\n`,
      },
      {
        name: `${r.name}/NOTICE.md`,
        content: `This is a fictional archive used for GitEcho documentation screenshots.\n`,
      },
    ]);
  }
}

// Debug-log file for the rivendell-docs repo.
function seedDebugLog(): void {
  const repoId = repoIdByUrl.get('https://github.com/middle-earth-foundation/rivendell-docs');
  if (!repoId) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const path = join(DATA_DIR, 'debug-logs', `repo-${repoId}`, `${stamp}.log`);
  const content = [
    `[demo] verbose git trace for middle-earth-foundation/rivendell-docs`,
    `09:13:11.421 git.c:460               trace: built-in: git fetch --tags --prune origin`,
    `09:13:11.502 run-command.c:670       trace: run_command: GIT_DIR=.git git-remote-https origin https://github.com/middle-earth-foundation/rivendell-docs.git`,
    `09:13:11.512 http.c:756              == Info: Trying 140.82.121.4:443...`,
    `09:13:11.671 http.c:756              == Info: Connected to github.com (140.82.121.4) port 443`,
    `09:13:11.673 http.c:756              == Info: ALPN, server accepted to use h2`,
    `09:13:11.692 http.c:756              == Info: Server certificate: github.com`,
    `09:13:11.701 http.c:756              == Info: Using HTTP2, server supports multiplexing`,
    `09:13:11.910 http.c:756              == Info: Connection #0 to host github.com left intact`,
    `09:13:12.045 fetch-pack.c:181        == server says: 0008NAK`,
    `09:13:12.046 fetch-pack.c:920        == have 1 commits, want 0; haves match`,
    `09:13:12.130 transport.c:1488        == fetch-pack: pack already up to date`,
    `09:13:12.140 trace.c:1                == git fetch finished in 0.72s`,
    ``,
  ].join('\n');
  writeText(path, content);
}

// ─── 6. settings + secrets ───────────────────────────────────────────

function patExpiresIso(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

const settings: PersistedSettings = {
  backupMode: 'option2',
  cronSchedule: '0 2 * * *',
  cronTimezone: 'Europe/Berlin',
  cronEnabled: true,
  runBackupOnStart: false,
  notifyOnSuccess: false,
  patExpiryWarnDays: 14,
  logLevel: 'info',
  github: {
    patExpires: patExpiresIso(120),
    autoDiscover: true,
    autoCleanupReposTxt: true,
    notifyOnNewRepo: true,
    filters: { visibility: 'all' },
    excludedUrls: ['https://github.com/middle-earth-foundation/sauron-internal-tools'],
  },
  azureDevOps: {
    patExpires: patExpiresIso(5), // ⚠ surfaces PAT-expiry warning badge
    autoDiscover: true,
    autoCleanupReposTxt: true,
    notifyOnNewRepo: true,
    org: 'wayne-enterprises',
    filters: { visibility: 'all' },
    excludedUrls: [],
  },
  gitlab: {
    patExpires: patExpiresIso(85),
    autoDiscover: true,
    autoCleanupReposTxt: true,
    notifyOnNewRepo: true,
    host: 'gitlab.com',
    filters: { visibility: 'all' },
    excludedUrls: ['https://gitlab.com/empire-archive/super-secret-stuff'],
  },
  smtp: {
    host: 'smtp.mordor.example',
    port: 587,
    user: 'sauron@mordor.example',
    from: 'gitecho-demo@mordor.example',
    to: 'ops@middle-earth-foundation.example',
  },
  ui: {
    username: 'admin',
    mustChangePassword: false,
    passwordUpdatedAt: new Date().toISOString(),
  },
};

writeFileSync(join(CONFIG_DIR, 'settings.json'), JSON.stringify(settings, null, 2), {
  encoding: 'utf-8',
  mode: 0o600,
});

// Encrypted secrets — fake PATs + fake SMTP password + bcrypt of demo password.
const DEMO_PASSWORD = 'demo-password-123';
const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 12);

const secrets: PersistedSecrets = {
  'github.pat': encryptSecret('ghp_demo_FakeFakeFakeFakeFakeFakeFakeFake1234'),
  'azureDevOps.pat': encryptSecret('demo-fake-azuredevops-pat-do-not-use'),
  'gitlab.pat': encryptSecret('glpat-demo-FakeFakeFakeFakeFakeFake'),
  'smtp.pass': encryptSecret('demo-smtp-password'),
  'ui.passwordHash': encryptSecret(passwordHash),
};

writeFileSync(join(CONFIG_DIR, 'secrets.json'), JSON.stringify(secrets, null, 2), {
  encoding: 'utf-8',
  mode: 0o600,
});

// repos.txt — keep one redundant pin to drive the cleanup-modal screenshot.
writeFileSync(
  join(CONFIG_DIR, 'repos.txt'),
  [
    '# GitEcho repos.txt — one URL per line, comments start with #',
    '',
    '# Pinned extras (will surface in the "cleanup" modal once they are also discovered):',
    'https://github.com/middle-earth-foundation/palantir-api',
    'https://github.com/hogwarts-school/spellbook-service',
    '',
    '# A repo we still want backed up but is not auto-discoverable by the PAT scope:',
    'https://github.com/dagobah-research/yoda-meditation-toolkit',
    '',
  ].join('\n'),
  { encoding: 'utf-8' },
);

// ─── 7. log file ─────────────────────────────────────────────────────

function seedLogFile(): void {
  const logPath = join(DATA_DIR, 'gitecho.log');
  const lines: string[] = [];
  for (let d = 6; d >= 0; d--) {
    const start = isoMinusDays(d, 2, 0);
    lines.push(
      JSON.stringify({
        ts: start,
        level: 'info',
        source: 'worker',
        msg: `[scheduler] cron tick — starting backup cycle (mode=option2)`,
      }),
    );
    lines.push(
      JSON.stringify({
        ts: isoOffset(start, 1),
        level: 'debug',
        source: 'worker',
        msg: `[backup] discovered 18 repositories across 3 providers`,
      }),
    );
    lines.push(
      JSON.stringify({
        ts: isoOffset(start, 4),
        level: 'info',
        source: 'worker',
        msg: `[backup] middle-earth-foundation/palantir-api: cloned 1.2 MB in 0.4 s`,
      }),
    );
    if (d === 5 || d === 12 || d === 1 || d === 0) {
      lines.push(
        JSON.stringify({
          ts: isoOffset(start, 7),
          level: 'warn',
          source: 'worker',
          msg: `[backup] middle-earth-foundation/mordor-monitoring: upstream returned 404 — marking unavailable`,
        }),
      );
      lines.push(
        JSON.stringify({
          ts: isoOffset(start, 8),
          level: 'error',
          source: 'worker',
          msg: `[backup] middle-earth-foundation/gandalf-auth: fatal: server certificate verification failed (CAfile mismatch)`,
        }),
      );
    }
    lines.push(
      JSON.stringify({
        ts: isoOffset(start, 30),
        level: 'info',
        source: 'worker',
        msg: `[backup] cycle finished — success=15 failed=1 unavailable=1 skipped=1`,
      }),
    );
    lines.push(
      JSON.stringify({
        ts: isoOffset(start, 31),
        level: 'info',
        source: 'server',
        msg: `[stats] storage usage refreshed (124.7 MB across 3 providers)`,
      }),
    );
  }
  writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
}

// ─── run async tasks ─────────────────────────────────────────────────

async function main(): Promise<void> {
  await seedOption2Zips();
  await seedOption3();
  await seedArchives();
  seedDebugLog();
  seedLogFile();
  console.log(`[seed] on-disk artefacts written under ${BACKUPS_DIR}`);
  console.log(`[seed] demo password: ${DEMO_PASSWORD}`);
  console.log(`[seed] done.`);
}

await main();
