import type { Page } from '@playwright/test';
import { expect, nutritionReady, test } from './fixtures';
import { recipe, seedAccount } from './seed';

/**
 * The one spec that races the first-run nutrition import on purpose.
 *
 * Every other spec waits for the import to settle before it acts, which is what makes the rest
 * of the suite honest (phase 21 task 4). This one does the opposite, because the overlap is
 * the defect: while a fresh browser writes the 1 344 bundled ingredients — a fifth of a second
 * on Chromium, twenty seconds under Playwright's WebKit — a Drive sync used to open a
 * transaction over the same table and never come back, leaving the app at „Odczyt i zapis plików
 * na Dysku…" until it was reloaded (STATE.md open question 31). Connecting Drive inside that window is also exactly
 * what a new user does: it is step 1 of the wizard.
 *
 * Without this spec, the gate in `src/lib/nutrition/gate.ts` would be covered by nothing.
 */

const CONNECT = 'Połącz Dysk Google';

/**
 * The premise of every test here. If this ever fails, the import got fast enough that these
 * tests stopped overlapping anything — which is worth being told about loudly, rather than
 * keeping three tests that quietly assert nothing.
 */
async function expectStillImporting(page: Page): Promise<void> {
  await expect(
    page.locator('html'),
    'the import finished before the test could overlap it'
  ).toHaveAttribute('data-nutrition', 'importing');
}

test('connecting Drive during the bundled import still finishes the sync', async ({
  openDevice,
  drive
}) => {
  seedAccount(drive, { recipes: [recipe({ name: 'Naleśniki z Dysku' })] });

  const device = await openDevice({ raceNutritionImport: true, keepSetup: true });
  await expect(device.getByRole('heading', { name: 'Pierwsze uruchomienie' })).toBeVisible();
  await expectStillImporting(device);

  await device.getByRole('button', { name: CONNECT }).click();

  // The account already holds data, so a finished sync leaves the wizard by itself. This is
  // the assertion that used to hang: the write landed in a transaction that never returned.
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible({ timeout: 60_000 });

  // And the sync really did apply what was on Drive, rather than merely giving up quietly.
  await nutritionReady(device);
  await device.goto('#/recipes');
  await expect(device.getByText('Naleśniki z Dysku')).toBeVisible();
});

test('the wait for the ingredient database is named, not silent', async ({ openDevice, drive }) => {
  seedAccount(drive);

  const device = await openDevice({ raceNutritionImport: true, keepSetup: true });
  await expectStillImporting(device);

  await device.getByRole('button', { name: CONNECT }).click();

  // Either stage may be on screen when the assertion runs — the sync passes through both —
  // but the button must never fall silent, and the wait must be named in Polish when it is
  // the one that is running.
  await expect(device.getByRole('button', { name: /Łączenie|Odczyt i zapis|Czekam na bazę/ })).toBeVisible();
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible({ timeout: 60_000 });
});

/**
 * Task 1, driven end to end: the wizard's `setupDone` write used to be dropped with `void`,
 * so leaving the wizard inside the import window queued a write that a reload could lose —
 * and the wizard came back as though the user had never been through it.
 */
test('leaving the wizard inside the import window survives an immediate reload', async ({
  openDevice
}) => {
  const device = await openDevice({ raceNutritionImport: true, keepSetup: true });
  await expectStillImporting(device);

  await device.getByRole('button', { name: 'Pomiń kreator' }).click();
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible({ timeout: 60_000 });

  await device.reload();

  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible({ timeout: 60_000 });
  await expect(device.getByRole('heading', { name: 'Pierwsze uruchomienie' })).toHaveCount(0);
  expect(device.url()).not.toContain('#/setup');
});
