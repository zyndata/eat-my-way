import { expect, test } from './fixtures';

/**
 * Declared rather than pulled in with `@types/node`, the same way `playwright.config.ts`
 * declares `process`: this repo keeps Node globals out of its type environment. Playwright
 * needs the real thing here — it base64-encodes the payload through `Buffer`'s own
 * `toString`, so a `Uint8Array` produces a file the browser cannot decode.
 */
declare const Buffer: { from(value: string): unknown };

/**
 * „Export file re-imports cleanly into a fresh profile" — PLAN.md's Phase 8 acceptance
 * criterion, as a walk through the two buttons rather than as a manual note.
 *
 * The second device is a second browser context: its own IndexedDB, nothing shared but the
 * file that passes between them. `backup.repository.test.ts` covers what the restore does to
 * the database; this covers whether a user can actually get the file out and back in.
 */

test('a backup taken on one device restores the whole calendar on a fresh one', async ({
  openDevice
}) => {
  const source = await openDevice();

  // Something worth backing up: a recipe, and a day that plans it.
  await source.goto('#/recipes/new/edit');
  await source.getByLabel('Nazwa').fill('Owsianka z jajkiem');
  await source.getByRole('button', { name: 'Dodaj składnik' }).click();
  await source.getByLabel('Składnik 1').fill('jajko');
  await source.getByRole('option').first().click();
  await source.getByLabel('Ilość').first().fill('120');
  await source.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(source.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await source.goto('#/');
  await source.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await source.getByRole('button', { name: /Owsianka/ }).click();
  await expect(source.getByRole('link', { name: /Owsianka/ }).first()).toBeVisible();

  await source.goto('#/settings');
  const [download] = await Promise.all([
    source.waitForEvent('download'),
    source.getByRole('button', { name: 'Zapisz kopię' }).click()
  ]);
  const file = await download.path();
  expect(download.suggestedFilename()).toMatch(/^eat-my-way-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(source.getByText(/Zapisano plik eat-my-way-/)).toBeVisible();

  // A second browser context is a device that has never seen any of this.
  const fresh = await openDevice();
  await expect(fresh.getByRole('link', { name: /Owsianka/ })).toHaveCount(0);

  await fresh.locator('input[type="file"]').setInputFiles(file);
  // The dialog says what the file holds before it replaces anything.
  const dialog = fresh.getByRole('dialog', { name: 'Wczytać kopię i zastąpić dane?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/zawiera\s+1\s+przepis/);
  await expect(dialog).toContainText(/1\s+zaplanowany dzień/);
  // The restore reloads the page — waited for, or the navigation below races it.
  await Promise.all([
    fresh.waitForEvent('load'),
    fresh.getByRole('button', { name: 'Tak, zastąp dane' }).click()
  ]);

  // Both the recipe and the day it was planned on come back.
  await fresh.goto('#/recipes');
  await expect(fresh.getByText('Owsianka z jajkiem')).toBeVisible();

  await fresh.goto('#/');
  await expect(fresh.getByRole('link', { name: /Owsianka/ }).first()).toBeVisible();
});

test('a file that is not one of ours is refused without touching anything', async ({ device }) => {
  await device.locator('input[type="file"]').setInputFiles({
    name: 'coś-innego.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"hello":"world"}')
  });

  await expect(device.getByText('To nie jest kopia danych Eat My Way.')).toBeVisible();
  // No confirmation was offered, so nothing could have been replaced.
  await expect(device.getByRole('button', { name: 'Tak, zastąp dane' })).toHaveCount(0);
});
