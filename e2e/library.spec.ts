import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Phase 9's library and shopping-list work, driven through the real screens.
 *
 * The pure rules are covered by unit tests; what these add is that the buttons exist, that
 * they are reachable, and that the numbers a user actually sees are the ones the rules
 * produce. Meaningful against the Caddy container too (`npm run test:e2e:csp`), which is what
 * proves the drag library and the share button need no CSP widening.
 */

/** Write one recipe with one ingredient row and the given tags. */
async function writeRecipe(
  page: Page,
  name: string,
  options: { ingredient?: string; amount?: string; tags?: string[] } = {}
): Promise<void> {
  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill(name);

  for (const tag of options.tags ?? []) {
    // Enter commits what was typed, whether or not a suggestion is highlighted.
    await page.getByLabel('Tagi').fill(tag);
    await page.getByLabel('Tagi').press('Enter');
  }

  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel('Składnik 1').fill(options.ingredient ?? 'jajko');
  await page.getByRole('option').first().click();
  await page.getByLabel('Ilość').first().fill(options.amount ?? '100');

  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
}

test('the grouped view lists every recipe, and a multi-tagged one under each of its tags', async ({
  device
}) => {
  await writeRecipe(device, 'Kotlet', { tags: ['Obiad'] });
  await writeRecipe(device, 'Omlet', { tags: ['Obiad', 'Szybkie'] });
  await writeRecipe(device, 'Kanapka');

  await device.goto('#/recipes');
  await device.getByRole('button', { name: 'Grupuj po tagach' }).click();

  // „Obiad" holds two, „Szybkie" one, and the recipe with no tags is not lost.
  await expect(device.getByRole('heading', { name: 'Obiad (2)' })).toBeVisible();
  await expect(device.getByRole('heading', { name: 'Szybkie (1)' })).toBeVisible();
  await expect(device.getByRole('heading', { name: 'Bez tagu (1)' })).toBeVisible();

  // The multi-tagged recipe is under both of its tags, so it is on screen twice.
  await expect(device.getByRole('link', { name: /Omlet/ })).toHaveCount(2);
  await expect(device.getByRole('link', { name: /Kotlet/ })).toHaveCount(1);
  await expect(device.getByRole('link', { name: /Kanapka/ })).toHaveCount(1);

  // The choice survives a reload — it is remembered in the meta table.
  await device.reload();
  await expect(device.getByRole('heading', { name: 'Obiad (2)' })).toBeVisible();
});

test('the library can be reordered by name, and the choice is remembered', async ({ device }) => {
  await writeRecipe(device, 'Zupa');
  await writeRecipe(device, 'Ananas');

  await device.goto('#/recipes');
  // Default order is recent activity: „Ananas" was written last, so it leads.
  await expect(device.getByRole('link', { name: /kcal/ }).first()).toContainText('Ananas');

  await device.getByLabel('Sortuj').selectOption('name');
  await expect(device.getByRole('link', { name: /kcal/ }).first()).toContainText('Ananas');

  await device.getByLabel('Sortuj').selectOption('kcal');
  await device.reload();
  await expect(device.getByLabel('Sortuj')).toHaveValue('kcal');
});

test('„Powiel" makes an independent copy that keeps the tags', async ({ device }) => {
  await writeRecipe(device, 'Ryż z warzywami', { tags: ['Obiad'] });

  await device.goto('#/recipes');
  await device.getByRole('button', { name: 'Powiel' }).click();
  await expect(device.getByRole('link', { name: /Ryż z warzywami \(kopia\)/ })).toBeVisible();

  // Rewrite the copy from top to bottom.
  await device.getByRole('link', { name: /Ryż z warzywami \(kopia\)/ }).click();
  await device.getByLabel('Nazwa').fill('Kasza z warzywami');
  await device.getByLabel('Ilość').first().fill('500');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();

  // The original is untouched.
  await expect(device.getByRole('link', { name: /Kasza z warzywami/ })).toBeVisible();
  await device.getByRole('link', { name: /^Ryż z warzywami/ }).click();
  await expect(device.getByLabel('Ilość').first()).toHaveValue('100');
});

