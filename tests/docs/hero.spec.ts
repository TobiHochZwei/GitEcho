// tests/docs/hero.spec.ts — 1920×1080 hero shot for README + index.md.

import { test } from '@playwright/test';
import { shoot, settle } from './lib/capture';

test('dashboard hero', async ({ page }) => {
  await page.goto('/');
  await settle(page);
  await shoot(page, 'dashboard-hero', { fullPage: false });
});
