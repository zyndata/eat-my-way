import type { Page } from '@playwright/test';
import type { Recipe } from '../src/lib/types';
import { expect, test } from './fixtures';
import { daysDocument, profileDocument, recipesDocument } from './seed';

/**
 * Kategorie posiłków w dniu (PLAN.md Phase 24), driven through the real screens.
 *
 * What a unit test cannot reach: that the day screen really is grouped by the template, that
 * „+ Dodaj" under a heading files what it adds, that the picker says where a meal is going and
 * lets it be changed there, and that a meal moved between two groups is still there after a
 * reload — the assignment lives on the meal, so it has to survive the round trip to IndexedDB.
 */

const CONNECT = 'Połącz Dysk Google';
const SHEET_CLOSES = { timeout: 60_000 };

/** The template the acceptance criteria name — five categories, in this order. */
const TEMPLATE = {
  slots: [
    { id: 'sniadanie', label: 'Śniadanie', tagKeys: [], share: 0.25, batchDays: 1 },
    { id: 'drugie', label: 'II śniadanie', tagKeys: [], share: 0.1, batchDays: 1 },
    { id: 'obiad', label: 'Obiad', tagKeys: [], share: 0.35, batchDays: 1 },
    { id: 'przekaska', label: 'Przekąska', tagKeys: [], share: 0.1, batchDays: 1 },
    { id: 'kolacja', label: 'Kolacja', tagKeys: [], share: 0.2, batchDays: 1 }
  ]
};

const status = (page: Page) =>
  page.locator('dt', { hasText: 'Stan' }).locator('xpath=following-sibling::dd[1]');

/** A recipe whose macros need no ingredient row — 100 g of it is exactly one portion. */
function simple(id: string, name: string, kcal: number): Recipe {
  return {
    id,
    name,
    instructions: '',
    items: [
      {
        ingredientId: `custom:${id}`,
        amount: 100,
        unit: 'g',
        macroOverride: { kcal, protein: kcal / 16, carbs: kcal / 9, fat: kcal / 30 }
      }
    ],
    tags: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z'
  };
}

const LIBRARY: Recipe[] = [
  simple('r1', 'Jajecznica', 380),
  simple('r2', 'Bułka z serem', 290),
  simple('r3', 'Kawa z mlekiem', 90),
  simple('r4', 'Gulasz', 520),
  simple('r5', 'Jogurt z owocami', 180)
];

function seed(drive: { put: (name: string, content: string) => void }): void {
  drive.put(
    'profile.json',
    profileDocument({ googleSub: 'sub-1', mealPlan: TEMPLATE } as Record<string, unknown>)
  );
  drive.put('recipes.json', recipesDocument(LIBRARY));
}

async function connect(
  page: Page,
  drive: { put: (name: string, content: string) => void }
): Promise<void> {
  seed(drive);
  await page.getByRole('button', { name: CONNECT }).click();
  await expect(status(page)).toContainText('Połączono');
}

/**
 * The floating button, which opens on „Pozostałe" and never guesses — so a category is always
 * chosen out loud here (decision 450). Also the only way onto a day that has no meals yet,
 * where the empty-day hint and its planner buttons still stand in for the list (decision 299).
 */