test('„Zmień" on an ingredient row can be taken back', async ({ device }) => {
  await writeRecipe(device, 'Owsianka', { ingredient: 'jajko', amount: '120' });

  await device.goto('#/recipes');
  await device.getByRole('link', { name: /^Owsianka/ }).click();

  // „Zmień" empties the row into the autocomplete...
  await device.getByRole('button', { name: 'Zmień', exact: true }).click();
  await expect(device.getByLabel('Składnik 1')).toBeVisible();

  // ...and „Anuluj zmianę" puts the ingredient back with its amount untouched.
  await device.getByRole('button', { name: 'Anuluj zmianę' }).click();
  await expect(device.getByRole('button', { name: /^Usuń składnik/ })).toBeVisible();
  await expect(device.getByLabel('Ilość').first()).toHaveValue('120');
});

test('a tag renamed in Settings follows every recipe that carries it', async ({ device }) => {
  await writeRecipe(device, 'Kotlet', { tags: ['Obiat'] });
  await writeRecipe(device, 'Omlet', { tags: ['Obiat'] });

  await device.goto('#/settings');
  await expect(device.getByText('2 przepisy')).toBeVisible();
  await device.getByRole('button', { name: 'Zmień nazwę' }).click();
  await device.getByLabel('Nowa nazwa tagu').fill('Obiad');
  await device.getByRole('button', { name: 'Zapisz', exact: true }).click();

  await device.goto('#/recipes');
  await device.getByRole('button', { name: 'Grupuj po tagach' }).click();
  await expect(device.getByRole('heading', { name: 'Obiad (2)' })).toBeVisible();
  await expect(device.getByRole('heading', { name: /Obiat/ })).toHaveCount(0);
});

test('the shopping list sums one ingredient across the day and follows the cooking scale', async ({
  device
}) => {
  await writeRecipe(device, 'Jajecznica', { ingredient: 'jajko', amount: '100' });

  // The same recipe twice on one day.
  await device.goto('#/');
  for (let n = 0; n < 2; n += 1) {
    await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
    // The picker's own card, not a meal card's drag handle behind the sheet.
    await device.getByRole('dialog').getByRole('button', { name: /Jajecznica/ }).click();
  }

  // Cook the first one as a triple batch, and eat only a quarter of it: the list must follow
  // the batch, not the plate.
  await device.getByRole('link', { name: /Jajecznica/ }).first().click();
  await device.getByLabel('Porcje do ugotowania').fill('3');
  await device.getByLabel('Porcje do ugotowania').blur();
  await device.getByLabel('Zjedzone porcje').fill('0.25');
  await device.getByLabel('Zjedzone porcje').blur();

  // One meal's list: 100 g × 3.
  await device.getByRole('button', { name: 'Lista zakupów' }).click();
  await expect(device.getByRole('dialog')).toContainText('300 g');

  // The whole day: 300 g from the scaled meal plus 100 g from the other.
  await device.goto('#/');
  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Lista zakupów — dzień' }).click();
  await expect(device.getByRole('dialog')).toContainText('400 g');
});

test('the picker states every remaining goal and offers half a portion where one fits', async ({
  device
}) => {
  // A small budget, so the arithmetic is easy to read: 1000 kcal for the whole day.
  await device.goto('#/settings');
  await device.getByLabel('Kalorie (kcal)').fill('1000');
  await device.getByLabel('Białko (g)').fill('60');
  await device.getByLabel('Węglowodany (g)').fill('0');
  await device.getByLabel('Tłuszcz (g)').fill('0');
  await device.getByRole('button', { name: 'Zapisz cele' }).click();
  await expect(device.getByText('Zapisano.')).toBeVisible();

  // Rapeseed oil is 884 kcal / 100 g, so the portions come out at 142, 1768 and 2652 kcal.
  await writeRecipe(device, 'Lekka', { ingredient: 'jajko', amount: '100' });
  await writeRecipe(device, 'Bomba', { ingredient: 'olej rzepakowy', amount: '200' });
  await writeRecipe(device, 'Megabomba', { ingredient: 'olej rzepakowy', amount: '300' });

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  const sheet = device.getByRole('dialog');

  // The header is a readout of every goal that is set — not only the kilocalories.
  await expect(sheet).toContainText('1000 kcal');
  await expect(sheet).toContainText('60 g białka');
  // Goals left at zero are not goals, so they say nothing.
  await expect(sheet).not.toContainText('g węglowodanów');

  // 1768 kcal does not fit whole but half of it does; 2652 does not fit even at half.
  const card = (name: string) => sheet.getByRole('button', { name: new RegExp(name) });
  await expect(card('Bomba')).toContainText('Zmieści się przy pół porcji');
  await expect(card('Lekka')).not.toContainText('pół porcji');

  const order = async (): Promise<string[]> =>
    (await sheet.getByRole('listitem').allInnerTexts()).map((text) => text.split('\n')[0] ?? '');
  // All three were written on the same day, so decision 46's tie-break — the Polish
  // alphabet — decides. What matters below is that the filter does not disturb it.
  const before = await order();
  expect(before).toEqual(['Bomba', 'Lekka', 'Megabomba']);

  await sheet.getByLabel('Zmieści się w limicie').check();
  // The one that cannot fit is gone, and the survivors are in exactly the order they were.
  expect(await order()).toEqual(['Bomba', 'Lekka']);
  await expect(card('Bomba')).toContainText('Zmieści się przy pół porcji');
});

