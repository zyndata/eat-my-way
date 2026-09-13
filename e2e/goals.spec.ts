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

/**
 * The confirmation under „Wypełnij pola" (Phase 20 UI audit).
 *
 * The press was reported as doing nothing, and the report was fair: it fills the four fields at
 * the top of the section, which on a phone have scrolled out of sight behind the calculator
 * panel by the time the button is reachable. Nothing moved anywhere the eye was looking, and
 * the button itself painted no press state either.
 *
 * This asserts the half that is behaviour rather than styling — that the press says what it
 * did, and says that it has not saved it.
 */
test('filling the fields confirms itself, in the numbers it filled in', async ({ device }) => {
  await openCalculator(device);
  await device.getByLabel('Płeć').selectOption('male');
  await device.getByLabel(/Wiek/).fill('40');
  await device.getByLabel(/Wzrost/).fill('180');
  await device.getByLabel(/Waga/).fill('80');
  await device.getByLabel('Aktywność').selectOption('sedentary');

  const confirmation = device.getByTestId('fill-confirmation');
  await expect(confirmation).toBeHidden();

  await device.getByRole('button', { name: 'Wypełnij pola' }).click();

  // The same numbers the fields above now hold — readable without scrolling back up to them.
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('2076');
  await expect(confirmation).toContainText('130');
  await expect(confirmation).toContainText('234');
  await expect(confirmation).toContainText('69');

  // And the trap the panel's preamble only hints at: the press has saved nothing.
  await expect(confirmation).toContainText('Nic jeszcze nie zostało zapisane');
});

/**
 * Phase 23. A reduction and a gain, worked out from the maintenance figure the calculator has
 * always produced — one scenario per acceptance criterion that is visible from the screen.
 */

const goalSelect = (page: Page) => page.getByRole('combobox', { name: 'Cel', exact: true });
const rateSelect = (page: Page) => page.getByRole('combobox', { name: 'Tempo', exact: true });
const fill = (page: Page) => page.getByRole('button', { name: 'Wypełnij pola' }).click();

async function enterBody(
  page: Page,
  body: { sex: 'female' | 'male'; age: number; height: number; weight: number }
): Promise<void> {
  await page.getByLabel('Płeć').selectOption(body.sex);
  await page.getByLabel(/Wiek/).fill(String(body.age));
  await page.getByLabel(/Wzrost/).fill(String(body.height));
  await page.getByLabel(/Waga/).fill(String(body.weight));
  await page.getByLabel('Aktywność').selectOption('sedentary');
}

const MAN_OF_40 = { sex: 'male' as const, age: 40, height: 180, weight: 80 };

test('maintain is unchanged, a reduction and a gain start from it', async ({ device }) => {
  await openCalculator(device);
  await enterBody(device, MAN_OF_40);

  // The default goal is maintain, and it fills what the calculator always filled.
  await expect(goalSelect(device)).toHaveValue('maintain');
  await expect(rateSelect(device)).toHaveCount(0);
  await fill(device);
  await expect(kcalField(device)).toHaveValue('2076');

  // 2076 − 550 = 1526, split 25/45/30.
  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await expect(rateSelect(device)).toContainText('0,5 kg na tydzień — ok. 550 kcal dziennie');
  await expect(derivation(device)).toContainText('zapotrzebowanie na utrzymanie wagi: 2076 kcal');
  await expect(derivation(device)).toContainText('deficyt na redukcję (0,5 kg/tydz.): 550 kcal');
  await expect(derivation(device)).toContainText('cel dzienny: 1526 kcal');
  await fill(device);
  await expect(kcalField(device)).toHaveValue('1526');
  await expect(device.getByLabel(/Białko \(g\)/)).toHaveValue('95');
  await expect(device.getByLabel(/Węglowodany \(g\)/)).toHaveValue('172');
  await expect(device.getByLabel(/Tłuszcz \(g\)/)).toHaveValue('51');

  // 2076 + 275 = 2351.
  await goalSelect(device).selectOption({ label: 'Budowa masy' });
  await expect(derivation(device)).toContainText('nadwyżka na budowę masy (0,25 kg/tydz.): 275 kcal');
  await fill(device);
  await expect(kcalField(device)).toHaveValue('2351');
});

test('a small reduction is raised to the minimum, warned about and hinted at', async ({ device }) => {
  await openCalculator(device);
  // Maintenance 1209; 1209 − 1100 = 109, raised to 1200. 75 g protein is 1,5 g/kg.
  await enterBody(device, { sex: 'female', age: 60, height: 155, weight: 50 });
  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await rateSelect(device).selectOption('1');

  await expect(derivation(device)).toContainText('podniesiono do minimum 1200 kcal');
  await expect(derivation(device)).toContainText('cel dzienny: 1200 kcal');
  await expect(derivation(device)).toContainText('1,5 g/kg');
  await expect(device.getByTestId('floor-note')).toContainText('lekarza lub dietetyka');
  await expect(device.getByTestId('pace-warning')).toContainText('ponad 1% masy ciała');
  await expect(device.getByTestId('protein-hint')).toContainText('1,6 g białka');

  await fill(device);
  await expect(kcalField(device)).toHaveValue('1200');
  await expect(device.getByLabel(/Białko \(g\)/)).toHaveValue('75');
});

