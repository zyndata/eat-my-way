import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * „Trzy drobiazgi" (PLAN.md Phase 18), driven through the real screens.
 *
 * The rules are pinned by `src/lib/custom-ingredients.test.ts`, `search.test.ts`,
 * `recipes.test.ts` and `menu.test.ts`. What this adds is the half a unit test cannot reach:
 * that the warning is actually printed under the fields while the save button stays alive,
 * that the library really does list a recipe by what is in it — below the recipe named after
 * it — and that a week of meals comes out of the sheet as text a person can paste.
 *
 * „Soczewica" and „Soczewica czerwona" both come from the bundled USDA subset, via
 * `data/pl-ingredients.tsv`, which is why they are named here.
 */

const MACRO_FIELDS = ['kcal', 'Białko (g)', 'Węgl. (g)', 'Tłuszcz (g)'] as const;

const warning = (page: Page) => page.getByTestId('sanity-warning');
const save = (page: Page) => page.getByRole('button', { name: 'Zapisz składnik' });

/** Open the inline „new ingredient" form the recipe editor offers when nothing matches. */
async function newIngredient(device: Page, recipeName: string, name: string): Promise<void> {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill(recipeName);
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill(name);
  await device.getByRole('button', { name: /Dodaj własny składnik/ }).click();
}

async function fillMacros(device: Page, values: readonly string[]): Promise<void> {
  for (const [index, value] of values.entries()) {
    await device.getByLabel(MACRO_FIELDS[index]!, { exact: true }).fill(value);
  }
}

/** A recipe with the named bundled ingredients in it, saved. */
async function saveRecipe(device: Page, name: string, ingredients: readonly string[]): Promise<void> {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill(name);
  for (const [index, ingredient] of ingredients.entries()) {
    await device.getByRole('button', { name: 'Dodaj składnik' }).click();
    await device.getByLabel(`Składnik ${index + 1}`).fill(ingredient);
    await device
      .getByRole('listbox', { name: `Składnik ${index + 1}` })
      .getByRole('option')
      .first()
      .click();
    await device.getByLabel('Ilość').nth(index).fill('100');
  }
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
}

// ---- task A: the numbers have to be possible ---------------------------------------------

test('impossible macros are warned about, and saved anyway', async ({ device }) => {
  await newIngredient(device, 'Niemożliwy na próbę', 'Coś niemożliwego');

  // 40 + 40 + 40 g of macronutrient in 100 g of food.
  await fillMacros(device, ['520', '40', '40', '40']);

  await expect(warning(device)).toContainText('120 g na 100 g');
  // The whole point of decision 331: it is a sentence, not a lock.
  await expect(save(device)).toBeEnabled();
  await save(device).click();
  await expect(warning(device)).toBeHidden();

  await device.getByLabel('Ilość').first().fill('50');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
});

test('a label that genuinely misses Atwater warns, and an ordinary one does not', async ({
  device
}) => {
  await newIngredient(device, 'Otręby na próbę', 'Otręby babci');

  // High fibre: the package says 200 kcal, Atwater says 360. The package is right.
  await fillMacros(device, ['200', '16', '65', '4']);
  await expect(warning(device)).toContainText('360 kcal');
  await expect(save(device)).toBeEnabled();

  // An ordinary ingredient says nothing at all.
  await fillMacros(device, ['350', '16', '65', '4']);
  await expect(warning(device)).toBeHidden();

  // And neither does a 15 kcal vegetable — the 20 kcal floor, decision 332.
  await fillMacros(device, ['15', '1.4', '2.9', '0.2']);
  await expect(warning(device)).toBeHidden();
});

// ---- task B: finding a recipe by what is in the house -------------------------------------

test('the library finds a recipe by what is in it, below every recipe named after it', async ({
  device
}) => {
  await saveRecipe(device, 'Soczewica z curry', ['ryż biały']);
  await saveRecipe(device, 'Zupa dnia', ['soczewica czerwona']);
  await saveRecipe(device, 'Kotlety', ['pierś z kurczaka']);

  await device.goto('#/recipes');
  const search = device.getByPlaceholder('Szukaj przepisu lub składnika…');
  await search.fill('soczewica');

  // The name match first, the recipe that merely contains lentils under it, and the recipe
  // with neither not at all.
  const names = async (): Promise<string[]> =>
    (await device.getByRole('link', { name: /kcal/ }).allInnerTexts()).map(
      (text) => text.split('\n')[0]?.trim() ?? ''
    );

  await expect(device.getByRole('link', { name: /kcal/ })).toHaveCount(2);
  expect(await names()).toEqual(['Soczewica z curry', 'Zupa dnia']);

  // An ingredient alias reaches it too: nothing is called „kurczak".
  await search.fill('kurczak');
  await expect(device.getByRole('link', { name: /kcal/ })).toHaveCount(1);
  expect(await names()).toEqual(['Kotlety']);
});

// ---- task C: the menu as text --------------------------------------------------------------

test('a day of meals comes out as text, with its totals against its goals', async ({ device }) => {
  await saveRecipe(device, 'Obiad na próbę', ['ryż biały']);

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('dialog').getByRole('button', { name: /Obiad na próbę/ }).click();

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Jadłospis — dzień' }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet).toContainText('Obiad na próbę — 1 porcja');
  // 100 g of white rice against the default 2000 kcal goal — no ingredients anywhere in it
  // (decision 334), just the meal and the day's line.
  await expect(sheet).toContainText(/Razem: \d+ \/ 2000 kcal/);
  await expect(sheet).not.toContainText('Ryż biały');

  await expect(sheet.getByRole('button', { name: 'Udostępnij jadłospis' })).toBeVisible();
});

test('a whole week comes out, the days with nothing on them included', async ({ device }) => {
  await device.goto('#/');
  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Jadłospis — tydzień' }).click();

  const sheet = device.getByRole('dialog');
  // Nothing is planned at all, so the sheet says so rather than printing seven empty days.
  await expect(sheet).toContainText('W tym zakresie nie ma nic zaplanowanego.');
  await sheet.getByRole('button', { name: 'Zamknij' }).click();

  await saveRecipe(device, 'Śniadanie na próbę', ['płatki owsiane']);
  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('dialog').getByRole('button', { name: /Śniadanie na próbę/ }).click();

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Jadłospis — tydzień' }).click();

  // Seven headings — the six days with nothing on them are still part of the week.
  await expect(sheet.getByRole('heading', { level: 3 })).toHaveCount(7);
  await expect(sheet).toContainText('Śniadanie na próbę — 1 porcja');
  await expect(sheet.getByText('Nic nie zaplanowano.')).toHaveCount(6);
  await expect(sheet.getByText(/Razem: \d+ \/ 2000 kcal/)).toHaveCount(1);
});