async function addFromCorner(page: Page, recipe: string, slot?: string): Promise<void> {
  await page.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  const picker = page.getByRole('dialog');
  if (slot !== undefined) await picker.getByLabel('Posiłek dnia').selectOption({ label: slot });
  await picker.getByText(recipe, { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden(SHEET_CLOSES);
}

/** „+ Dodaj" under one heading, then a recipe — the one-tap path. */
async function addUnder(page: Page, heading: string, recipe: string): Promise<void> {
  await page.getByRole('button', { name: `Dodaj do: ${heading}`, exact: true }).click();
  await page.getByRole('dialog').getByText(recipe, { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden(SHEET_CLOSES);
}

const group = (page: Page, heading: string) =>
  page.getByRole('list', { name: `Posiłki: ${heading}` }).getByRole('listitem');

/** `YYYY-MM-DD` for today and for tomorrow, as the hash routes spell them. */
function dateKey(offset = 0): string {
  const at = new Date();
  at.setDate(at.getDate() + offset);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

test('the day is grouped by the template, and three meals can sit under one heading', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  await addFromCorner(device, 'Jajecznica', 'Śniadanie');

  // Every category of the template, in its order — the empty ones included, because a day
  // with three categories planned still has to show the two that are not.
  const headings = device.getByRole('region', { name: 'Posiłki dnia' }).getByRole('region');
  await expect(headings).toHaveCount(TEMPLATE.slots.length);
  await expect(headings.nth(0)).toContainText('Śniadanie');
  await expect(headings.nth(1)).toContainText('II śniadanie');
  await expect(headings.nth(4)).toContainText('Kolacja');

  // „Śniadanie: jajecznica, bułka z serem, kawa" — a category holds as many as it is given.
  await addUnder(device, 'Śniadanie', 'Bułka z serem');
  await addUnder(device, 'Śniadanie', 'Kawa z mlekiem');
  await expect(group(device, 'Śniadanie')).toHaveCount(3);

  // And the heading says what the category comes to: 380 + 290 + 90.
  await expect(device.getByRole('region', { name: 'Śniadanie', exact: true })).toContainText(
    '760 kcal'
  );
});

test('„+ Dodaj" under a heading adds there, not at the end of the day', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  await addFromCorner(device, 'Jajecznica', 'Śniadanie');
  await addUnder(device, 'Kolacja', 'Gulasz');

  await expect(group(device, 'Kolacja')).toHaveCount(1);
  await expect(group(device, 'Kolacja').first()).toContainText('Gulasz');
  await expect(group(device, 'Śniadanie')).toHaveCount(1);

  // The picker opened from a heading arrives on it, and lets it be changed before the pick.
  await device.getByRole('button', { name: 'Dodaj do: Kolacja', exact: true }).click();
  const picker = device.getByRole('dialog');
  await expect(picker.getByLabel('Posiłek dnia')).toHaveValue('kolacja');
  await picker.getByLabel('Posiłek dnia').selectOption({ label: 'Obiad' });
  await picker.getByText('Jogurt z owocami', { exact: true }).click();
  await expect(device.getByRole('dialog')).toBeHidden(SHEET_CLOSES);

  await expect(group(device, 'Obiad')).toHaveCount(1);
  await expect(group(device, 'Kolacja')).toHaveCount(1);
});

test('the floating button opens on „Pozostałe" and files straight away when told to', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  // It never guesses: „first empty category" would say „Śniadanie" at ten at night.
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  const picker = device.getByRole('dialog');
  await expect(picker.getByLabel('Posiłek dnia')).toHaveValue('');
  await picker.getByText('Jajecznica', { exact: true }).click();
  await expect(device.getByRole('dialog')).toBeHidden(SHEET_CLOSES);

  await expect(group(device, 'Pozostałe')).toHaveCount(1);

  // And choosing one there files the meal without a drag.
  await addFromCorner(device, 'Gulasz', 'Kolacja');
  await expect(group(device, 'Kolacja')).toHaveCount(1);
  await expect(group(device, 'Kolacja').first()).toContainText('Gulasz');
});

test('a meal dragged into another category stays there after a reload', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  await addFromCorner(device, 'Jajecznica', 'Śniadanie');
  await expect(group(device, 'Śniadanie')).toHaveCount(1);

  /*
   * The keyboard drag: the same write the pointer makes (decision 443), and the one a test can
   * perform deterministically. Space on the handle starts it, focusing another zone moves the
   * card into it, space drops it. Both zones finalize in the same task — exactly the case
   * `MealList` coalesces into a single write.
   */
  await device.getByRole('button', { name: /^Przeciągnij.*Jajecznica/ }).focus();
  await device.keyboard.press(' ');
  await device.getByRole('list', { name: 'Posiłki: Kolacja' }).focus();
  await device.keyboard.press(' ');

  await expect(group(device, 'Kolacja')).toHaveCount(1);
  await expect(group(device, 'Śniadanie')).toHaveCount(0);

  await device.reload();
  await expect(group(device, 'Kolacja').first()).toContainText('Jajecznica');
  await expect(group(device, 'Śniadanie')).toHaveCount(0);
});

test('the same recipe is breakfast on one day and supper on another, at the same time', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');
  await addFromCorner(device, 'Jajecznica', 'Śniadanie');

  // Tomorrow, the same recipe, filed as supper. The assignment lives on the meal and a meal
  // lives on its day, so neither day knows about the other (decision 441).
  await device.goto(`#/day/${dateKey(1)}`);
  await addFromCorner(device, 'Jajecznica', 'Kolacja');
  await expect(group(device, 'Kolacja').first()).toContainText('Jajecznica');

  await device.goto(`#/day/${dateKey(0)}`);
  await expect(group(device, 'Śniadanie').first()).toContainText('Jajecznica');
  await expect(group(device, 'Kolacja')).toHaveCount(0);
});

