// scripts/capture-masterkey-missing.ts
//
// Boots a separate Astro dev server with MASTER_KEY DELIBERATELY UNSET
// and captures the 503 boot page that the middleware renders. This is
// kept out of the main Playwright config because mixing two dev servers
// (one with a key, one without) under a single config is fragile.
//
// Usage:  tsx scripts/capture-masterkey-missing.ts

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const PORT = 4174;
const URL = `http://localhost:${PORT}`;
const SCRATCH = '.dev/demo-nokey';
const SCREENSHOT = 'docs/docs/assets/screenshots/masterkey-missing-503.png';

if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(`${SCRATCH}/data`, { recursive: true });
mkdirSync(`${SCRATCH}/config`, { recursive: true });
mkdirSync(`${SCRATCH}/backups`, { recursive: true });

const env = {
  ...process.env,
  DATA_DIR: `${SCRATCH}/data`,
  CONFIG_DIR: `${SCRATCH}/config`,
  BACKUPS_DIR: `${SCRATCH}/backups`,
  PUBLIC_URL: URL,
};
delete (env as Record<string, string | undefined>).MASTER_KEY;

const child = spawn('npx', ['astro', 'dev', '--port', String(PORT)], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: true,
});

let ready = false;
child.stdout.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf-8');
  process.stdout.write(text);
  if (text.includes(`localhost:${PORT}`)) ready = true;
});

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('astro dev never became ready');
  // Tiny additional buffer for the listener.
  await new Promise((r) => setTimeout(r, 500));
}

async function capture(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  mkdirSync('docs/docs/assets/screenshots', { recursive: true });
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  console.log(`📸 ${SCREENSHOT}`);
  await ctx.close();
  await browser.close();
}

try {
  await waitForReady();
  await capture();
} finally {
  child.kill('SIGINT');
}
