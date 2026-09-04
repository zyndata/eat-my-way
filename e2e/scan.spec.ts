import type { Page } from '@playwright/test';
import { cspViolations } from './fake-google';
import { modelCalls } from './fake-gemini';
import { expect, test } from './fixtures';

/**
 * „Zeskanuj opakowanie", driven through the real screens (PLAN.md Phase 12, stage A).
 *
 * The label rules themselves are unit tests; what these add is the part no pure function can
 * show: that the file input reaches the camera path, that the picture is downscaled and sent
 * to `generativelanguage.googleapis.com` — so a run against the Caddy container exercises the
 * production CSP with no new host — and that the three refusals hold where the user meets
 * them. CI never photographs anything: the image is a one-pixel PNG and Gemini is answered at
 * the network boundary.
 */

/**
 * A real, decodable image on disk, so the browser's canvas path runs for real — one pixel of
 * it, because the model that would read a nutrition table is answered at the network boundary
 * and CI photographs nothing. A file rather than an inline buffer: `Buffer` is a Node global,
 * and this repo keeps those out of its type environment (see `playwright.config.ts`).
 */
const PHOTO = 'e2e/opakowanie.png';

/** What the model returns for a photographed butter wrapper: per 100 g, kcal, nothing else. */
const BUTTER = { name: 'Masło extra', kcal: 735, protein: 0.7, carbs: 0.8, fat: 82 };

/** Create an unencrypted vault; `withKey` also stores a key, through the settings screen. */
async function setUpVault(page: Page, withKey: boolean): Promise<void> {
  await page.getByLabel('Szyfruj sejf hasłem głównym (zalecane)').uncheck();
  await page.getByRole('button', { name: 'Utwórz sejf' }).click();
  if (!withKey) return;
  await page.getByLabel('Klucz API Gemini').fill('AIza-e2e-secret');
  await page.getByRole('button', { name: 'Sprawdź i zapisz klucz' }).click();
  await expect(page.getByText('Klucz działa.')).toBeVisible();
}

/** Settings → „Składniki" → the new-ingredient sheet. */
async function openNewIngredient(page: Page): Promise<void> {
  await page.goto('#/ingredients');
  await page.getByRole('button', { name: 'Nowy składnik' }).click();
  await expect(page.getByRole('button', { name: 'Zeskanuj opakowanie' })).toBeVisible();
}

/** Hand the hidden `<input capture>` a photograph, as the system camera would. */
async function photograph(page: Page): Promise<void> {
  await page.locator('#custom-ingredient-form input[type="file"]').setInputFiles(PHOTO);
}

test('a photographed label fills the four macros and the name', async ({ device, gemini }) => {
  gemini.script.label = BUTTER;

  // Meaningful against the Caddy container (`npm run docker:up`, then `npm run test:e2e:csp`):
  // that run serves the real CSP and the real `Permissions-Policy: camera=()`, which is the
  // only place the „`<input capture>` needs neither" claim can be checked (decision 241).
  const errors: string[] = [];
  device.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await setUpVault(device, true);
  await openNewIngredient(device);
  await photograph(device);

  await expect(device.getByLabel('kcal')).toHaveValue('735');
  await expect(device.getByLabel('Białko (g)')).toHaveValue('0.7');
  await expect(device.getByLabel('Węgl. (g)')).toHaveValue('0.8');
  await expect(device.getByLabel('Tłuszcz (g)')).toHaveValue('82');
  await expect(device.getByLabel('Nazwa')).toHaveValue('Masło extra');
  await expect(device.getByText('Ze zdjęcia:')).toBeVisible();

  // One request, and it carried a picture — downscaled and re-encoded in the browser.
  const calls = modelCalls(gemini);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.imageBytes).toBeGreaterThan(0);

  // Nothing is saved until the ordinary button is pressed.
  await expect(device.getByRole('button', { name: 'Zapisz składnik' })).toBeEnabled();
  await device.getByRole('button', { name: 'Anuluj' }).click();
  await expect(device.getByText('Masło extra')).toHaveCount(0);

  // …and then it is an ordinary custom ingredient.
  await openNewIngredient(device);
  await photograph(device);
  await device.getByRole('button', { name: 'Zapisz składnik' }).click();
  await expect(device.getByText('Masło extra')).toBeVisible();
  await expect(device.getByText('735 kcal / 100 g')).toBeVisible();

  expect(await cspViolations(device)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a value the model could not read stays empty, and the save stays refused', async ({
  device,
  gemini
}) => {
  gemini.script.label = { ...BUTTER, protein: null };

  await setUpVault(device, true);
  await openNewIngredient(device);
  await photograph(device);

  await expect(device.getByLabel('kcal')).toHaveValue('735');
  // Empty, and emphatically not „0": „nie wpisano" and „zero" are different facts.
  await expect(device.getByLabel('Białko (g)')).toHaveValue('');
  await expect(device.getByRole('button', { name: 'Zapisz składnik' })).toBeDisabled();
  await expect(device.getByText('wpisz 0')).toBeVisible();
});