test('„Posiłek dnia" on the meal screen is the same write by another route', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  await addFromCorner(device, 'Jajecznica', 'Śniadanie');
  await device.getByRole('link', { name: /Jajecznica/ }).click();

  await device.getByLabel('Posiłek dnia').selectOption({ label: 'Kolacja' });
  await expect(device.getByLabel('Posiłek dnia')).toHaveValue('kolacja');

  await device.goto(`#/day/${dateKey(0)}`);
  await expect(group(device, 'Kolacja').first()).toContainText('Jajecznica');
  await expect(group(device, 'Śniadanie')).toHaveCount(0);
});

test('a day written before this phase opens with every meal under „Pozostałe"', async ({
  device,
  drive
}) => {
  /*
   * No migration and no schema version: a meal with no `slotId` is a meal nobody filed, which
   * is exactly what it is. It comes back in the order it was written, and nothing is guessed
   * from position (decision 445).
   */
  seed(drive);
  const date = dateKey(0);
  drive.put(
    `days/${date.slice(0, 7)}.json`,
    daysDocument({
      [date]: {
        date,
        meals: [
          {
            id: 'old-1',
            recipeId: 'r4',
            cookingScale: 1,
            portionsEaten: 1,
            macroSnapshot: { kcal: 520, protein: 32, carbs: 57, fat: 17 }
          },
          {
            id: 'old-2',
            recipeId: 'r1',
            cookingScale: 1,
            portionsEaten: 1,
            macroSnapshot: { kcal: 380, protein: 23, carbs: 42, fat: 12 }
          }
        ]
      }
    })
  );

  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');
  await device.goto('#/');

  const rest = group(device, 'Pozostałe');
  await expect(rest).toHaveCount(2);
  // In the order they were written — no meal lost, no category guessed.
  await expect(rest.nth(0)).toContainText('Gulasz');
  await expect(rest.nth(1)).toContainText('Jajecznica');
  await expect(group(device, 'Śniadanie')).toHaveCount(0);
});

test('a category deleted in Settings leaves its meals under „Pozostałe"', async ({
  device,
  drive
}) => {
  await connect(device, drive);
  await device.goto('#/');

  await addFromCorner(device, 'Jogurt z owocami', 'Przekąska');
  await expect(group(device, 'Przekąska')).toHaveCount(1);

  // The template loses that row. The meal is not repaired: it simply has nowhere to sit, and
  // it keeps its id, so deleting a category and putting it back does not scatter a month of
  // days (decision 441).
  await device.goto('#/settings');
  const rows = device.getByRole('list', { name: 'Posiłki w planerze' }).getByRole('listitem');
  await rows
    .filter({ has: device.getByLabel('Przekąska: gotuję na 1 dzień') })
    .getByRole('button', { name: 'Usuń' })
    .click();
  await device.getByRole('button', { name: 'Zapisz planer' }).click();

  await device.goto('#/');
  await expect(device.getByRole('region', { name: 'Przekąska', exact: true })).toHaveCount(0);
  await expect(group(device, 'Pozostałe').first()).toContainText('Jogurt z owocami');
});

test('a long recipe name wraps in the library and in the picker, and is never clipped', async ({
  device,
  drive
}) => {
  /*
   * The rest of decision 433, which Phase 24 finished (decision 440): the library and the
   * picker still carried `truncate`, so „Sałatka z chrupiąc…" was all a phone showed of the one
   * thing on the row the user has to read.
   */
  const LONG = 'Sałatka z chrupiącym boczkiem i pieczoną dynią z piekarnika';
  await device.setViewportSize({ width: 360, height: 740 });

  seed(drive);
  drive.put('recipes.json', recipesDocument([...LIBRARY, simple('rlong', LONG, 520)]));
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  /** True when the text needs more width than the box it was given. */
  const clipped = async (where: ReturnType<typeof device.getByText>) => {
    await expect(where).toBeVisible();
    return where.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  };

  await device.goto('#/recipes');
  expect(await clipped(device.getByText(LONG, { exact: true }))).toBe(false);

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  const picker = device.getByRole('dialog');
  expect(await clipped(picker.getByText(LONG, { exact: true }))).toBe(false);
});
