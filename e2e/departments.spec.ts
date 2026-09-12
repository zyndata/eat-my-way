import { expect, openRecipeEditor, test } from './fixtures';

/**
 * „Dział sklepu" (PLAN.md Phase 17), driven through the real screens.
 *
 * The grouping itself is pinned by `src/lib/shopping.test.ts` and the mapping by
 * `departments.test.ts`. What this adds is the half a unit test cannot reach: that a list
 * actually comes out of the sheet under headings, in the order a shop is walked, that the
 * departments nothing was bought from are not printed at all, and that an ingredient nobody
 * ever filed still lands somewhere — under „Inne", saved without anyone being asked for one.
 *
 * The three bundled rows are named on purpose: `data/pl-ingredients.tsv` files „Czosnek" under
 * warzywa, „Pierś z kurczaka" under mięso and „Ryż biały" under sypkie, which is three
 * different points of the walk in one recipe.
 */

const RECIPE = 'Obiad na próbę';

test('the shopping list comes out under headings, in the order a shop is walked', async ({
  device
}) => {
  await openRecipeEditor(device);
  await device.getByLabel('Nazwa').fill(RECIPE);

  // Added in the reverse of the walk order — rice, chicken, garlic — so that a list which
  // simply kept the order the ingredients were met would fail this test.
  for (const [index, name] of ['ryż biały', 'pierś z kurczaka', 'czosnek'].entries()) {
    await device.getByRole('button', { name: 'Dodaj składnik' }).click();
    await device.getByLabel(`Składnik ${index + 1}`).fill(name);
    await device
      .getByRole('listbox', { name: `Składnik ${index + 1}` })
      .getByRole('option')
      .first()
      .click();
    await device.getByLabel('Ilość').nth(index).fill('100');
  }

  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('dialog').getByRole('button', { name: new RegExp(RECIPE) }).click();

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Lista zakupów — dzień' }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet).toContainText('Czosnek');

  // Warzywa (1st of nine) before mięso (3rd) before sypkie (5th), whatever order they were
  // typed in — and nothing else printed, because nothing else was bought.
  await expect(sheet.getByRole('heading', { level: 3 })).toHaveText([
    'Warzywa i owoce',
    'Mięso, ryby i wędliny',
    'Sypkie i makarony'
  ]);
});

test('an ingredient nobody filed is saved anyway, and shops under „Inne"', async ({ device }) => {
  await openRecipeEditor(device);
  await device.getByLabel('Nazwa').fill('Serniczki na próbę');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('Twaróg babci');
  await device.getByRole('button', { name: /Dodaj własny składnik/ }).click();

  for (const [label, value] of [
    ['kcal', '130'],
    ['Białko (g)', '18'],
    ['Węgl. (g)', '3'],
    ['Tłuszcz (g)', '4']
  ]) {
    await device.getByLabel(label!, { exact: true }).fill(value!);
  }

  // The picker is there, it starts on „no choice", and the save is enabled regardless: nothing
  // about filing an ingredient may ever hold up writing it down (STATE.md decision 330).
  const picker = device.getByLabel('Dział sklepu');
  await expect(picker).toHaveValue('');
  const save = device.getByRole('button', { name: 'Zapisz składnik' });
  await expect(save).toBeEnabled();
  await save.click();

  await device.getByLabel('Ilość').first().fill('200');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('dialog').getByRole('button', { name: /Serniczki na próbę/ }).click();
  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Lista zakupów — dzień' }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet.getByRole('heading', { level: 3 })).toHaveText(['Inne']);
  await expect(sheet).toContainText('Twaróg babci — 200 g');
});
