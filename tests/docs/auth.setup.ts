// tests/docs/auth.setup.ts
//
// Logs in once with the demo credentials and persists the session cookie
// + the dark-theme localStorage entry to disk. All subsequent capture
// specs reuse that storage state so they don't re-authenticate.

import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_PATH = 'tests/docs/.auth/state.json';
const DEMO_USER = 'admin';
const DEMO_PASS = 'demo-password-123';

setup('authenticate + dark theme', async ({ page, context, baseURL }) => {
  mkdirSync(dirname(STATE_PATH), { recursive: true });

  // Hit /login first so localStorage exists for the origin, then seed the
  // theme key the app's theme.ts persists.
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('gitecho.theme', 'dark'));

  // Fill the visible login form rather than POSTing to /api/auth/login —
  // gives us a more realistic session and makes the screenshot of the
  // login page (taken in capture.spec.ts under a logged-out context) match.
  await page.fill('input[name="username"]', DEMO_USER);
  await page.fill('input[name="password"]', DEMO_PASS);
  await Promise.all([
    page.waitForURL(`${baseURL}/`),
    page.click('button[type="submit"]'),
  ]);

  await expect(page).toHaveURL(`${baseURL}/`);
  await context.storageState({ path: STATE_PATH });
});
