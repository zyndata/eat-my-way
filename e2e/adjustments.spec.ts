import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { cspViolations } from './fake-google';

/**
 * „Poprawki posiłku" (PLAN.md Phase 14), driven through the real screens.
 *
 * The rules themselves are pinned by `src/lib/adjustments.test.ts`; what these add is the
 * half a unit test cannot reach — that the buttons are on the meal screen, that a change
 * writes through and re-freezes the snapshot, that the day and the shopping list follow it,
 * that a copy carries it, and that the recipe in the library is left exactly as it was.
 *
 * Numbers are asserted against each other rather than against constants: the ingredients come
 * from the bundled USDA subset, and pinning its kilocalories here would make this suite fail
 * on the next data refresh for no reason of its own.
 */

const RECIPE = 'Sałatka z ogórkiem';

/** The „Składniki" list on the meal screen, which is the only one with these controls. */
const ingredientList = (page: Page): Locator => page.getByRole('list', { name: 'Składniki posiłku' });

const row = (page: Page, name: string): Locator =>
  ingredientList(page).getByRole('listitem').filter({ hasText: name });

/**
 * The open sheet. Every shopping-list assertion is scoped to it: the meal screen behind it
 * names the same ingredients, so an unscoped `getByText` matches twice and says nothing.
 */
const sheet = (page: Page): Locator => page.getByRole('dialog');

/** The meal's own kilocalories, off the „Ile zjadam" panel. */
async function mealKcal(page: Page): Promise<number> {
  const text = await page.getByText(/^\d+ kcal$/).first().innerText();
  return Number.parseInt(text, 10);
}

/** The day header's „N / 2000 kcal". */
async function dayKcal(page: Page): Promise<number> {
  const text = await page.locator('p', { hasText: /\/ \d+ kcal$/ }).first().innerText();
  return Number.parseInt(text, 10);
}

/** One recipe of two ingredients, planned onto today, and the meal screen open. */
async function seedMeal(page: Page): Promise<void> {
  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill(RECIPE);

  // Scoped to the combobox's own listbox: the unit `<select>` on a filled row also has
  // `option` children, and an unscoped `getByRole('option')` finds those first.
  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel('Składnik 1').fill('ogórek');
  await page.getByRole('listbox', { name: 'Składnik 1' }).getByRole('option').first().click();
  await page.getByLabel('Ilość').first().fill('200');

  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel('Składnik 2').fill('jajko');
  await page.getByRole('listbox', { name: 'Składnik 2' }).getByRole('option').first().click();
  await page.getByLabel('Ilość').nth(1).fill('100');

  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await page.goto('#/');
  await page.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await page.getByRole('button', { name: new RegExp(RECIPE) }).click();
  await expect(page.getByRole('link', { name: new RegExp(RECIPE) }).first()).toBeVisible();
}

async function openMeal(page: Page): Promise<void> {
  await page.getByRole('link', { name: new RegExp(RECIPE) }).first().click();
  await expect(page.getByRole('heading', { name: RECIPE })).toBeVisible();
}

test('skipping a row lowers the meal and the day, and leaves the recipe alone', async ({
  device
}) => {
  await seedMeal(device);
  const plannedDay = await dayKcal(device);

  await openMeal(device);
  const planned = await mealKcal(device);

  await row(device, 'Jajk').getByRole('button', { name: 'Pomiń' }).click();

  // The header line names the change, in Polish, and the row stays on the list.
  await expect(device.getByText('Zmieniony wobec przepisu:')).toBeVisible();
  await expect(row(device, 'Jajk')).toContainText('pominięty');
  await expect(row(device, 'Jajk').getByRole('button', { name: 'Przywróć' })).toBeVisible();

  expect(await mealKcal(device)).toBeLessThan(planned);

  // And the drift banner stays quiet: it means „the recipe moved", not „you changed
  // something", so it compares the snapshot through this meal's own changes.
  await expect(device.getByText('Przepis zmienił się od zaplanowania')).toHaveCount(0);

  // The day follows, and the card says which meal is not the plain recipe.
  await device.goto('#/');
  expect(await dayKcal(device)).toBeLessThan(plannedDay);
  await expect(device.getByRole('link', { name: new RegExp(RECIPE) }).first()).toContainText(
    'zmieniony'
  );

  // And the recipe in the library still has both of its rows.
  await device.goto('#/recipes');
  await device.getByRole('link', { name: new RegExp(RECIPE) }).click();
  await expect(device.getByText('Ogór').first()).toBeVisible();
  await expect(device.getByText('Jajk').first()).toBeVisible();
});

