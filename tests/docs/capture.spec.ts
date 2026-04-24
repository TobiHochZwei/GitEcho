// tests/docs/capture.spec.ts
//
// Captures every UI screen referenced by the docs at 1440×900 (dark theme).
// Output: docs/docs/assets/screenshots/*.png

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shoot, settle } from './lib/capture';

const DATA_DIR = process.env.DATA_DIR ?? '.dev/demo/data';
const DB_PATH = join(DATA_DIR, 'gitecho.db');
const BACKUPS_DIR = process.env.BACKUPS_DIR ?? '.dev/demo/backups';

function repoIdByName(name: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT id FROM repositories WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  db.close();
  if (!row) throw new Error(`No repo with name=${name}`);
  return row.id;
}

function runIdByStatus(status: string, offset = 0): number {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare('SELECT id FROM backup_runs WHERE status = ? ORDER BY id DESC')
    .all(status) as Array<{ id: number }>;
  db.close();
  if (!rows[offset]) throw new Error(`No run with status=${status} at offset ${offset}`);
  return rows[offset].id;
}

test.beforeEach(async ({ page }) => {
  // Make sure dark theme is on for every page (storageState already has it,
  // but localStorage is per-origin and can race with first paint).
  await page.addInitScript(() => {
    try {
      localStorage.setItem('gitecho.theme', 'dark');
    } catch {
      // ignore
    }
  });
});

test('login screen (logged out)', async ({ browser }) => {
  // Fresh context with no auth state so we hit the login page.
  const ctx = await browser.newContext({
    storageState: undefined,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  await page.goto('/login');
  await settle(page);
  await shoot(page, 'login');
  await ctx.close();
});

test('dashboard', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  await shoot(page, 'dashboard');
});

test('repos list', async ({ page }) => {
  await page.goto('/repos');
  await shoot(page, 'repos-list');
});

test('runs list', async ({ page }) => {
  await page.goto('/runs');
  await shoot(page, 'runs-list');
});

test('run detail — success', async ({ page }) => {
  const id = runIdByStatus('success');
  await page.goto(`/runs/${id}`);
  await shoot(page, 'run-detail-success');
});

test('run detail — partial failure', async ({ page }) => {
  const id = runIdByStatus('partial_failure');
  await page.goto(`/runs/${id}`);
  await shoot(page, 'run-detail-partial');
});

test('run detail — cancelled', async ({ page }) => {
  const id = runIdByStatus('cancelled');
  await page.goto(`/runs/${id}`);
  await shoot(page, 'run-detail-cancelled');
});

test('logs page', async ({ page }) => {
  await page.goto('/logs');
  await settle(page);
  await shoot(page, 'logs');
});

test('settings — general', async ({ page }) => {
  await page.goto('/settings/general');
  await shoot(page, 'settings-general');
});

test('settings — providers github', async ({ page }) => {
  await page.goto('/settings/providers');
  // Page shows all three providers stacked. Take full-page once for the
  // combined shot, then per-provider clips.
  await shoot(page, 'settings-providers');
  // Per-provider via element screenshot (cards have headings we can locate).
  for (const [name, heading] of [
    ['settings-providers-github', 'GitHub'],
    ['settings-providers-azuredevops', 'Azure DevOps'],
    ['settings-providers-gitlab', 'GitLab'],
  ] as const) {
    const card = page.locator('.card').filter({ has: page.locator(`text=${heading}`) }).first();
    if (await card.count()) {
      await card.scrollIntoViewIfNeeded();
      await settle(page);
      await card.screenshot({ path: `docs/docs/assets/screenshots/${name}.png`, animations: 'disabled' });
      // eslint-disable-next-line no-console
      console.log(`  📸 docs/docs/assets/screenshots/${name}.png`);
    }
  }
});

test('settings — smtp', async ({ page }) => {
  await page.goto('/settings/smtp');
  await shoot(page, 'settings-smtp');
});

test('settings — account', async ({ page }) => {
  await page.goto('/settings/account');
  await shoot(page, 'settings-account');
});

test('settings — account forced password change', async ({ page }) => {
  await page.goto('/settings/account?forceChange=1');
  await shoot(page, 'settings-account-forced');
});

test('settings — repos overview', async ({ page }) => {
  await page.goto('/settings/repos');
  await shoot(page, 'settings-repos');
});

test('settings — repos archived', async ({ page }) => {
  await page.goto('/settings/repos/archived');
  await shoot(page, 'settings-repos-archived');
});

test('repo detail — debug trace enabled', async ({ page }) => {
  const id = repoIdByName('rivendell-docs');
  await page.goto(`/settings/repos/${id}`);
  await settle(page);
  await shoot(page, 'repo-debug-trace-enabled');
});

test('repo detail — danger zone (archive + delete buttons)', async ({ page }) => {
  const id = repoIdByName('palantir-api');
  await page.goto(`/settings/repos/${id}`);
  // Scroll to danger zone so it's visible in a non-fullpage clip too.
  await page.locator('text=Danger zone').first().scrollIntoViewIfNeeded();
  await settle(page);
  await shoot(page, 'repo-detail');
});

test('archive confirm modal', async ({ page }) => {
  const id = repoIdByName('palantir-api');
  await page.goto(`/settings/repos/${id}`);
  await page.click('#archive-btn');
  // Type the name to enable the confirm button — gives a "ready to confirm" shot.
  await page.fill('#archive-confirm-input', 'palantir-api');
  await settle(page);
  await shoot(page, 'archive-confirm', { fullPage: false });
});

test('delete confirm modal', async ({ page }) => {
  const id = repoIdByName('joker-detector');
  await page.goto(`/settings/repos/${id}`);
  await page.click('#delete-btn');
  await page.fill('#delete-confirm-input', 'joker-detector');
  await settle(page);
  await shoot(page, 'delete-confirm', { fullPage: false });
});

test('debug log viewer (modal)', async ({ page }) => {
  const id = repoIdByName('rivendell-docs');
  await page.goto(`/settings/repos/${id}`);
  await settle(page);
  // The card auto-loads the file list. Click "View" on the first entry.
  const viewBtn = page.locator('#debug-logs-list >> text=View').first();
  if (await viewBtn.count()) {
    await viewBtn.click();
    await settle(page);
    await shoot(page, 'debug-log-viewer', { fullPage: false });
  } else {
    // Fall back: capture the list itself if no modal trigger is present.
    await shoot(page, 'debug-log-viewer');
  }
});

test('browse — option1 tree', async ({ page }) => {
  await page.goto('/browse/github/middle-earth-foundation/palantir-api');
  await shoot(page, 'browse-option1-tree');
});

test('browse — option1 file', async ({ page }) => {
  await page.goto('/browse/github/middle-earth-foundation/palantir-api/README.md');
  await shoot(page, 'browse-option1-file');
});

test('zips — option2', async ({ page }) => {
  await page.goto('/zips/github/middle-earth-foundation/palantir-api');
  await shoot(page, 'zips-option2');
});

test('zips — option3', async ({ page }) => {
  await page.goto('/zips/github/starfleet-command/holodeck-sdk/zips');
  await shoot(page, 'zips-option3');
});

test('dashboard — pat expiry warning', async ({ page }) => {
  // The seed already configures azureDevOps PAT to expire in 5 days — surfaces
  // the warning badge on the dashboard automatically.
  await page.goto('/');
  await settle(page);
  // Capture a tighter clip around the PAT-status banner.
  await shoot(page, 'pat-expiry-warning');
});

test('dashboard — unavailable banner', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  // Same dashboard already shows the unavailable banner because mordor-monitoring
  // is marked unavailable. Take the full page so the banner + KPIs are visible.
  await shoot(page, 'unavailable-banner');
});

