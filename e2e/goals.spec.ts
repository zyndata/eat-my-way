import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { seedAccount } from './seed';

/**
 * „Cele dzienne" → „Zapisz cele", the flow that hung.
 *
 * The goals object is `bind:goals` in `GoalsForm`, so what reaches `repository.setGoals` is a
 * Svelte `$state` proxy, and IndexedDB refuses to structured-clone one. The write threw
 * `DataCloneError` inside a `void`-ed promise: nothing was saved, nothing was reported, and
 * the button sat on „Zapisywanie…" for good. STATE.md decision 56 had predicted exactly this
 * recurrence; `repository.ts` now copies at its own boundary.
 *
 * The unit audit in `repository.proxy.test.ts` covers the boundary. This covers the screen —
 * the half that decides whether a real proxy ever gets there.
 *
 * „Model Gemini" is the same defect one field over (`saveProfile` spreads a `$state` profile,
 * leaving `goals` proxied underneath), but it only renders once a vault exists, so it is
 * covered at the unit level rather than by walking Argon2id in a browser for one field.
 */

const CONNECT = 'Połącz Dysk Google';

const status = (page: Page) =>
  page.locator('dt', { hasText: 'Stan' }).locator('xpath=following-sibling::dd[1]');

const kcalField = (page: Page) => page.getByLabel(/Kalorie/);

test('saving daily goals finishes, reports success and actually writes', async ({ device }) => {
  await kcalField(device).fill('2222');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();

  // The symptom was this button never coming back from „Zapisywanie…".
  await expect(device.getByRole('button', { name: 'Zapisz cele' })).toBeEnabled();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await device.reload();
  await expect(kcalField(device)).toHaveValue('2222');
});

test('saved goals reach Drive', async ({ device, drive }) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  await kcalField(device).fill('1800');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await expect
    .poll(() => JSON.stringify(drive.snapshot()['profile.json']), { timeout: 20_000 })
    .toContain('1800');
});
