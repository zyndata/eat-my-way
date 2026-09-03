import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * „Składniki" driven through the real screens (PLAN.md Phase 10).
 *
 * The rules themselves are covered by unit tests; what these add is that the screen exists,
 * that its buttons are reachable, and that the three refusals the phase is built on hold where
 * a user meets them: an unfinished ingredient cannot be saved, a bundled row cannot be edited,
 * and an ingredient a recipe uses cannot be deleted without a replacement.
 */

/** Fill the four per-100 g fields inside the open sheet. */
async function fillMacros(
  page: Page,
  values: { kcal: string; protein: string; carbs: string; fat: string }
): Promise<void> {
  await page.getByLabel('kcal').fill(values.kcal);
  await page.getByLabel('Białko (g)').fill(values.protein);
  await page.getByLabel('Węgl. (g)').fill(values.carbs);
  await page.getByLabel('Tłuszcz (g)').fill(values.fat);
}

test('an ingredient cannot be saved half-filled, and an explicit zero saves', async ({ device }) => {
  await device.goto('#/ingredients');
  await device.getByRole('button', { name: 'Nowy składnik' }).click();

  const save = device.getByRole('button', { name: 'Zapisz składnik' });
  await device.getByLabel('Nazwa').fill('Woda źródlana');
  await expect(save).toBeDisabled();
  // And the reason is on screen — „the button is grey" is not an answer.
  await expect(device.getByText('wpisz 0')).toBeVisible();

  await fillMacros(device, { kcal: '0', protein: '0', carbs: '0', fat: '0' });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(device.getByText('Woda źródlana')).toBeVisible();
  await expect(device.getByText('0 kcal / 100 g')).toBeVisible();
});

test('a bundled row offers only „Kopiuj i edytuj", and the copy is the user’s own', async ({
  device
}) => {
  await device.goto('#/ingredients');
  await device.getByPlaceholder('Szukaj składnika…').fill('jajko');
  await device.getByRole('button', { name: 'Pokaż składniki z bazy' }).click();

  // Nothing on a bundled row edits it in place.
  await expect(device.getByRole('button', { name: 'Kopiuj i edytuj' }).first()).toBeVisible();
  await expect(device.getByRole('button', { name: 'Edytuj', exact: true })).toHaveCount(0);

  await device.getByRole('button', { name: 'Kopiuj i edytuj' }).first().click();
  const name = device.getByLabel('Nazwa');
  await expect(name).toHaveValue(/\(kopia\)$/);
  // The copy starts with no aliases: two rows answering to one alias is the failure this
  // screen exists to reduce.
  await expect(device.getByLabel('Inne nazwy')).toHaveValue('');

  await name.fill('Jajko z targu');
  await device.getByRole('button', { name: 'Zapisz jako własny' }).click();

  await expect(device.getByRole('heading', { name: /Moje składniki \(1\)/ })).toBeVisible();
  await expect(device.getByText('Jajko z targu')).toBeVisible();
});

test('deleting an ingredient a recipe uses names the recipe and asks for a replacement', async ({
  device
}) => {
  // A custom ingredient, created the way the recipe editor creates one.
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Serniczki');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('Twaróg babci');
  await device.getByRole('button', { name: /Dodaj własny składnik/ }).click();
  await fillMacros(device, { kcal: '130', protein: '18', carbs: '3', fat: '4' });
  await device.getByRole('button', { name: 'Zapisz składnik' }).click();
  await device.getByLabel('Ilość').first().fill('200');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await device.goto('#/ingredients');
  await expect(device.getByText('używany w 1 przepisie')).toBeVisible();
  await device.getByRole('button', { name: 'Usuń' }).click();

  // The dialog names the recipe, links to it, and offers no way to delete without replacing.
  await expect(device.getByRole('heading', { name: 'Ten składnik jest używany' })).toBeVisible();
  await expect(device.getByRole('link', { name: 'Serniczki' })).toBeVisible();
  await expect(device.getByRole('button', { name: 'Zastąp i usuń' })).toBeDisabled();
});
