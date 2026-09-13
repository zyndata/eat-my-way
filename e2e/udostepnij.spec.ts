import type { Locator, Page } from '@playwright/test';
import { expect, nutritionReady, openRecipeEditor, test } from './fixtures';
import { cspViolations } from './fake-google';

/**
 * „Przepis dla kogoś" (PLAN.md Phase 22), driven through the real screens.
 *
 * The text itself is pinned rule by rule in `src/lib/recipe-share.test.ts`. What this adds is
 * the half a unit test cannot reach: that the two buttons are where the plan puts them and
 * absent where it says, that the editor refuses to share a draft, that a planned meal sends
 * what is actually being cooked at the number it is cooked at, and that the sheet's count
 * never finds its way back into the plan.
 *
 * Every test replaces the two ways out before it acts. An init script turns `navigator.share`
 * into either nothing or a recorder, and `navigator.clipboard.writeText` into a recorder, so
 * the exact text is read back on both engines without clipboard permissions.
 *
 * Ingredient names come from the bundled USDA subset, so they are matched by their start.
 */

type Route = 'clipboard' | 'share' | 'fail';

interface Shared {
  title?: string;
  text: string;
}

/** Replace both ways out, then reload so the replacement is in place before the app runs. */
async function stubShare(page: Page, route: Route): Promise<void> {
  await page.context().addInitScript((mode: Route) => {
    const recorded: Shared[] = [];
    (window as unknown as { __shared: Shared[] }).__shared = recorded;

    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value:
        mode === 'clipboard'
          ? undefined
          : async (data: ShareData): Promise<void> => {
              // Not an `AbortError`: `shareText` reads that as the user closing the sheet.
              if (mode === 'fail') throw new DOMException('No share target', 'NotAllowedError');
              recorded.push({ title: data.title, text: data.text ?? '' });
            }
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string): Promise<void> => {
          if (mode === 'fail') throw new DOMException('Denied', 'NotAllowedError');
          recorded.push({ text });
        }
      }
    });
  }, route);
  await page.reload();
  await nutritionReady(page);
}

const shared = (page: Page): Promise<Shared[]> =>
  page.evaluate(() => (window as unknown as { __shared: Shared[] }).__shared);

const sheet = (page: Page): Locator => page.getByRole('dialog');
const sheetText = (page: Page): Locator => sheet(page).getByTestId('recipe-share-text');
const count = (page: Page): Locator => sheet(page).getByLabel('Porcje w przepisie');
const note = (page: Page): Locator => sheet(page).getByText(/Liczby w opisie przygotowania/);
const editorShare = (page: Page): Locator =>
  page.getByRole('button', { name: 'Udostępnij', exact: true });

/** Add a row and pick the first match for `query`. `amount` is typed after any chip. */
async function addIngredient(page: Page, position: number, query: string): Promise<void> {
  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel(`Składnik ${position}`).fill(query);
  await page
    .getByRole('listbox', { name: `Składnik ${position}` })
    .getByRole('option')
    .first()
    .click();
}

/** A recipe of bundled ingredients, 100 g of each unless said otherwise, saved. */
async function saveRecipe(page: Page, name: string, rows: readonly [string, string][]): Promise<void> {
  await openRecipeEditor(page);
  await page.getByLabel('Nazwa').fill(name);
  for (const [index, [query, amount]] of rows.entries()) {
    await addIngredient(page, index + 1, query);
    await page.getByLabel('Ilość').nth(index).fill(amount);
  }
  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
}

async function openSaved(page: Page, name: string): Promise<void> {
  await page.goto('#/recipes');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Edytuj przepis' })).toBeVisible();
}

