import type { Page } from '@playwright/test';
import { cspViolations } from './fake-google';
import { modelCalls } from './fake-gemini';
import { expect, test } from './fixtures';

/**
 * „Wklej przepis z internetu", driven through the real screens: the vault is created in
 * settings, the key is checked against the (faked) model list, and the import runs from the
 * recipe editor. Every Gemini request leaves the page for `generativelanguage.googleapis.com`
 * and is answered there, so a run against the Caddy container exercises the production CSP.
 */

const PANCAKES = [
  'Naleśniki na 2 porcje',
  '2 jajka',
  '200 g mąki pszennej',
  'oliwa do smażenia',
  'Wymieszaj i usmaż.'
].join('\n');

/** What the model returns for it: fats quantified, units normalized, no nutrition numbers. */
const PARSED = {
  name: 'Naleśniki',
  portions: 2,
  instructions: 'Wymieszaj i usmaż.',
  ingredients: [
    { name: 'Jajko kurze', amount: 2, unit: 'szt', state: 'raw', gramsPerUnit: 55 },
    { name: 'mąka pszenna', amount: 200, unit: 'g', state: 'raw' },
    { name: 'oliwa do smażenia', amount: 20, unit: 'g', state: 'raw' }
  ]
};

/** Create an unencrypted vault and store a key in it, both through the settings screen. */
async function setUpKey(page: Page): Promise<void> {
  await page.getByLabel('Szyfruj sejf hasłem głównym (zalecane)').uncheck();
  await page.getByRole('button', { name: 'Utwórz sejf' }).click();

  await page.getByLabel('Klucz API Gemini').fill('AIza-e2e-secret');
  await page.getByRole('button', { name: 'Sprawdź i zapisz klucz' }).click();
  await expect(page.getByText('Klucz działa.')).toBeVisible();
}

/** Settings → the empty recipe editor. */
async function openEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Przepisy' }).click();
  await page.getByRole('link', { name: 'Nowy przepis' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nowy przepis' })).toBeVisible();
}

test('pasted text becomes a reviewable draft with ingredients from the local database', async ({
  device,
  gemini
}) => {
  gemini.script.recipe = PARSED;

  await setUpKey(device);
  await openEditor(device);

  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill(PANCAKES);
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText('Przepis wczytany.')).toBeVisible();
  await expect(device.getByLabel('Nazwa')).toHaveValue('Naleśniki');
  await expect(device.getByLabel('Instrukcje')).toHaveValue('Wymieszaj i usmaż.');

  // Exactly matched by name, and halved because the page described two portions.
  await expect(device.getByText('Jajko kurze', { exact: true })).toBeVisible();
  await expect(device.getByLabel('Ilość').first()).toHaveValue('1');

  // The macro sum is computed from IndexedDB, so it is non-zero without the model ever
  // having returned a number.
  await expect(device.getByText(/^\d+ kcal$/).first()).toBeVisible();

  // Nothing was saved: the library is still empty until „Zapisz przepis".
  await device.getByRole('link', { name: 'Anuluj' }).click();
  await expect(device.getByText('Naleśniki', { exact: true })).toHaveCount(0);
});

test('a link is read on Google’s side and needs no new connect-src host', async ({
  device,
  gemini
}) => {
  gemini.script.page = PANCAKES;
  gemini.script.recipe = PARSED;

  await setUpKey(device);
  await openEditor(device);

  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill('https://example.com/nalesniki');
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText('Przepis wczytany.')).toBeVisible();
  await expect(device.getByLabel('Nazwa')).toHaveValue('Naleśniki');

  // The recipe page itself was never requested by the browser — only Google's host was.
  const hosts = new Set(modelCalls(gemini).map(() => 'generativelanguage.googleapis.com'));
  expect([...hosts]).toEqual(['generativelanguage.googleapis.com']);
  expect(await cspViolations(device)).toEqual([]);
});