test('„Zostaw tylko ten składnik" is one tap, and „Przywróć oryginał" undoes everything', async ({
  device
}) => {
  await seedMeal(device);
  await openMeal(device);
  const planned = await mealKcal(device);

  await row(device, 'Ogór').getByRole('button', { name: 'Zostaw tylko ten składnik' }).click();

  await expect(row(device, 'Jajk')).toContainText('pominięty');
  await expect(row(device, 'Ogór')).not.toContainText('pominięty');
  const only = await mealKcal(device);
  expect(only).toBeLessThan(planned);

  await device.getByRole('button', { name: 'Przywróć oryginał' }).click();
  await device.getByRole('button', { name: 'Przywróć', exact: true }).last().click();

  await expect(device.getByText('Zmieniony wobec przepisu:')).toHaveCount(0);
  expect(await mealKcal(device)).toBe(planned);
});

test('an added ingredient raises the meal and joins the shopping list', async ({ device }) => {
  await seedMeal(device);
  await openMeal(device);
  const planned = await mealKcal(device);

  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik', { exact: true }).fill('ser mozzarella');
  await device.getByRole('listbox', { name: 'Składnik' }).getByRole('option').first().click();

  await expect(row(device, 'mozzarella')).toContainText('dodany');
  expect(await mealKcal(device)).toBeGreaterThan(planned);

  await device.getByRole('button', { name: 'Lista zakupów' }).click();
  await expect(sheet(device).getByText(/Ser mozzarella/)).toBeVisible();

  // Meaningful under `npm run test:e2e:csp`: the phase adds no script, style, font, image
  // source or outbound request, so the production policy has nothing new to admit.
  expect(await cspViolations(device), 'the meal screen reported a CSP violation').toEqual([]);
});

test('the shopping list stops buying a skipped row, and a copy carries the change', async ({
  device
}) => {
  await seedMeal(device);
  await openMeal(device);

  // With the meal untouched, both ingredients are on the list.
  await device.getByRole('button', { name: 'Lista zakupów' }).click();
  await expect(sheet(device).getByText(/Jajk/)).toBeVisible();
  await device.getByRole('button', { name: 'Zamknij' }).click();

  await row(device, 'Jajk').getByRole('button', { name: 'Pomiń' }).click();
  await expect(row(device, 'Jajk')).toContainText('pominięty');

  await device.getByRole('button', { name: 'Lista zakupów' }).click();
  await expect(sheet(device).getByText(/Ogór/)).toBeVisible();
  await expect(sheet(device).getByText(/Jajk/)).toHaveCount(0);
  await device.getByRole('button', { name: 'Zamknij' }).click();

  // „Dodaj też jutro" copies the meal — and a copy starts where its source ended.
  await device.getByLabel('Dodaj też jutro').click();
  await expect(device.getByText('Ten przepis jest zaplanowany na')).toBeVisible();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await device.goto(`#/day/${tomorrow.toISOString().slice(0, 10)}`);

  const copy = device.getByRole('link', { name: new RegExp(RECIPE) }).first();
  await expect(copy).toContainText('zmieniony');

  // Editing the copy does not reach back into the original.
  await copy.click();
  await device.getByRole('button', { name: 'Przywróć oryginał' }).click();
  await device.getByRole('button', { name: 'Przywróć', exact: true }).last().click();
  await expect(device.getByText('Zmieniony wobec przepisu:')).toHaveCount(0);

  await device.goto('#/');
  await expect(device.getByRole('link', { name: new RegExp(RECIPE) }).first()).toContainText(
    'zmieniony'
  );
});
