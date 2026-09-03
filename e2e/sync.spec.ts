import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { daysDocument, recipe, seedAccount } from './seed';

/**
 * Synchronisation between two devices over one Drive folder.
 *
 * Each device is its own browser context: its own IndexedDB, its own Google session, its own
 * copy of the app. They share only the `FakeDrive` — which is exactly the situation PLAN.md's
 * two-browser acceptance criterion describes, and the one the unit suite can only approximate
 * with two repositories in a single process.
 */

const CONNECT = 'Połącz Dysk Google';
const DRIVE_RECIPE = 'Naleśniki z Dysku';

const status = (page: Page) =>
  page.locator('dt', { hasText: 'Stan' }).locator('xpath=following-sibling::dd[1]');

/** Local `YYYY-MM-DD`, matching what `todayDate()` computes in the browser. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function connect(page: Page): Promise<void> {
  await page.getByRole('button', { name: CONNECT }).click();
  await expect(status(page)).toContainText('Połączono');
}

async function syncNow(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Ustawienia' }).click();
  await page.getByRole('button', { name: 'Synchronizuj teraz' }).click();
  await expect(status(page)).toContainText('Połączono');
}

async function createRecipe(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Przepisy' }).click();
  await page.getByRole('link', { name: 'Nowy przepis' }).click();
  await page.getByPlaceholder('np. Owsianka z bananem').fill(name);
  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();
}

/** Plan `name` on today, from the day screen. „Kalendarz" is the nav item for `#/`. */
async function planMeal(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: 'Kalendarz' }).click();
  // An empty day offers the action twice: once in its empty state and once as the floating
  // button, which is the one always present.
  const add = page.getByRole('button', { name: 'Dodaj posiłek' }).last();
  await add.click();
  // Scoped to the picker sheet: once a meal is on the day, the same recipe name is also on
  // the screen behind it.
  await page.getByRole('dialog').getByRole('button', { name }).first().click();
  await expect(add).toBeVisible();
}

test('an edit is pushed to Drive on its own, without anyone clicking sync', async ({ device, drive }) => {
  seedAccount(drive);
  await connect(device);

  await createRecipe(device, 'Zupa pomidorowa');

  // No sync button is touched: `scheduleSync` debounces and pushes by itself.
  await expect
    .poll(() => JSON.stringify(drive.snapshot()['recipes.json']), { timeout: 20_000 })
    .toContain('Zupa pomidorowa');
});

test('a recipe made on one device appears on the other', async ({ openDevice, drive }) => {
  seedAccount(drive);

  const first = await openDevice();
  await connect(first);
  await createRecipe(first, 'Zupa pomidorowa');
  await syncNow(first);

  const second = await openDevice();
  await connect(second);

  await second.getByRole('link', { name: 'Przepisy' }).click();
  await expect(second.getByText('Zupa pomidorowa')).toBeVisible();
  await expect(second.getByText(DRIVE_RECIPE)).toBeVisible();
});

test('two devices editing different recipes both keep their work', async ({ openDevice, drive }) => {
  seedAccount(drive);

  const first = await openDevice();
  const second = await openDevice();
  await connect(first);
  await connect(second);

  await createRecipe(first, 'Zupa pomidorowa');
  await createRecipe(second, 'Sałatka grecka');

  await syncNow(first);
  await syncNow(second);
  // Pull the other side's work back to the first device.
  await syncNow(first);

  for (const device of [first, second]) {
    await device.getByRole('link', { name: 'Przepisy' }).click();
    await expect(device.getByText('Zupa pomidorowa')).toBeVisible();
    await expect(device.getByText('Sałatka grecka')).toBeVisible();
  }
});

test('the same day changed in two places raises the prompt and honours the answer', async ({
  device,
  drive
}) => {
  // Two full sync passes and a good deal of UI driving.
  test.slow();
  const date = today();
  const month = date.slice(0, 7);
  seedAccount(drive, { recipes: [recipe({ id: 'recipe-drive-1', name: DRIVE_RECIPE })] });

  await connect(device);
  await planMeal(device, DRIVE_RECIPE);
  await syncNow(device);

  // Another device plans two meals on the same day and gets there first.
  drive.put(
    `days/${month}.json`,
    daysDocument({
      [date]: {
        date,
        meals: [
          {
            id: 'meal-remote-1',
            recipeId: 'recipe-drive-1',
            cookingScale: 1,
            portionsEaten: 1,
            macroSnapshot: { kcal: 500, protein: 20, carbs: 60, fat: 15 }
          },
          {
            id: 'meal-remote-2',
            recipeId: 'recipe-drive-1',
            cookingScale: 1,
            portionsEaten: 2,
            macroSnapshot: { kcal: 500, protein: 20, carbs: 60, fat: 15 }
          }
        ]
      }
    })
  );

  // ...and this device changes the same day too, so neither side can simply win.
  await planMeal(device, DRIVE_RECIPE);
  await device.getByRole('link', { name: 'Ustawienia' }).click();
  await device.getByRole('button', { name: 'Synchronizuj teraz' }).click();

  const dialog = device.getByRole('dialog');
  await expect(dialog.getByText('Ten sam dzień zmieniony w dwóch miejscach')).toBeVisible();
  // Both versions are described, so the choice is an informed one.
  await expect(dialog.getByRole('button', { name: /Ta wersja/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Wersja z Dysku/ })).toBeVisible();

  await dialog.getByRole('button', { name: /Wersja z Dysku/ }).click();
  await dialog.getByRole('button', { name: 'Zapisz wybór' }).click();
  await expect(status(device)).toContainText('Połączono');

  // Drive's version won, so the day now holds its two meals.
  await device.getByRole('link', { name: 'Kalendarz' }).click();
  await expect(device.getByText(DRIVE_RECIPE)).toHaveCount(2);
});