test('repos cleanup preview', async ({ page }) => {
  // The cleanup endpoint surfaces redundant repos.txt entries. Hit /api/repos/cleanup
  // via UI: open /settings/repos and trigger the "Cleanup repos.txt" action if present.
  // Fallback: capture the API response in the network panel by hitting the URL.
  const response = await page.request.get('/api/repos/cleanup');
  if (response.ok()) {
    const data = await response.json();
    // Render a tiny standalone HTML doc that visualises the cleanup preview.
    await page.setContent(
      `<!doctype html><html data-bs-theme="dark"><head>
         <link rel="stylesheet" href="${process.env.PUBLIC_URL ?? 'http://localhost:4173'}/_astro/.dev/dummy.css" onerror="this.remove()" />
         <style>body{font-family:system-ui;padding:2rem;background:#1f2937;color:#e5e7eb}
         pre{background:#0b1220;padding:1rem;border-radius:.5rem;border:1px solid #1f2937;overflow:auto}
         h1{font-size:1.25rem}</style>
       </head><body>
         <h1>GET /api/repos/cleanup</h1>
         <p>Returns the URLs that <code>repos.txt</code> still pins but are already covered by the database (i.e. redundant extras).</p>
         <pre>${JSON.stringify(data, null, 2).replace(/</g, '&lt;')}</pre>
       </body></html>`,
    );
    await settle(page);
    await shoot(page, 'repos-cleanup', { fullPage: true });
  }
});

test('backup busy state', async ({ page }) => {
  // Fake a backup-busy by writing the lockfile directly. The dashboard's
  // "Quick actions" card flips its buttons + status text when the lock
  // is held.
  const fs = await import('node:fs');
  const lockPath = join(DATA_DIR, '.backup.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 99999, startedAt: new Date().toISOString(), runId: 1 }),
    'utf-8',
  );
  try {
    await page.goto('/');
    await settle(page);
    await shoot(page, 'backup-busy');
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test.skip('placeholder — backup files exist', () => {
  // Sanity check the seeder ran. Skipped in normal runs.
  expect(existsSync(BACKUPS_DIR)).toBeTruthy();
  expect(readdirSync(BACKUPS_DIR).length).toBeGreaterThan(0);
});
