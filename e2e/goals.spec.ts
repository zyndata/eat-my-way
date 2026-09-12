import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { profileDocument, recipesDocument, seedAccount } from './seed';

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

/**
 * Reported from a phone after clearing the site data: everything came back from Drive except
 * the daily goals. The database seeds a default profile the moment it is created, so an
 * untouched browser looked to the merge like a device that had edited its goals (STATE.md
 * decision 227).
 */
test('goals on the account come back to a browser that has none', async ({ openDevice, drive }) => {
  drive.put(
    'profile.json',
    profileDocument({ googleSub: 'sub-1', goals: { kcal: 2600, protein: 180, carbs: 240, fat: 80 } })
  );
  drive.put('recipes.json', recipesDocument([]));

  const device = await openDevice();
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  await expect(kcalField(device)).toHaveValue('2600');
  // And the defaults were not pushed over them on the way out.
  expect(JSON.stringify(drive.snapshot()['profile.json'])).toContain('2600');
});

/** The rule the refresh must not break: what you are typing outranks what Drive just sent. */
test('a sync landing under the screen does not overwrite an unsaved edit', async ({
  device,
  drive
}) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  await kcalField(device).fill('1234');
  await device.getByRole('button', { name: 'Synchronizuj teraz' }).click();
  await expect(device.getByRole('button', { name: 'Synchronizuj teraz' })).toBeEnabled();

  await expect(kcalField(device)).toHaveValue('1234');
});

/**
 * Phase 19. The calculator's three missing pieces, from the screen: its inputs survive a
 * close, its split is editable and pinned at 100%, and it shows where the number came from.
 */

const openCalculator = async (page: Page) =>
  page.getByRole('button', { name: /Policz za mnie/ }).click();

const derivation = (page: Page) => page.getByTestId('derivation');

test('body data entered in the calculator is still there after a reload', async ({ device }) => {
  await openCalculator(device);
  await device.getByLabel('Płeć').selectOption('male');
  await device.getByLabel(/Wiek/).fill('44');
  await device.getByLabel(/Wzrost/).fill('183');
  await device.getByLabel(/Waga/).fill('86');
  await device.getByLabel('Aktywność').selectOption('moderate');
  await device.getByRole('button', { name: 'Wypełnij pola' }).click();
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await device.reload();
  await openCalculator(device);

  await expect(device.getByLabel('Płeć')).toHaveValue('male');
  await expect(device.getByLabel(/Wiek/)).toHaveValue('44');
  await expect(device.getByLabel(/Wzrost/)).toHaveValue('183');
  await expect(device.getByLabel(/Waga/)).toHaveValue('86');
  await expect(device.getByLabel('Aktywność')).toHaveValue('moderate');
});

test('the derivation matches the goals the calculator fills in', async ({ device }) => {
  await openCalculator(device);
  await device.getByLabel('Płeć').selectOption('male');
  await device.getByLabel(/Wiek/).fill('40');
  await device.getByLabel(/Wzrost/).fill('180');
  await device.getByLabel(/Waga/).fill('80');
  await device.getByLabel('Aktywność').selectOption('sedentary');

  // BMR 1730, × 1.2 = 2076 kcal; the default 25/45/30 split of it.
  await expect(derivation(device)).toContainText('1730');
  await expect(derivation(device)).toContainText('1,200');
  await expect(derivation(device)).toContainText('2076');

  await device.getByRole('button', { name: 'Wypełnij pola' }).click();
  await expect(kcalField(device)).toHaveValue('2076');
  await expect(device.getByLabel(/Białko \(g\)/)).toHaveValue('130');
  await expect(device.getByLabel(/Węglowodany \(g\)/)).toHaveValue('234');
  await expect(device.getByLabel(/Tłuszcz \(g\)/)).toHaveValue('69');
});

test('a 40/30/30 split calculates, and 40/30/40 cannot be saved', async ({ device }) => {
  await openCalculator(device);
  await device.getByLabel(/Białko \(%\)/).fill('40');
  await device.getByLabel(/Węglowodany \(%\)/).fill('30');
  await device.getByLabel(/Tłuszcz \(%\)/).fill('30');
  await device.getByRole('button', { name: 'Wypełnij pola' }).click();

  // The default body — 30-year-old woman, 170 cm, 70 kg, light activity:
  // BMR = 700 + 1062.5 − 150 − 161 = 1451.5, × 1.375 = 1996 kcal, split 40/30/30.
  await expect(kcalField(device)).toHaveValue('1996');
  await expect(device.getByLabel(/Białko \(g\)/)).toHaveValue('200');
  await expect(device.getByLabel(/Węglowodany \(g\)/)).toHaveValue('150');
  await expect(device.getByLabel(/Tłuszcz \(g\)/)).toHaveValue('67');

  await device.getByLabel(/Tłuszcz \(%\)/).fill('40');
  await expect(device.getByRole('button', { name: 'Wypełnij pola' })).toBeDisabled();
  await expect(device.getByRole('button', { name: 'Zapisz cele' })).toBeDisabled();
  await expect(device.getByText('zamiast 100%')).toBeVisible();
});

test('the split is remembered and still only filling the fields saves nothing', async ({
  device
}) => {
  await openCalculator(device);
  await device.getByLabel(/Białko \(%\)/).fill('40');
  await device.getByLabel(/Węglowodany \(%\)/).fill('30');
  await device.getByLabel(/Tłuszcz \(%\)/).fill('30');
  await device.getByRole('button', { name: 'Wypełnij pola' }).click();

  // „Wypełnij pola" writes nothing: after a reload the goals are the untouched defaults.
  const filled = await kcalField(device).inputValue();
  await device.reload();
  expect(await kcalField(device).inputValue()).not.toBe(filled);

  await openCalculator(device);
  await device.getByLabel(/Białko \(%\)/).fill('40');
  await device.getByLabel(/Węglowodany \(%\)/).fill('30');
  await device.getByLabel(/Tłuszcz \(%\)/).fill('30');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await device.reload();
  await openCalculator(device);
  await expect(device.getByLabel(/Białko \(%\)/)).toHaveValue('40');
  await expect(device.getByLabel(/Tłuszcz \(%\)/)).toHaveValue('30');
});
