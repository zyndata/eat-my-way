import type { Page } from '@playwright/test';
import type { Recipe } from '../src/lib/types';
import { expect, test } from './fixtures';
import { DEFAULT_GOALS, profileDocument, recipesDocument } from './seed';

/**
 * The meal planner (PLAN.md Phase 13), driven through the real screens.
 *
 * The solver's rules are pinned by `src/lib/planner.test.ts` against a seeded generator; what
 * these add is the half a unit test cannot reach — that the buttons exist, that nothing is
 * written before „Zastosuj", that a batch written by the planner is indistinguishable from
 * one written by the „Dodaj też jutro" checkbox, and that the template really does travel on
 * `profile.json`. No network is involved anywhere: the planner never talks to Gemini.
 */

const CONNECT = 'Połącz Dysk Google';

const status = (page: Page) =>
  page.locator('dt', { hasText: 'Stan' }).locator('xpath=following-sibling::dd[1]');

/**
 * A recipe whose macros need no ingredient row: `macroOverride` is the per-100 g value used
 * at the point of use, and 100 g of it is exactly one portion.
 */
function plannerRecipe(id: string, name: string, kcal: number, tags: string[] = []): Recipe {
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
    tags,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z'
  };
}

const LIBRARY: Recipe[] = [
  plannerRecipe('r1', 'Owsianka', 320),
  plannerRecipe('r2', 'Jajecznica', 380),
  plannerRecipe('r3', 'Kanapki', 450),
  plannerRecipe('r4', 'Gulasz', 520),
  plannerRecipe('r5', 'Pierogi', 610),
  plannerRecipe('r6', 'Zapiekanka', 680),
  plannerRecipe('r7', 'Kotlet z ziemniakami', 740),
  plannerRecipe('r8', 'Lasagne', 820),
  plannerRecipe('r9', 'Jogurt z owocami', 180),
  plannerRecipe('r10', 'Sałatka', 240),
  plannerRecipe('r11', 'Koktajl', 290),
  plannerRecipe('r12', 'Ryba z warzywami', 560)
];

/** Put a library on the account and connect the device to it. */
async function connectWith(
  page: Page,
  drive: { put: (name: string, content: string) => void },
  options: { recipes?: Recipe[]; mealPlan?: unknown } = {}
): Promise<void> {
  drive.put(
    'profile.json',
    profileDocument({
      googleSub: 'sub-1',
      ...(options.mealPlan === undefined ? {} : { mealPlan: options.mealPlan })
    } as Record<string, unknown>)
  );
  drive.put('recipes.json', recipesDocument(options.recipes ?? LIBRARY));

  await page.getByRole('button', { name: CONNECT }).click();
  await expect(status(page)).toContainText('Połączono');
}

test('an empty day is planned from one button, and nothing is written until „Zastosuj"', async ({
  device,
  drive
}) => {
  await connectWith(device, drive);
  await device.goto('#/');

  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  // One row per template slot — the built-in default, which a profile without a template gets.
  const sheet = device.getByRole('dialog');
  await expect(sheet.getByText('Śniadanie', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Obiad', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Podwieczorek', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Kolacja', { exact: true })).toBeVisible();

  // Still a proposal: the day behind the sheet has nothing on it.
  await sheet.getByRole('button', { name: 'Zamknij' }).click();
  await expect(device.getByText('Nic jeszcze nie zaplanowano na ten dzień.')).toBeVisible();

  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();
  await device.getByRole('button', { name: 'Zastosuj', exact: true }).click();

  await expect(device.getByText('Nic jeszcze nie zaplanowano na ten dzień.')).toHaveCount(0);

  // Applying lands the day inside ±15% of its goal — the band the solver is held to.
  const header = device.locator('header').filter({ hasText: 'kcal' }).first();
  await expect(header).toContainText(`/ ${DEFAULT_GOALS.kcal} kcal`);
  const text = (await header.textContent()) ?? '';
  const planned = Number(/(\d+)\s*\/\s*2000 kcal/.exec(text.replace(/\s+/g, ' '))?.[1] ?? 0);
  expect(Math.abs(planned - DEFAULT_GOALS.kcal)).toBeLessThanOrEqual(0.15 * DEFAULT_GOALS.kcal);
});

test('a half-planned day is completed, not replaced', async ({ device, drive }) => {
  await connectWith(device, drive);
  await device.goto('#/');

  // Two meals by hand first — this is „Uzupełnij dzień", the primary path.
  for (const name of ['Owsianka', 'Gulasz']) {
    await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
    await device.getByRole('dialog').getByText(name, { exact: true }).click();
    await expect(device.getByRole('dialog')).toBeHidden();
  }
  await expect(device.getByRole('link', { name: /Owsianka/ })).toBeVisible();

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Uzupełnij dzień' }).click();

  const sheet = device.getByRole('dialog');
  // Both are shown as fixed input rather than as something to reroll.
  await expect(sheet.getByText('· już zaplanowane')).toHaveCount(2);
  await sheet.getByRole('button', { name: 'Zastosuj', exact: true }).click();

  // The two survive, and the day gained the rest — one meal per template slot.
  const meals = device.getByRole('list', { name: 'Posiłki dnia' }).getByRole('listitem');
  await expect(meals).toHaveCount(4);
  await expect(meals.filter({ hasText: 'Owsianka' })).toHaveCount(1);
  await expect(meals.filter({ hasText: 'Gulasz' })).toHaveCount(1);
});

test('a slot can be locked and the rest rerolled, and one slot rerolled on its own', async ({
  device,
  drive
}) => {
  await connectWith(device, drive);
  await device.goto('#/');
  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  const sheet = device.getByRole('dialog');
  // Every proposed cook carries a lock whose label names the recipe, which is the most stable
  // handle on „what is currently in this slot".
  const locks = sheet.getByRole('button', { name: /^(Zablokuj|Odblokuj) / });
  await expect(locks).toHaveCount(4);

  const nameOf = async (index: number): Promise<string> =>
    ((await locks.nth(index).getAttribute('aria-label')) ?? '').replace(/^(Zablokuj|Odblokuj) /, '');

  const dinner = await nameOf(1);
  await sheet.getByRole('button', { name: `Zablokuj ${dinner}` }).click();

  // „Losuj ponownie" changes the plan but never the locked row.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sheet.getByRole('button', { name: 'Losuj ponownie' }).click();
    expect(await nameOf(1)).toBe(dinner);
  }

  // Rerolling one slot leaves every other row exactly where it was.
  const before = await Promise.all([0, 1, 2, 3].map(nameOf));
  await sheet.getByRole('button', { name: 'Przelosuj Kolacja' }).click();
  const after = await Promise.all([0, 1, 2, 3].map(nameOf));
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3));

  // And it keeps rerolling: the search would otherwise answer the same recipe every time,
  // so the second click looked like a dead button (decision 288).
  let previous = await nameOf(3);
  for (let click = 0; click < 3; click += 1) {
    await sheet.getByRole('button', { name: 'Przelosuj Kolacja' }).click();
    const next = await nameOf(3);
    expect(next).not.toBe(previous);
    previous = next;
  }
});