/** Plan `name` onto today and open the meal screen. */
async function planAndOpen(page: Page, name: string): Promise<void> {
  await page.goto('#/');
  await page.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** The day header's „N / 2000 kcal". */
async function dayKcal(page: Page): Promise<number> {
  const text = await page.locator('p', { hasText: /\/ \d+ kcal$/ }).first().innerText();
  return Number.parseInt(text, 10);
}

const mealRow = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Składniki posiłku' }).getByRole('listitem').filter({ hasText: name });

// ---- from the recipe editor ----------------------------------------------------------------

test('a saved recipe goes out at three portions, in its own order, instructions untouched', async ({
  device
}) => {
  const RECIPE = 'Leczo na próbę';
  await stubShare(device, 'clipboard');

  await openRecipeEditor(device);
  await device.getByLabel('Nazwa').fill(RECIPE);
  await device.getByLabel('Czas przygotowania').fill('40');

  // „1 ząbek (5 g)" — the row the criteria are written against — then a gram row and a
  // millilitre row, in that order.
  await addIngredient(device, 1, 'czosnek');
  await device.getByRole('button', { name: /^ząbek · / }).click();
  await device.getByLabel('Ilość').nth(0).fill('1');
  await addIngredient(device, 2, 'ryż biały');
  await device.getByLabel('Ilość').nth(1).fill('100');
  await addIngredient(device, 3, 'mleko');
  await device.getByLabel('Jednostka').nth(2).selectOption('ml');
  await device.getByLabel('Ilość').nth(2).fill('200');

  await device.getByLabel('Instrukcje').fill('Pokrój czosnek.\nDodaj 200 g mąki.');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await openSaved(device, RECIPE);
  await editorShare(device).click();

  // The editor starts at one portion, and at one there is nothing to warn about.
  await expect(count(device)).toHaveValue('1');
  await expect(note(device)).toHaveCount(0);

  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await expect(count(device)).toHaveValue('3');
  await expect(note(device)).toBeVisible();

  await sheet(device).getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(sheet(device).getByRole('status')).toHaveText('Skopiowano do schowka.');

  const [first, ...rest] = await shared(device);
  expect(rest).toEqual([]);
  const text = first?.text ?? '';
  expect(text).toMatch(
    new RegExp(
      `^${RECIPE}\\n3 porcje · 40 min\\n\\nSkładniki:\\n` +
        '• Czosnek — 3 ząbki \\(15 g\\)\\n' +
        '• Ryż[^\\n]* — 300 g\\n' +
        '• [^\\n]+ — 600 ml\\n' +
        '\\nPrzygotowanie:\\nPokrój czosnek\\.\\nDodaj 200 g mąki\\.\\n$'
    )
  );
  // No macros, no link, and the note is the sheet's, not the message's.
  expect(text).not.toMatch(/kcal|Białko|Węglowodany|Tłuszcz|http/);
  expect(text).not.toContain('przeliczone');

  // A measure declines at 2 and at 1,5; a gram row and a millilitre row never carry brackets.
  await count(device).fill('2');
  await count(device).blur();
  await expect(sheetText(device)).toContainText('Czosnek — 2 ząbki (10 g)');
  await count(device).fill('1.5');
  await count(device).blur();
  await expect(sheetText(device)).toContainText('Czosnek — 1,5 ząbka (8 g)');
  await expect(sheetText(device)).toContainText('1,5 porcji · 40 min');
  expect(await sheetText(device).innerText()).not.toMatch(/ (g|ml) \(/);

  expect(await cspViolations(device), 'the share sheet reported a CSP violation').toEqual([]);
});

test('an unsaved change disables sharing until it is saved, and a new recipe has no button', async ({
  device
}) => {
  await stubShare(device, 'clipboard');

  await openRecipeEditor(device);
  await expect(editorShare(device)).toHaveCount(0);

  // No time and no instructions.
  await saveRecipe(device, 'Kanapka na próbę', [['ryż biały', '100']]);

  await openSaved(device, 'Kanapka na próbę');
  await expect(editorShare(device)).toBeEnabled();
  await expect(device.getByText('Zapisz zmiany, żeby udostępnić przepis.')).toHaveCount(0);

  await device.getByLabel('Nazwa').fill('Kanapka poprawiona');
  await expect(editorShare(device)).toBeDisabled();
  await expect(device.getByText('Zapisz zmiany, żeby udostępnić przepis.')).toBeVisible();

  // Undoing the change by hand is not a change.
  await device.getByLabel('Nazwa').fill('Kanapka na próbę');
  await expect(editorShare(device)).toBeEnabled();

  await device.getByLabel('Nazwa').fill('Kanapka poprawiona');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await openSaved(device, 'Kanapka poprawiona');
  await expect(editorShare(device)).toBeEnabled();
  await editorShare(device).click();

  // Without instructions there is nothing for the note to be about, at any count.
  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await expect(note(device)).toHaveCount(0);

  await sheet(device).getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(sheet(device).getByRole('status')).toHaveText('Skopiowano do schowka.');
  const text = (await shared(device))[0]?.text ?? '';
  expect(text).toMatch(/^Kanapka poprawiona\n2 porcje\n\nSkładniki:\n• Ryż[^\n]* — 200 g\n$/);
  expect(text).not.toContain('min');
  expect(text).not.toContain('Przygotowanie');
});

test('the system share sheet gets the text under the recipe name', async ({ device }) => {
  await stubShare(device, 'share');
  await saveRecipe(device, 'Zupa na próbę', [['ryż biały', '50']]);
  await openSaved(device, 'Zupa na próbę');
  await editorShare(device).click();

  await sheet(device).getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(sheet(device).getByRole('status')).toHaveText('Udostępniono.');
  const [entry] = await shared(device);
  expect(entry?.title).toBe('Zupa na próbę');
  expect(entry?.text).toMatch(/^Zupa na próbę\n1 porcja\n/);
});

test('when neither route works the text stays on screen to copy by hand', async ({ device }) => {
  await stubShare(device, 'fail');
  await saveRecipe(device, 'Placki na próbę', [['ryż biały', '50']]);
  await openSaved(device, 'Placki na próbę');
  await editorShare(device).click();

  await sheet(device).getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(sheet(device).getByRole('status')).toHaveText(
    'Nie udało się udostępnić ani skopiować — zaznacz przepis powyżej i skopiuj ręcznie.'
  );
  await expect(sheetText(device)).toBeVisible();
  await expect(sheetText(device)).toContainText('Placki na próbę');
  expect(await shared(device)).toEqual([]);
});

// ---- from a planned meal -------------------------------------------------------------------

test('a planned meal sends what is being cooked, at its own count, and never writes back', async ({
  device
}) => {
  const RECIPE = 'Sałatka do wysłania';
  await stubShare(device, 'clipboard');
  await saveRecipe(device, RECIPE, [
    ['ogórek', '200'],
    ['jajko', '100'],
    ['ryż biały', '50']
  ]);
  await planAndOpen(device, RECIPE);

  // Cooked at 2, one row skipped, one swapped.
  await device.getByRole('button', { name: 'Więcej porcji do ugotowania' }).click();
  await expect(device.getByLabel('Porcje do ugotowania')).toHaveValue('2');
  await mealRow(device, 'Jajk').getByRole('button', { name: 'Pomiń' }).click();
  await expect(mealRow(device, 'Jajk')).toContainText('pominięty');
  await mealRow(device, 'Ryż').getByRole('button', { name: 'Zmień' }).click();
  await device.getByLabel('Składnik', { exact: true }).fill('kasza gryczana');
  await device.getByRole('listbox', { name: 'Składnik' }).getByRole('option').first().click();
  await expect(mealRow(device, 'Kasza')).toBeVisible();

  const mealUrl = device.url();
  await device.goto('#/');
  const plannedDay = await dayKcal(device);
  await device.goto(mealUrl);
  await expect(device.getByRole('heading', { name: RECIPE })).toBeVisible();

  await device.getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(count(device)).toHaveValue('2');
  await expect(sheetText(device)).toContainText('2 porcje');

  await sheet(device).getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(sheet(device).getByRole('status')).toHaveText('Skopiowano do schowka.');
  const text = (await shared(device))[0]?.text ?? '';
  // The skipped row is absent, not struck through; the swapped row names the substitute at
  // the swapped row's amount; the untouched row is doubled.
  expect(text).toMatch(/\n• Ogór[^\n]* — 400 g\n• Kasza[^\n]* — 100 g\n/);
  expect(text).not.toContain('Jajk');
  expect(text).not.toContain('Ryż');

  // The sheet's count is a question about a message, not about the plan.
  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await sheet(device).getByRole('button', { name: 'Więcej porcji w przepisie' }).click();
  await expect(count(device)).toHaveValue('5');
  await sheet(device).getByRole('button', { name: 'Zamknij' }).click();
  await expect(device.getByLabel('Porcje do ugotowania')).toHaveValue('2');

  await device.goto('#/');
  expect(await dayKcal(device)).toBe(plannedDay);

  await device.reload();
  await nutritionReady(device);
  expect(await dayKcal(device)).toBe(plannedDay);
  await device.goto(mealUrl);
  await expect(device.getByLabel('Porcje do ugotowania')).toHaveValue('2');

  // And the next opening starts from the meal again, not from the 5 chosen last time.
  await device.getByRole('button', { name: 'Udostępnij przepis' }).click();
  await expect(count(device)).toHaveValue('2');
});

test('a planned meal whose recipe was deleted has no share button', async ({ device }) => {
  const RECIPE = 'Obiad do usunięcia';
  await saveRecipe(device, RECIPE, [['ryż biały', '100']]);
  await planAndOpen(device, RECIPE);
  await expect(device.getByRole('button', { name: 'Udostępnij przepis' })).toBeVisible();

  await openSaved(device, RECIPE);
  await device.getByRole('button', { name: 'Usuń przepis' }).click();
  await device.getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await device.goto('#/');
  await device.getByRole('link', { name: /Usunięty przepis/ }).first().click();
  await expect(device.getByRole('heading', { name: 'Usunięty przepis' })).toBeVisible();
  await expect(device.getByRole('button', { name: 'Lista zakupów' })).toBeVisible();
  await expect(device.getByRole('button', { name: 'Udostępnij przepis' })).toHaveCount(0);
});
