// tests/docs/masterkey-missing.spec.ts
//
// Boots a separate dev server with MASTER_KEY unset (configured in the
// `masterkey-missing` Playwright project) and captures the 503 page that
// the middleware renders for any path before checking auth.

import { test } from '@playwright/test';
import { shoot } from './lib/capture';

test('master key missing — 503 boot page', async ({ page }) => {
  await page.goto('/');
  // The middleware returns a static HTML page; no JS to wait on.
  await page.waitForLoadState('domcontentloaded');
  await shoot(page, 'masterkey-missing-503');
});