test('a page the model cannot read points at pasting the text instead', async ({
  device,
  gemini
}) => {
  // No `page` in the script, so the retrieval call answers BRAK_PRZEPISU.
  gemini.script.recipe = PARSED;

  await setUpKey(device);
  await openEditor(device);

  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill('https://example.com/za-loginem');
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText(/skopiuj treść przepisu i wklej ją tutaj/)).toBeVisible();
  await expect(device.getByText('Przepis wczytany.')).toHaveCount(0);
  // It stopped at the retrieval call rather than parsing a refusal into an empty recipe.
  expect(modelCalls(gemini)).toHaveLength(1);
});

test('a rejected key fails in Polish and never leaves the key anywhere but the header', async ({
  device,
  gemini
}) => {
  gemini.script.recipe = PARSED;

  await setUpKey(device);
  gemini.script.status = 403;

  await openEditor(device);
  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill(PANCAKES);
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText(/Gemini nie przyjął klucza API/)).toBeVisible();

  for (const call of gemini.calls) {
    expect(call.key).toBe('AIza-e2e-secret');
    expect(call.prompt).not.toContain('AIza-e2e-secret');
    expect(call.system).not.toContain('AIza-e2e-secret');
  }
});

test('without a key the rest of the app is untouched and only the import says so', async ({
  device,
  gemini
}) => {
  gemini.script.recipe = PARSED;

  // No vault at all: the calendar and the library must not care.
  await device.getByRole('link', { name: 'Przepisy' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
  await device.getByRole('link', { name: 'Kalendarz' }).click();
  await expect(device.getByRole('button', { name: 'Dodaj posiłek' }).first()).toBeVisible();

  await device.getByRole('link', { name: 'Przepisy' }).click();
  await device.getByRole('link', { name: 'Nowy przepis' }).first().click();
  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill(PANCAKES);
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText(/sejf/i).first()).toBeVisible();
  expect(modelCalls(gemini)).toEqual([]);
});

test('correcting a mismatch once makes the next import of that name match itself', async ({
  device,
  gemini
}) => {
  gemini.script.recipe = PARSED;
  // „mąka pszenna” is ambiguous — the database holds a dozen of them — so the model declines.
  gemini.script.refuse = ['mąka pszenna'];

  await setUpKey(device);
  await openEditor(device);

  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill(PANCAKES);
  await device.getByRole('button', { name: 'Importuj' }).click();
  await expect(device.getByText(/nie udało się\s+dopasować/)).toBeVisible();

  // The user fixes it the ordinary way: the row's own autocomplete, one pick. („Składnik 2"
  // is the second row — the unit `<select>`s are comboboxes too, so the label is the anchor.)
  await device.getByLabel('Składnik 2').fill('mąka pszenna biała');
  await device
    .getByRole('listbox', { name: 'Składnik 2' })
    .getByRole('option', { name: /Mąka pszenna biała/ })
    .first()
    .click();
  await expect(device.getByText('Mąka pszenna biała', { exact: true })).toBeVisible();

  // A second import of the same text, into a fresh editor.
  await device.getByRole('link', { name: 'Anuluj' }).click();
  await device.getByRole('link', { name: 'Nowy przepis' }).first().click();
  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device.getByLabel('Link do przepisu albo jego treść').fill(PANCAKES);
  await device.getByRole('button', { name: 'Importuj' }).click();

  await expect(device.getByText('Przepis wczytany.')).toBeVisible();
  await expect(device.getByText('Mąka pszenna biała', { exact: true })).toBeVisible();
  // Nothing was left for the user to fill in this time.
  await expect(device.getByText(/nie udało się\s+dopasować/)).toHaveCount(0);

  // The name was settled locally: the second run still asked about „oliwa do smażenia", but
  // the corrected name was never sent again.
  const asked = modelCalls(gemini).filter((call) => call.system.startsWith('Dopasowujesz'));
  expect(asked).toHaveLength(2);
  expect(asked[0]?.prompt).toContain('mąka pszenna');
  expect(asked[1]?.prompt).not.toContain('mąka pszenna');
});