test('an abandoned conflict prompt writes nothing on either side', async ({ device, drive }) => {
  test.slow();
  const date = today();
  const month = date.slice(0, 7);
  seedAccount(drive, { recipes: [recipe({ id: 'recipe-drive-1', name: DRIVE_RECIPE })] });

  await connect(device);
  await planMeal(device, DRIVE_RECIPE);
  await syncNow(device);

  const remote = daysDocument({
    [date]: {
      date,
      meals: [
        {
          id: 'meal-remote-1',
          recipeId: 'recipe-drive-1',
          cookingScale: 1,
          portionsEaten: 1,
          macroSnapshot: { kcal: 500, protein: 20, carbs: 60, fat: 15 }
        }
      ]
    }
  });
  drive.put(`days/${month}.json`, remote);
  await planMeal(device, DRIVE_RECIPE);

  await device.getByRole('link', { name: 'Ustawienia' }).click();
  await device.getByRole('button', { name: 'Synchronizuj teraz' }).click();
  const dialog = device.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Anuluj synchronizację' }).click();

  await expect(device.getByText('Synchronizacja przerwana. Nic nie zostało zmienione.')).toBeVisible();
  // Byte for byte what the other device left there.
  expect(drive.get(`days/${month}.json`)).toBe(remote);
  await device.getByRole('link', { name: 'Kalendarz' }).click();
  await expect(device.getByText(DRIVE_RECIPE)).toHaveCount(2);
});

test('a different Google account is refused until the user says otherwise', async ({ device, drive }) => {
  seedAccount(drive);
  await connect(device);

  // The same browser, a different Google account behind it.
  drive.account = { permissionId: 'sub-2', emailAddress: 'ktos.inny@example.com', displayName: 'Inny' };
  await device.getByRole('button', { name: 'Synchronizuj teraz' }).click();

  await expect(device.getByText('To jest inne konto Google niż poprzednio.')).toBeVisible();
  await expect(
    device.getByText('To konto Google jest inne niż to, z którego pochodzą dane na tym urządzeniu.')
  ).toBeVisible();

  await device.getByRole('button', { name: 'Używaj tego konta' }).click();
  await expect(status(device)).toContainText('ktos.inny@example.com');
  await expect(device.getByText('To jest inne konto Google niż poprzednio.')).toHaveCount(0);
});

test('an edit made while Drive is unreachable is pushed when it comes back', async ({ device, drive }) => {
  seedAccount(drive);
  await connect(device);

  drive.offline = true;
  await createRecipe(device, 'Zupa pomidorowa');
  await device.waitForTimeout(6000);
  expect(JSON.stringify(drive.snapshot()['recipes.json'])).not.toContain('Zupa pomidorowa');

  drive.offline = false;
  await device.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(() => JSON.stringify(drive.snapshot()['recipes.json']), { timeout: 20_000 })
    .toContain('Zupa pomidorowa');
});

/**
 * Reported after a day of two-device use, and the reason the sync felt broken when it was not:
 * every screen read its data once, when it mounted, so a pull that landed under an open screen
 * was invisible — for as long as the user kept looking at it, while `startAutoSync` went on
 * pulling every few minutes (STATE.md decision 228).
 */
test('a day planned on the other device appears under an open calendar', async ({
  openDevice,
  drive
}) => {
  seedAccount(drive);

  const device = await openDevice();
  await connect(device);

  // The other device plans today's dinner and syncs it.
  const today = await device.evaluate(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  drive.put(
    `days/${today.slice(0, 7)}.json`,
    daysDocument({
      [today]: {
        date: today,
        meals: [
          {
            id: 'meal-elsewhere',
            recipeId: 'recipe-drive-1',
            cookingScale: 1,
            portionsEaten: 1,
            macroSnapshot: { kcal: 500, protein: 20, carbs: 60, fat: 15 }
          }
        ]
      }
    })
  );

  // Stand on the calendar and let a sync land, without navigating anywhere: coming back to
  // the app is one of the three moments `startAutoSync` syncs on.
  await device.goto('#/');
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible();
  await device.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(device.getByText(DRIVE_RECIPE)).toBeVisible();
});