test('a week is planned, applied, and its batch reads as a batch on the meal screen', async ({
  device,
  drive
}) => {
  await connectWith(device, drive);
  await device.goto('#/');

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Zaplanuj tydzień' }).click();

  const sheet = device.getByRole('dialog');
  // Seven day cards, each with a tick that decides whether it is written.
  await expect(sheet.locator('input[type="checkbox"]')).toHaveCount(7);

  // „Obiad" ships batched for two days in the default template, so at least one row says so.
  await expect(sheet.getByText(/Gotujesz na 2 dni/).first()).toBeVisible();

  await sheet.getByRole('button', { name: 'Zastosuj', exact: true }).click();
  await expect(sheet).toBeHidden();

  // The day the sheet was opened on now has meals, and so does the rest of the week.
  await expect(
    device.getByRole('list', { name: 'Posiłki dnia' }).getByRole('listitem')
  ).not.toHaveCount(0);

  // A batch written by the planner is the same thing the checkbox writes: the meal screen
  // recognises tomorrow's copy and shows the box ticked (PLAN.md „Gotowanie na zapas").
  const days = await device.evaluate(async () => {
    const request = indexedDB.open('eat-my-way');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<
      {
        date: string;
        meals: { id: string; recipeId: string; cookingScale: number; portionsEaten: number }[];
      }[]
    >((resolve, reject) => {
      const all = database.transaction('days').objectStore('days').getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    });
  });

  const nextDay = (date: string): string => {
    const at = new Date(`${date}T12:00:00`);
    at.setDate(at.getDate() + 1);
    return at.toISOString().slice(0, 10);
  };

  // The cooking day of a run: the same recipe is on tomorrow, and the pot holds more than
  // this day eats.
  const cook = days
    .flatMap((day) => day.meals.map((meal) => ({ ...meal, date: day.date })))
    .find((meal) => {
      const tomorrow = days.find((day) => day.date === nextDay(meal.date));
      return (
        meal.cookingScale > meal.portionsEaten &&
        tomorrow?.meals.some((other) => other.recipeId === meal.recipeId) === true
      );
    });
  expect(cook, 'the week should contain a pot cooked for more than one day').toBeDefined();
  if (cook === undefined) return;

  // `cookingScale = runLength × portionsEaten` — the invariant that would otherwise surface
  // only as a shopping list that under-buys (STATE.md decision 268).
  expect(cook.cookingScale).toBeCloseTo(2 * cook.portionsEaten, 5);

  await device.goto(`#/day/${cook.date}/${cook.id}`);
  const alsoTomorrow = device.getByRole('checkbox', { name: 'Dodaj też jutro' });
  await expect(alsoTomorrow).toBeChecked();

  // …and unticking it behaves exactly as it does for a batch made by hand: it asks first.
  await alsoTomorrow.click();
  await expect(device.getByRole('heading', { name: /Usunąć|Odznaczyć/ })).toBeVisible();
});