test('a man of 70 reducing at 1 kg is raised to 1500 kcal', async ({ device }) => {
  await openCalculator(device);
  // Maintenance 1544; 1544 − 1100 = 444, raised to 1500.
  await enterBody(device, { sex: 'male', age: 70, height: 165, weight: 60 });
  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await rateSelect(device).selectOption('1');
  await fill(device);
  await expect(kcalField(device)).toHaveValue('1500');
  await expect(device.getByTestId('pace-warning')).toBeVisible();
});

test('switching the goal picks a rate on its list, and leaves the split alone', async ({
  device
}) => {
  await openCalculator(device);
  await device.getByLabel(/Białko \(%\)/).fill('40');
  await device.getByLabel(/Węglowodany \(%\)/).fill('30');
  await device.getByLabel(/Tłuszcz \(%\)/).fill('30');

  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await expect(rateSelect(device).locator('option:checked')).toHaveText(/^0,5 kg/);
  await rateSelect(device).selectOption('0.75');

  await goalSelect(device).selectOption({ label: 'Budowa masy' });
  await expect(rateSelect(device).locator('option:checked')).toHaveText(/^0,25 kg/);

  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await expect(rateSelect(device).locator('option:checked')).toHaveText(/^0,5 kg/);

  await expect(device.getByLabel(/Białko \(%\)/)).toHaveValue('40');
  await expect(device.getByLabel(/Węglowodany \(%\)/)).toHaveValue('30');
  await expect(device.getByLabel(/Tłuszcz \(%\)/)).toHaveValue('30');
});

test('the goal and the rate are saved only by „Zapisz cele", and then survive', async ({
  device
}) => {
  await openCalculator(device);
  await enterBody(device, MAN_OF_40);
  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await rateSelect(device).selectOption('0.75');
  await fill(device);

  // Filling saved nothing: leaving Settings and coming back finds maintain.
  await device.goto('#/recipes');
  await device.goto('#/settings');
  await openCalculator(device);
  await expect(goalSelect(device)).toHaveValue('maintain');

  await enterBody(device, MAN_OF_40);
  await goalSelect(device).selectOption({ label: 'Redukcja' });
  await rateSelect(device).selectOption('0.75');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await device.goto('#/recipes');
  await device.goto('#/settings');
  await openCalculator(device);
  await expect(goalSelect(device)).toHaveValue('lose');
  await expect(rateSelect(device).locator('option:checked')).toHaveText(/^0,75 kg/);

  await device.reload();
  await openCalculator(device);
  await expect(goalSelect(device)).toHaveValue('lose');
  await expect(rateSelect(device).locator('option:checked')).toHaveText(/^0,75 kg/);
  // 2076 − 825 = 1251, under a man's 1500 kcal floor — raised to it.
  await expect(derivation(device)).toContainText('cel dzienny: 1500 kcal');
});

test('the goal and the rate reach a second device through Drive', async ({
  device,
  drive,
  openDevice
}) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  await openCalculator(device);
  await enterBody(device, MAN_OF_40);
  await goalSelect(device).selectOption({ label: 'Budowa masy' });
  await rateSelect(device).selectOption('0.5');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.', { exact: true })).toBeVisible();

  await expect
    .poll(() => JSON.stringify(drive.snapshot()['profile.json']), { timeout: 20_000 })
    .toMatch(/goal\W+gain\W+rate\W+0\.5/);

  const second = await openDevice();
  await second.getByRole('button', { name: CONNECT }).click();
  await expect(status(second)).toContainText('Połączono');

  // The calculator seeds itself once per mount, so it is opened on a fresh one.
  await second.reload();
  await openCalculator(second);
  await expect(goalSelect(second)).toHaveValue('gain');
  await expect(rateSelect(second).locator('option:checked')).toHaveText(/^0,5 kg/);
});

test('a profile written before phase 23 opens on maintain with its numbers unchanged', async ({
  openDevice,
  drive
}) => {
  drive.put(
    'profile.json',
    profileDocument({
      googleSub: 'sub-1',
      goals: { kcal: 2076, protein: 130, carbs: 234, fat: 69 },
      body: { ...MAN_OF_40, activity: 'sedentary' }
    })
  );
  drive.put('recipes.json', recipesDocument([]));

  const device = await openDevice();
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');
  await expect(kcalField(device)).toHaveValue('2076');

  await device.reload();
  await openCalculator(device);
  await expect(goalSelect(device)).toHaveValue('maintain');
  await expect(device.getByLabel(/Wiek/)).toHaveValue('40');
  await expect(derivation(device)).toContainText('zapotrzebowanie na utrzymanie wagi: 2076 kcal');
  await expect(derivation(device)).not.toContainText('cel dzienny');
});
