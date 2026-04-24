// playwright.docs.config.ts
//
// Drives the documentation-screenshot workflow. NOT a test suite — every
// spec under tests/docs/ produces PNGs under docs/docs/assets/screenshots/
// instead of asserting application behaviour.
//
// Usage:
//   npm run docs:demo   (seed + screenshots)
//   npm run screenshots (assumes seed already done)
//
// The webServer block boots `npm run dev` against `.env.demo` on port 4173
// so it does not collide with a regular dev server on 3000.

import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Pull MASTER_KEY + DATA_DIR/CONFIG_DIR/BACKUPS_DIR from .env.demo so the
// webServer command inherits them. We parse the file manually to avoid
// adding a `dotenv` dependency just for the docs workflow.
try {
  const raw = readFileSync('.env.demo', 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // .env.demo is optional — when running `npm run screenshots` standalone
  // the env may already be exported in the shell. The webServer block
  // below will fail loudly if MASTER_KEY is still missing.
}

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/docs',
  // Single worker — captures must run in order (auth.setup → captures).
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'dark',
    deviceScaleFactor: 2,
  },
  projects: [
    {
      name: 'auth-setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'docs-1440',
      testMatch: /capture\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: 'tests/docs/.auth/state.json',
      },
    },
    {
      name: 'hero-1920',
      testMatch: /hero\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: 'tests/docs/.auth/state.json',
      },
    },
  ],
  webServer: {
    command: `npx astro dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATA_DIR: process.env.DATA_DIR ?? '.dev/demo/data',
      CONFIG_DIR: process.env.CONFIG_DIR ?? '.dev/demo/config',
      BACKUPS_DIR: process.env.BACKUPS_DIR ?? '.dev/demo/backups',
      MASTER_KEY: process.env.MASTER_KEY ?? '',
      PUBLIC_URL: BASE_URL,
      TZ: process.env.TZ ?? 'Europe/Berlin',
    },
  },
});