test('a week already under budget corrects the day’s target and says so', async ({
  device,
  drive
}) => {
  await connectWith(device, drive);

  // Monday and Tuesday of the current week — the same Monday-to-Sunday week whatever day the
  // suite is run on, which is what the balance is measured over.
  const week = await device.evaluate(() => {
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return [0, 1].map((offset) => {
      const at = new Date(monday);
      at.setDate(at.getDate() + offset);
      return [
        at.getFullYear(),
        String(at.getMonth() + 1).padStart(2, '0'),
        String(at.getDate()).padStart(2, '0')
      ].join('-');
    });
  });

  await device.goto(`#/day/${week[0]}`);
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('dialog').getByText('Jogurt z owocami', { exact: true }).click();
  await expect(device.getByRole('dialog')).toBeHidden();

  await device.goto(`#/day/${week[1]}`);
  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  // Monday came in far under 2000 kcal, so the rest of the week is told it has room.
  await expect(
    device.getByRole('dialog').getByText(/W tym tygodniu masz zapas \d+ kcal/)
  ).toBeVisible();
});

test('the recipes it may not use are named, not silently dropped', async ({ device, drive }) => {
  await connectWith(device, drive, {
    recipes: [
      ...LIBRARY,
      plannerRecipe('rx', 'Ciasto na urodziny', 900, ['nie-planuj']),
      // An item that cannot contribute macros: `szt` with no weight per piece.
      {
        ...plannerRecipe('ry', 'Niedokończony przepis', 400),
        items: [{ ingredientId: 'custom:ry', amount: 2, unit: 'szt' as const }]
      }
    ]
  });
  await device.goto('#/');
  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet.getByText(/Pominięto 2 przepisy/)).toBeVisible();
  await expect(sheet.getByText(/z tagiem „nie-planuj"/)).toBeVisible();
  await expect(sheet.getByText(/z niekompletnymi składnikami/)).toBeVisible();
  // …and the excluded recipe is nowhere in the proposal.
  await expect(sheet.getByText('Ciasto na urodziny')).toHaveCount(0);
});

test('a run’s length is changed in the proposal without touching the template', async ({
  device,
  drive
}) => {
  await connectWith(device, drive);
  await device.goto('#/');

  await device.getByLabel('Menu dnia').click();
  await device.getByRole('button', { name: 'Zaplanuj tydzień' }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet.getByText(/Gotujesz na 2 dni/).first()).toBeVisible();

  // The 1/2/3 control on the first cook that spans days: stretch it to three.
  const stretch = sheet.getByRole('button', { name: 'Gotuj na 3 dni' }).first();
  await stretch.click();
  await expect(sheet.getByText(/Gotujesz na 3 dni/).first()).toBeVisible();

  // A one-off: „w tę niedzielę mam też wolny poniedziałek" is not a rule about Sundays, so
  // the template in Settings is exactly as it was (STATE.md decision 274).
  await sheet.getByRole('button', { name: 'Zamknij' }).click();
  await device.goto('#/settings');
  const planner = device.locator('section').filter({ hasText: 'Planer posiłków' }).first();
  await expect(planner.getByRole('button', { name: 'Obiad: gotuję na 2 dni' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(
    planner.getByRole('button', { name: 'Niedziela: gotuję na 3 dni' })
  ).toHaveAttribute('aria-pressed', 'false');
});

test('the sheet says which case „za mało przepisów" is', async ({ device, drive }) => {
  // An account with no recipes at all: the library is too small outright.
  await connectWith(device, drive, { recipes: [] });
  await device.goto('#/');
  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  const sheet = device.getByRole('dialog');
  await expect(sheet.getByText('Za mało przepisów')).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Zastosuj/ })).toBeDisabled();
});

test('a template from Drive is obeyed, tags and all', async ({ device, drive }) => {
  await connectWith(device, drive, {
    mealPlan: {
      slots: [
        { id: 'jedyny', label: 'Jedyny posiłek', tagKeys: ['nie-ma-takiego'], share: 1, batchDays: 1 }
      ]
    }
  });
  await device.goto('#/');
  await device.getByRole('button', { name: 'Zaplanuj dzień', exact: true }).click();

  const sheet = device.getByRole('dialog');
  // The template survived `profile.json`, and the failure names the slot and the tag.
  await expect(sheet.getByText('Brak przepisów na „Jedyny posiłek"')).toBeVisible();
  await expect(sheet.getByText(/nie-ma-takiego/)).toBeVisible();
});

test('the template editor saves a weekday that cooks differently', async ({ device, drive }) => {
  await connectWith(device, drive);

  const planner = device.locator('section').filter({ hasText: 'Planer posiłków' }).first();
  await planner.getByRole('button', { name: 'Niedziela: gotuję na 3 dni' }).click();
  await planner.getByRole('button', { name: 'Zapisz planer' }).click();
  await expect(planner.getByText('Zapisano.')).toBeVisible();

  // It survives a reload, and it reaches Drive on the existing profile path.
  await device.reload();
  await expect(
    device.getByRole('button', { name: 'Niedziela: gotuję na 3 dni' })
  ).toHaveAttribute('aria-pressed', 'true');

  await expect
    .poll(() => JSON.stringify(drive.snapshot()['profile.json']), { timeout: 20_000 })
    .toContain('cookDays');
});
