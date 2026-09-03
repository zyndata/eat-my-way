import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { cspViolations } from './fake-google';
import { recipe, seedAccount } from './seed';

/**
 * What daily use reported (PLAN.md Phase 11), driven through the real screens.
 *
 * Four of the seven tasks are checkable here. The install box's *cause* is not — Chrome's
 * installability verdict needs a real Android device (STATE.md decision 207) — and the
 * repository's About box is not in the build at all.
 */

// ---- task 1: the install box says nothing when it has nothing to offer -------------------

test('a browser with no install prompt and no iOS share sheet is told nothing at all', async ({
  device
}) => {
  // Headless Chromium fires no `beforeinstallprompt` and is not iOS, so this is exactly the
  // case that was reported: the section used to end with „look in your browser's menu", which
  // is not an instruction and read as a broken feature (STATE.md decision 189).
  await expect(device.getByRole('heading', { name: 'Aplikacja na urządzeniu' })).toHaveCount(0);
  await expect(device.getByRole('button', { name: 'Zainstaluj aplikację' })).toHaveCount(0);
  await expect(device.getByText('Ta przeglądarka nie daje przycisku instalacji')).toHaveCount(0);
});

test('the iOS share-sheet route is still offered, because it is one someone can follow', async ({
  openDevice
}) => {
  const device = await openDevice();
  // iOS is recognised without a UA string: `navigator.standalone` is the property Safari alone
  // defines, and it is the same signal `isStandalone()` already reads.
  await device.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: false, configurable: true });
  });
  await device.reload();

  await expect(device.getByRole('heading', { name: 'Aplikacja na urządzeniu' })).toBeVisible();
  await expect(device.getByText('Do ekranu początkowego')).toBeVisible();
});

// ---- task 2: the wizard on a database that has never been used ---------------------------

test('a browser that has never been used meets the wizard, and skipping it sticks', async ({
  openDevice
}) => {
  // `keepSetup` leaves the wizard where it is; every other spec's fixture skips it, which is
  // itself the proof that a fresh browser lands there.
  const device = await openDevice({ keepSetup: true });

  await expect(device.getByRole('heading', { name: 'Pierwsze uruchomienie' })).toBeVisible();
  expect(device.url()).toContain('#/setup');

  // The Drive step is skippable — the whole point of the local trigger is the user who never
  // connects an account.
  await device.getByRole('button', { name: 'Pomiń — tylko to urządzenie' }).click();
  await expect(device.getByRole('heading', { name: '3. Hasło główne' })).toBeVisible();

  await device.getByRole('button', { name: 'Pomiń kreator' }).click();
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible();

  // The flag that remembers this lives in `meta`, not in memory, so a reload does not reopen it.
  await device.reload();
  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible();
  expect(device.url()).not.toContain('#/setup');
});

test('a device that syncs an existing account is never sent to the wizard', async ({
  openDevice,
  drive
}) => {
  // A device is „never used" for the seconds before its first sync lands, so the local trigger
  // waits for `resumeSync()` to have had its say (STATE.md decision 193). Proving that means
  // taking away the other thing that would suppress the wizard: `setupDone` is deleted below,
  // so the only reason this reload does not land on the wizard is the account that arrived.
  seedAccount(drive, { recipes: [recipe({ name: 'Naleśniki z Dysku' })] });

  const device = await openDevice({ keepSetup: true });
  await device.getByRole('button', { name: 'Połącz Dysk Google' }).click();
  // The wizard only leaves step 1 on a sync that came back `ok`, which is also when the pull
  // has been written — so this is the signal that the account has landed.
  await expect(device.getByRole('heading', { name: '2. Twój profil' })).toBeVisible();
  await device.getByRole('button', { name: 'Pomiń kreator' }).click();

  await forgetSetupDone(device);
  await device.reload();

  await expect(device.getByRole('heading', { name: 'Dziś' })).toBeVisible();
  expect(device.url()).not.toContain('#/setup');
  // And the account really is there, so this is „a synced device", not „an empty one".
  await device.goto('#/recipes');
  await expect(device.getByText('Naleśniki z Dysku')).toBeVisible();
});

