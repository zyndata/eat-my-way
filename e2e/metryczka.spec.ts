import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Phase 20 — „metryczka przepisu": the preparation time, from the editor to the filter.
 *
 * The rules themselves are unit-tested; what these add is that the field exists on the real
 * form, that a time the user typed is never taken away by an import, and that the library's
 * time chips narrow the list and say what they are hiding.
 */

/** Write one recipe with one ingredient row, optionally timed and tagged. */
async function writeRecipe(
  page: Page,
  name: string,
  options: { minutes?: string; tags?: string[] } = {}
): Promise<void> {
  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill(name);
  if (options.minutes !== undefined) {
    await page.getByLabel('Czas przygotowania').fill(options.minutes);
  }

  for (const tag of options.tags ?? []) {
    await page.getByLabel('Tagi').fill(tag);
    await page.getByLabel('Tagi').press('Enter');
  }

  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel('Składnik 1').fill('jajko');
  await page.getByRole('option').first().click();
  await page.getByLabel('Ilość').first().fill('100');

  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
}

/** Create an unencrypted vault and store a key in it, both through the settings screen. */
async function setUpKey(page: Page): Promise<void> {
  await page.getByLabel('Szyfruj sejf hasłem głównym (zalecane)').uncheck();
  await page.getByRole('button', { name: 'Utwórz sejf' }).click();
  await page.getByLabel('Klucz API Gemini').fill('AIza-e2e-secret');
  await page.getByRole('button', { name: 'Sprawdź i zapisz klucz' }).click();
  await expect(page.getByText('Klucz działa.')).toBeVisible();
}

/** What the model returns for a pasted recipe. `prepMinutes` is added per test. */
const PARSED = {
  name: 'Naleśniki',
  portions: 1,
  instructions: 'Wymieszaj i usmaż.',
  ingredients: [{ name: 'Jajko kurze', amount: 2, unit: 'szt', state: 'raw', gramsPerUnit: 55 }]
};

const PASTED = ['Naleśniki', '2 jajka', 'Wymieszaj i usmaż.'].join('\n');

async function runImport(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await page.getByLabel('Link do przepisu albo jego treść').fill(text);
  await page.getByRole('button', { name: 'Importuj' }).click();
  await expect(page.getByText('Przepis wczytany.')).toBeVisible();
}

test('a recipe saves with a time and without one, and a zero is refused', async ({ device }) => {
  await writeRecipe(device, 'Jajecznica', { minutes: '10' });
  await writeRecipe(device, 'Rosół');

  // The time is on the card; the untimed recipe simply has no such line.
  await device.goto('#/recipes');
  await expect(device.getByRole('link', { name: /Jajecznica/ })).toContainText('10 min');
  await expect(device.getByRole('link', { name: /Rosół/ })).not.toContainText('min');

  // It survives a reload of the editor, which is the round trip through IndexedDB.
  await device.getByRole('link', { name: /Jajecznica/ }).click();
  await expect(device.getByLabel('Czas przygotowania')).toHaveValue('10');

  // Zero is not „instant": saving is blocked and the form says why.
  await device.getByLabel('Czas przygotowania').fill('0');
  await expect(device.getByText(/musi być pełną liczbą minut większą od zera/)).toBeVisible();
  await expect(device.getByRole('button', { name: 'Zapisz przepis' })).toBeDisabled();

  await device.getByLabel('Czas przygotowania').fill('-5');
  await expect(device.getByRole('button', { name: 'Zapisz przepis' })).toBeDisabled();

  // Emptying the field is allowed — the time is optional.
  await device.getByLabel('Czas przygotowania').fill('');
  await expect(device.getByRole('button', { name: 'Zapisz przepis' })).toBeEnabled();
});

test('an import fills the time when the page states one, and leaves it empty when it does not', async ({
  device,
  gemini
}) => {
  gemini.script.recipe = { ...PARSED, prepMinutes: 25 };

  await setUpKey(device);
  await device.goto('#/recipes/new/edit');
  await runImport(device, PASTED);
  await expect(device.getByLabel('Czas przygotowania')).toHaveValue('25');

  // The same page without a time: the model answers null and the field stays empty rather
  // than being filled with a guess. Away and back, because re-visiting the hash the editor is
  // already on is not a navigation and would keep the draft that is on screen.
  gemini.script.recipe = { ...PARSED, prepMinutes: null };
  await device.goto('#/recipes');
  await device.goto('#/recipes/new/edit');
  await runImport(device, PASTED);
  await expect(device.getByLabel('Czas przygotowania')).toHaveValue('');
});

test('an import never overwrites a time the user has already typed', async ({ device, gemini }) => {
  gemini.script.recipe = { ...PARSED, prepMinutes: 25 };

  await setUpKey(device);
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Czas przygotowania').fill('45');
  await runImport(device, PASTED);

  await expect(device.getByLabel('Czas przygotowania')).toHaveValue('45');
});

test('„do 30 min" narrows the library, combines with a tag and explains what it hides', async ({
  device
}) => {
  await writeRecipe(device, 'Jajecznica', { minutes: '10', tags: ['Obiad'] });
  await writeRecipe(device, 'Gulasz', { minutes: '90', tags: ['Obiad'] });
  await writeRecipe(device, 'Sałatka', { minutes: '10', tags: ['Kolacja'] });
  await writeRecipe(device, 'Rosół', { tags: ['Obiad'] });

  await device.goto('#/recipes');
  await device.getByRole('button', { name: 'do 30 min' }).click();

  // Only the quick ones — and the untimed recipe is hidden, with the count said out loud.
  await expect(device.getByRole('link', { name: /Jajecznica/ })).toBeVisible();
  await expect(device.getByRole('link', { name: /Sałatka/ })).toBeVisible();
  await expect(device.getByRole('link', { name: /Gulasz/ })).toHaveCount(0);
  await expect(device.getByRole('link', { name: /Rosół/ })).toHaveCount(0);
  // `toContainText` rather than `getByText`: the sentence is assembled from interpolations,
  // so it reaches the DOM with newlines in it and only a normalizing matcher sees it whole.
  await expect(
    device.getByRole('list', { name: 'Filtruj po czasie przygotowania' })
  ).toContainText('Ukryto 1 przepis bez podanego czasu.');

  // It stacks with a tag chip rather than replacing it.
  await device.getByRole('button', { name: 'Obiad', exact: true }).click();
  await expect(device.getByRole('link', { name: /Jajecznica/ })).toBeVisible();
  await expect(device.getByRole('link', { name: /Sałatka/ })).toHaveCount(0);

  // Tapping the chip again turns the filter off and everything comes back.
  await device.getByRole('button', { name: 'do 30 min' }).click();
  await expect(device.getByRole('link', { name: /Rosół/ })).toBeVisible();
  await expect(device.getByRole('link', { name: /Gulasz/ })).toBeVisible();
});

test('the filtered-to-nothing state explains the time filter instead of looking empty', async ({
  device
}) => {
  await writeRecipe(device, 'Rosół');
  await writeRecipe(device, 'Gulasz', { minutes: '90' });

  await device.goto('#/recipes');
  await device.getByRole('button', { name: 'do 15 min' }).click();

  await expect(device.getByRole('main')).toContainText(
    'Nic nie pasuje do tych kryteriów. Filtr „do 15 min" pokazuje tylko przepisy z podanym ' +
      'czasem przygotowania — 1 przepis go nie ma i jest ukryty. Czas dopiszesz w przepisie, ' +
      'w polu „Czas przygotowania".'
  );
});