test('a hand-typed value survives the scan that follows it', async ({ device, gemini }) => {
  gemini.script.label = BUTTER;

  await setUpVault(device, true);
  await openNewIngredient(device);
  await device.getByLabel('Nazwa').fill('Masło od sąsiada');
  await device.getByLabel('kcal').fill('700');

  await photograph(device);

  await expect(device.getByLabel('Nazwa')).toHaveValue('Masło od sąsiada');
  await expect(device.getByLabel('kcal')).toHaveValue('700');
  await expect(device.getByLabel('Tłuszcz (g)')).toHaveValue('82');
});

test('an unreadable answer still costs one request, and the counter says so', async ({
  device,
  gemini
}) => {
  // Not JSON at all: the call was answered, so the quota was spent either way.
  gemini.script.label = 'nie wiem, co jest na tym zdjęciu';

  await setUpVault(device, true);
  await openNewIngredient(device);
  await photograph(device);

  await expect(device.getByText(/nie udało się odczytać/i).first()).toBeVisible();
  await expect(device.getByLabel('kcal')).toHaveValue('');

  await device.goto('#/settings');
  await expect(device.getByText(/Dziś, model .*: 1 zapytanie/)).toBeVisible();
});

test('without a key the button says so, and the rest of the form still works', async ({
  device
}) => {
  await setUpVault(device, false);
  await openNewIngredient(device);
  await photograph(device);

  await expect(device.getByText('W sejfie nie ma klucza API Gemini.')).toBeVisible();

  // The form is untouched by the refusal: typing the values by hand still saves.
  await device.getByLabel('Nazwa').fill('Masło ręczne');
  await device.getByLabel('kcal').fill('735');
  await device.getByLabel('Białko (g)').fill('0.7');
  await device.getByLabel('Węgl. (g)').fill('0.8');
  await device.getByLabel('Tłuszcz (g)').fill('82');
  await device.getByRole('button', { name: 'Zapisz składnik' }).click();
  await expect(device.getByText('Masło ręczne')).toBeVisible();
});

test('a locked vault is unlocked at the moment the scan needs the key', async ({
  device,
  gemini
}) => {
  gemini.script.label = BUTTER;

  // An encrypted vault, then a reload: the app comes back with the key locked away, which is
  // what a returning user actually meets.
  // By role, not by label: the unlock dialog carries a „Hasło główne" of its own, closed but
  // present in the DOM from the first render.
  await device.getByRole('textbox', { name: 'Hasło główne' }).fill('bardzo-tajne-haslo');
  await device.getByRole('button', { name: 'Utwórz sejf' }).click();
  await device.getByLabel('Klucz API Gemini').fill('AIza-e2e-secret');
  await device.getByRole('button', { name: 'Sprawdź i zapisz klucz' }).click();
  await expect(device.getByText('Klucz działa.')).toBeVisible();
  await device.reload();

  await openNewIngredient(device);
  await photograph(device);

  // The prompt appears here and nowhere earlier — the calendar and the library never raise it.
  const unlock = device.getByRole('dialog');
  await expect(unlock.getByRole('heading', { name: 'Odblokuj sejf' })).toBeVisible();
  await unlock.getByLabel('Hasło główne').fill('bardzo-tajne-haslo');
  await unlock.getByRole('button', { name: 'Odblokuj' }).click();

  await expect(device.getByLabel('kcal')).toHaveValue('735');
});

test('offline, the scan says so rather than failing generically', async ({ device }) => {
  await setUpVault(device, true);
  await openNewIngredient(device);

  await device.context().setOffline(true);
  await photograph(device);

  await expect(device.getByText(/Jesteś offline/)).toBeVisible();
  await device.context().setOffline(false);
});

test('the recipe editor’s inline form offers the same scan', async ({ device, gemini }) => {
  gemini.script.label = BUTTER;

  await setUpVault(device, true);
  await device.goto('#/recipes/new/edit');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('masło extra od Zosi');
  await device.getByRole('button', { name: /Dodaj własny składnik/ }).click();
  await expect(device.getByRole('button', { name: 'Zeskanuj opakowanie' })).toBeVisible();

  await photograph(device);

  // Scoped to the form: the recipe itself has a „Nazwa" field of its own.
  const form = device.locator('#custom-ingredient-form');
  // The name the user typed into the autocomplete is theirs; the scan fills the rest.
  await expect(form.getByLabel('Nazwa')).toHaveValue('masło extra od Zosi');
  await expect(form.getByLabel('kcal')).toHaveValue('735');
});