/** Delete the „this browser has been through the wizard" flag, leaving everything else. */
async function forgetSetupDone(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('eat-my-way');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').delete('setupDone');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      })
  );
}

// ---- task 4: the dark theme --------------------------------------------------------------

test('the theme is chosen in Settings, survives a reload and takes the browser chrome with it', async ({
  device
}) => {
  const scheme = device.locator('meta[name="color-scheme"]');
  const themeColor = device.locator('meta[name="theme-color"]');

  await expect(device.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(scheme).toHaveAttribute('content', 'light');

  await device.getByRole('radio', { name: 'Ciemny' }).check();

  await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Without these the browser's own form controls and scrollbars stay light around a dark app.
  await expect(scheme).toHaveAttribute('content', 'dark');
  await expect(themeColor).not.toHaveAttribute('content', '#399e43');

  // Applied before the first paint: `main.ts` reads the `localStorage` mirror synchronously.
  await device.reload();
  await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(device.getByRole('radio', { name: 'Ciemny' })).toBeChecked();

  // And the palette really moved — the page is not a dark attribute over a light page.
  const background = await device.evaluate(
    () => getComputedStyle(document.body).backgroundColor
  );
  expect(background).not.toBe('rgb(255, 255, 255)');

  // A stylesheet is exactly what `npm run dev` does not test faithfully; under the container
  // this run is the one that proves the theme needs no `'unsafe-inline'` for styles.
  expect(await cspViolations(device), 'the theme reported a CSP violation').toEqual([]);
});

test('„Jak system" follows the operating system while the app is open', async ({ device }) => {
  // The default, and the one choice that has to keep listening: the OS setting can change
  // under a tab that is already open.
  await expect(device.getByRole('radio', { name: 'Jak system' })).toBeChecked();

  await device.emulateMedia({ colorScheme: 'dark' });
  await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(device.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark');

  await device.emulateMedia({ colorScheme: 'light' });
  await expect(device.locator('html')).toHaveAttribute('data-theme', 'light');

  // An explicit choice wins over the system, in both directions.
  await device.getByRole('radio', { name: 'Ciemny' }).check();
  await device.emulateMedia({ colorScheme: 'light' });
  await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the busy spinner stands still under prefers-reduced-motion', async ({ openDevice }) => {
  const device = await openDevice();
  await device.emulateMedia({ reducedMotion: 'reduce' });

  // Rendered by hand: the spinner is only on screen mid-sync, and this is about the stylesheet
  // rather than about the sync. The class is the whole feature — the production CSP has no
  // `'unsafe-inline'` for styles, so it can never animate from a `style` attribute.
  const animation = await device.evaluate(() => {
    const span = document.createElement('span');
    span.className = 'emw-spinner size-4';
    document.body.append(span);
    const name = getComputedStyle(span).animationName;
    span.remove();
    return name;
  });
  expect(animation).toBe('none');
});

test('the whole app is reachable in the dark theme without a console error', async ({ device }) => {
  const errors: string[] = [];
  device.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await device.getByRole('radio', { name: 'Ciemny' }).check();

  for (const route of ['/', '/recipes', '/ingredients', '/settings', '/about', '/setup']) {
    await device.goto(`#${route}`);
    await expect(device.locator('h1')).toHaveCount(1);
    await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');
  }

  expect(await cspViolations(device), 'a screen reported a CSP violation in the dark theme').toEqual(
    []
  );
  expect(errors, 'the page logged a console error in the dark theme').toEqual([]);
});

// ---- task 5: a recipe remembers where it came from ---------------------------------------

const PANCAKES = {
  name: 'Naleśniki',
  portions: 1,
  instructions: 'Wymieszaj i usmaż.',
  ingredients: [{ name: 'Jajko kurze', amount: 2, unit: 'szt', state: 'raw', gramsPerUnit: 55 }]
};

test('a recipe imported from a link keeps the page it came from, and can be cut loose', async ({
  device,
  gemini
}) => {
  gemini.script.page = 'Naleśniki\n2 jajka\nWymieszaj i usmaż.';
  gemini.script.recipe = PANCAKES;

  // The import needs a key, and the key needs a vault.
  await device.getByLabel('Szyfruj sejf hasłem głównym (zalecane)').uncheck();
  await device.getByRole('button', { name: 'Utwórz sejf' }).click();
  await device.getByLabel('Klucz API Gemini').fill('AIza-e2e-secret');
  await device.getByRole('button', { name: 'Sprawdź i zapisz klucz' }).click();
  await expect(device.getByText('Klucz działa.')).toBeVisible();

  await device.goto('#/recipes/new/edit');
  await device.getByRole('button', { name: 'Wklej przepis z internetu' }).click();
  await device
    .getByLabel('Link do przepisu albo jego treść')
    .fill('https://example.com/nalesniki?p=17&utm_source=fb');
  await device.getByRole('button', { name: 'Importuj' }).click();
  await expect(device.getByText('Przepis wczytany.')).toBeVisible();

  // The host, not the URL — and the tracking pair is gone while `?p=17` survives, because it
  // is very often the recipe's own identity.
  const source = device.getByRole('link', { name: 'example.com' });
  await expect(source).toHaveAttribute('href', 'https://example.com/nalesniki?p=17');
  await expect(source).toHaveAttribute('rel', 'noopener noreferrer');

  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  // It was stored, not merely shown: it is there again when the recipe is reopened.
  await device.getByRole('link', { name: /Naleśniki/ }).first().click();
  await expect(device.getByRole('link', { name: 'example.com' })).toBeVisible();

  // And a recipe edited beyond recognition can stop claiming a page.
  await device.getByRole('button', { name: 'Usuń źródło' }).click();
  await expect(device.getByRole('heading', { name: 'Źródło' })).toHaveCount(0);
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await device.getByRole('link', { name: /Naleśniki/ }).first().click();
  await expect(device.getByRole('heading', { name: 'Źródło' })).toHaveCount(0);
});

test('a hand-written recipe claims no source at all', async ({ device }) => {
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Kanapka bez źródła');
  await expect(device.getByRole('heading', { name: 'Źródło' })).toHaveCount(0);
});

// ---- task 6: the key field links to where a key is made ----------------------------------

test('both places that ask for the Gemini key link straight to the page that creates one', async ({
  device,
  openDevice
}) => {
  const expected = 'https://aistudio.google.com/apikey';

  // The settings key field lives inside an open vault, so there has to be one.
  await device.getByLabel('Szyfruj sejf hasłem głównym (zalecane)').uncheck();
  await device.getByRole('button', { name: 'Utwórz sejf' }).click();
  await expect(device.getByLabel('Klucz API Gemini')).toBeVisible();

  const inSettings = device.getByRole('link', { name: 'aistudio.google.com/apikey' });
  await expect(inSettings).toHaveAttribute('href', expected);
  await expect(inSettings).toHaveAttribute('target', '_blank');
  await expect(inSettings).toHaveAttribute('rel', 'noopener noreferrer');

  const wizard = await openDevice({ keepSetup: true });
  await wizard.getByRole('button', { name: 'Pomiń — tylko to urządzenie' }).click();
  await wizard.getByLabel('Szyfruj sejf hasłem (zalecane)').uncheck();
  await wizard.getByLabel('Rozumiem i chcę tak zrobić').check();
  await wizard.getByRole('button', { name: 'Dalej' }).click();

  await expect(wizard.getByRole('heading', { name: '4. Klucz API Gemini' })).toBeVisible();
  await expect(wizard.getByRole('link', { name: 'aistudio.google.com/apikey' })).toHaveAttribute(
    'href',
    expected
  );
});
