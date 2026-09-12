import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * „Miary domowe" (PLAN.md Phase 16), driven through the real screens.
 *
 * The grammar and the rules are pinned by `src/lib/text.test.ts`, `recipes.test.ts` and
 * `shopping.test.ts`. What this adds is the half a unit test cannot reach: that the chips are
 * on the recipe row, that one tap fills three fields, that the same row then reads „2 ząbki
 * (10 g)" on the editor, on the meal screen and on the shopping list, and — the criterion that
 * matters most to someone who weighs everything — that typing `100` straight after picking an
 * ingredient still means 100 grams.
 *
 * „Czosnek" comes from the bundled USDA subset, where `data/pl-ingredients.tsv` gives it
 * `ząbek:5`. The weights are asserted against each other where possible, but this one is the
 * subject of the test, so it is named.
 */

const RECIPE = 'Czosnkowa na próbę';

/** The chip a measure is offered as: „ząbek · 5 g". */
const chip = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name} · `) });

test('one tap fills the unit, the label and the weight, and the row reads the same everywhere', async ({
  device
}) => {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill(RECIPE);

  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('czosnek');
  await device.getByRole('listbox', { name: 'Składnik 1' }).getByRole('option').first().click();

  // Picking the ingredient does not touch the unit (STATE.md decision 325): the row is still
  // in grams, and the amount field still means grams.
  await expect(device.getByLabel('Jednostka')).toHaveValue('g');
  await device.getByLabel('Ilość').fill('100');
  await expect(device.getByText(/^100 g · /)).toBeVisible();

  // One tap on „ząbek" sets all three at once.
  await chip(device, 'ząbek').click();
  await expect(device.getByLabel('Jednostka')).toHaveValue('szt');
  await expect(device.getByLabel('Waga 1 ząbek (g)')).toHaveValue('5');
  await device.getByLabel('Ilość').fill('2');

  // …and the editor row reads it in Polish, with the weight it works out to.
  await expect(device.getByText('2 ząbki (10 g) ·')).toBeVisible();

  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  // The meal screen says the same thing.
  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('button', { name: new RegExp(RECIPE) }).click();
  await device.getByRole('link', { name: new RegExp(RECIPE) }).first().click();
  await expect(device.getByRole('heading', { name: RECIPE })).toBeVisible();

  const row = device
    .getByRole('list', { name: 'Składniki posiłku' })
    .getByRole('listitem')
    .filter({ hasText: 'Czosnek' });
  await expect(row).toContainText('ząbki');
  await expect(row).toContainText('(10 g)');

  // And so does the shopping list.
  await device.getByRole('button', { name: 'Lista zakupów' }).first().click();
  await expect(device.getByRole('dialog')).toContainText('Czosnek — 2 ząbki (10 g)');
});

test('an ingredient with no household measures behaves exactly as it did before', async ({
  device
}) => {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Bez miar');

  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('pierś z kurczaka');
  await device.getByRole('listbox', { name: 'Składnik 1' }).getByRole('option').first().click();

  // No chip row at all — someone who weighs everything sees nothing new.
  await expect(device.getByText('Miary domowe:')).toHaveCount(0);
  await device.getByLabel('Ilość').fill('150');
  await expect(device.getByText(/^150 g · /)).toBeVisible();
});
