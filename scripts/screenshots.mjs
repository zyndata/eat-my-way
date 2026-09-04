#!/usr/bin/env node
/**
 * Take the README screenshots against a running build.
 *
 * Kept as a script rather than a test because it asserts nothing — it drives the app the way
 * a first-time user would, on a phone-sized viewport, and writes PNGs into `docs/screenshots/`.
 * Re-run it whenever a screen changes enough that the README lies.
 *
 *   npm run docker:up          # or: npx vite preview --port 4173
 *   npm run screenshots        # override the target with BASE_URL=…
 *
 * Chromium comes from the Playwright the e2e suite already depends on; no new package.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 400, height: 820 },
  deviceScaleFactor: 2,
  locale: 'pl-PL'
});
const page = await context.newPage();

async function shot(name) {
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
  console.log(`docs/screenshots/${name}.png`);
}

// A browser that has never been used meets the first-run wizard, which pushes itself over
// whatever route was asked for (STATE.md decision 193). Skipping it writes `setupDone`, so the
// rest of the walk sees the app a returning user sees — the same move the e2e fixture makes.
await page.goto(`${BASE_URL}/#/`);
const skipSetup = page.getByRole('button', { name: 'Pomiń kreator' });
await skipSetup.waitFor({ state: 'visible' });
await skipSetup.click();

await page.goto(`${BASE_URL}/#/recipes`);
// The bundled USDA subset is imported on first run; the autocomplete is empty until it lands.
await page.waitForFunction(() => document.body.textContent?.includes('Nowy przepis') === true);

// An empty library is a screen worth showing — it is what a new user actually meets.
await shot('library-empty');

// One recipe, so the rest of the walk has something to plan.
await page.goto(`${BASE_URL}/#/recipes/new/edit`);
await page.getByLabel('Nazwa').fill('Owsianka z jajkiem');
await page.getByRole('button', { name: 'Dodaj składnik' }).click();
await page.getByLabel('Składnik 1').fill('jajko');
await page.getByRole('option').first().click();
await page.getByLabel('Ilość').first().fill('120');
await shot('recipe-editor');
await page.getByRole('button', { name: 'Zapisz przepis' }).click();

await page.goto(`${BASE_URL}/#/`);
await page.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
await page.getByRole('button', { name: /Owsianka/ }).click();
await shot('day');

await page.getByRole('link', { name: /Owsianka/ }).first().click();
await shot('meal');

await context.close();
await browser.close();