test('ingredient rows can be reordered from the keyboard, and the order is saved', async ({
  device
}) => {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Sałatka');

  for (const [position, name] of [['1', 'jajko'], ['2', 'olej rzepakowy']] as const) {
    await device.getByRole('button', { name: 'Dodaj składnik' }).click();
    await device.getByLabel(`Składnik ${position}`).fill(name);
    // Scoped to the autocomplete's own listbox: a filled row above has a unit `<select>`,
    // whose entries are options too.
    await device.locator(`#recipe-item-${position}-listbox`).getByRole('option').first().click();
    await device.getByLabel('Ilość').nth(Number(position) - 1).fill('50');
  }

  const rows = device.getByRole('list', { name: 'Składniki przepisu' }).getByRole('listitem');
  await expect(rows.first()).toContainText('Jajko');

  // Space picks the row up, ArrowDown moves it, Space drops it — the library's keyboard
  // interface, with Enter left free (STATE.md decision 70).
  await device.getByLabel('Przenieś wiersz 1').focus();
  await device.keyboard.press('Space');
  await device.keyboard.press('ArrowDown');
  await device.keyboard.press('Space');
  await expect(rows.first()).toContainText('Olej');

  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await device.getByRole('link', { name: /Sałatka/ }).click();
  await expect(rows.first()).toContainText('Olej');
});

// ---- the suggestion list under a pointer (STATE.md decision 221) -------------------------

test('a suggestion commits when the pointer is released, not when it lands', async ({
  device
}) => {
  await device.goto('#/recipes/new/edit');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();

  // The open listbox carries the same accessible name, so the input is taken by role.
  const input = device.getByRole('combobox', { name: 'Składnik 1' });
  await input.fill('jajk');
  const listbox = device.locator('#recipe-item-1-listbox');
  const first = listbox.getByRole('option').first();
  await expect(first).toBeVisible();

  // On a touch screen a press on an option is just as likely to be the start of a scroll, so
  // nothing may be chosen by it — this is what selected the wrong ingredient under a finger.
  await first.dispatchEvent('pointerdown');
  await expect(listbox).toBeVisible();
  await expect(input).toHaveValue('jajk');

  await first.click();
  await expect(listbox).toHaveCount(0);
  // The row swaps the picker for the chosen ingredient, so the combobox is gone entirely.
  await expect(device.getByRole('list', { name: 'Składniki przepisu' })).toContainText('Jajko');
});

test('pressing the suggestion list itself does not close it', async ({ device }) => {
  await device.goto('#/recipes/new/edit');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();

  // The open listbox carries the same accessible name, so the input is taken by role.
  const input = device.getByRole('combobox', { name: 'Składnik 1' });
  await input.fill('jajk');
  const listbox = device.locator('#recipe-item-1-listbox');
  await expect(listbox).toBeVisible();

  // The panel's own padding stands in for its scrollbar: both make the press land on the
  // `<ul>` rather than on an option, which used to blur the input and close the list mid-drag.
  const box = await listbox.boundingBox();
  if (box === null) throw new Error('the listbox has no box');
  await device.mouse.move(box.x + box.width / 2, box.y + 2);
  await device.mouse.down();
  await expect(listbox).toBeVisible();
  await device.mouse.up();

  await expect(listbox).toBeVisible();
  await expect(input).toHaveValue('jajk');
});
