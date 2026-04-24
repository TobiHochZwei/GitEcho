// tests/docs/lib/capture.ts
//
// Shared helpers for the documentation-screenshot specs.

import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCREENSHOT_DIR = 'docs/docs/assets/screenshots';

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Fonts + Bootstrap-icons + Chart.js animations.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

export async function shoot(
  page: Page,
  name: string,
  opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {},
): Promise<void> {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await settle(page);
  await page.screenshot({
    path,
    fullPage: opts.fullPage ?? true,
    clip: opts.clip,
    animations: 'disabled',
  });
  // eslint-disable-next-line no-console
  console.log(`  📸 ${path}`);
}
