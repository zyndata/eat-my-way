import { test as base, devices, expect, type BrowserContext, type Page } from '@playwright/test';
import { FakeDrive, installFakeGoogle, type GoogleSession } from './fake-google';
import { createFakeGemini, installFakeGemini, type FakeGemini } from './fake-gemini';

/**
 * One `FakeDrive` per test, and as many browser contexts over it as the test wants. Two
 * contexts sharing one drive are two devices signed in to the same Google account, each with
 * its own IndexedDB — which is PLAN.md's two-browser acceptance criterion, run for real.
 */

export interface DeviceOptions {
  session?: Partial<GoogleSession>;
  /** Where to land. Hash routes, so this is a fragment. */
  route?: string;
  /**
   * Open a phone rather than a desktop browser: a touch-capable context with a phone viewport.
   * Needed by anything that drives a real gesture — Chromium only delivers `TouchEvent`s to a
   * context that claims touch.
   */
  touch?: boolean;
  /**
   * Leave the first-run wizard where it is. Every device this fixture opens is a browser that
   * has genuinely never been used, which is exactly what Phase 11 made the wizard open on — so
   * by default it is skipped here, the way a returning user's browser has already skipped it.
   * The specs that are *about* the wizard set this and drive it themselves.
   */
  keepSetup?: boolean;
  /**
   * Do not wait for the first-run nutrition import. The default is to wait: a fresh browser
   * spends about six seconds on Chromium and about twenty-four on WebKit writing the 1 344
   * bundled ingredients, and a test that acts inside that window is racing the app rather than
   * testing it (STATE.md open question 31). `e2e/import-race.spec.ts` sets this, because
   * racing the import on purpose is the only way to cover the gate that phase 21 built.
   */
  raceNutritionImport?: boolean;
  /**
   * Let the app register its service worker. **Off by default, which is a phase 21 change.**
   *
   * A registered worker sits between the page and the network, and Playwright only intercepts
   * what a worker does on Chromium — on WebKit the app's Drive calls went straight past
   * `installFakeGoogle` to the real `googleapis.com`, which answered a fake bearer token with a
   * real 401. The app then did exactly what it should with a rejected token and dropped the
   * session, so `connect.spec.ts` watched a reload sign itself out. Blocking the worker makes
   * every context hermetic on both engines; the two specs that are *about* the worker turn it
   * back on (STATE.md decision 392).
   */
  serviceWorker?: boolean;
}

/**
 * How long the bundled import may take before the fixture gives up. Generous on purpose: the
 * measured worst case is WebKit at about 24 s, and a slow CI machine has every right to be
 * slower than the machine this was measured on.
 */
const NUTRITION_TIMEOUT = 90_000;

/**
 * Wait until `<html data-nutrition>` says the import has settled. The attribute is written by
 * `src/lib/nutrition/status.svelte.ts`; reading IndexedDB directly instead would be worse,
 * because on WebKit that read is itself blocked by the import it is trying to observe.
 */
export async function nutritionReady(page: Page): Promise<void> {
  await page
    .locator('html[data-nutrition="ready"]')
    .waitFor({ state: 'attached', timeout: NUTRITION_TIMEOUT });
}

/**
 * Open the recipe editor and wait until it is the screen on display.
 *
 * A bare `page.goto('#/recipes/new/edit')` returns as soon as the fragment changes, not when
 * the router has swapped the screen — and `getByLabel('Nazwa')` then resolves against the four
 * `slot-name-*` inputs the settings screen is still showing, which is a strict-mode violation
 * rather than a wait. Chromium swaps screens fast enough to hide it; WebKit does not, and that
 * one race accounted for a third of the failures phase 21 inherited (STATE.md open question
 * 31). Waiting for the heading is what a user does without thinking about it.
 */
export async function openRecipeEditor(page: Page): Promise<void> {
  await page.goto('#/recipes/new/edit');
  await page.getByRole('heading', { name: 'Nowy przepis' }).waitFor({ state: 'visible' });
}

/**
 * WebKit's notice for a cross-origin load its network layer refused, which it reports on the
 * window as though the page had thrown.
 *
 * It is not an app exception and not a policy violation: `listGeminiModels` already treats a
 * failed fetch as „no models" and catches it. What produces it is a gap in Playwright's own
 * interception — the settings screen's model listing carries `x-goog-api-key`, so the browser
 * sends a CORS preflight first, and on WebKit that preflight is not handed to
 * `installFakeGemini` at all but goes to the real endpoint, which refuses it. Chromium routes
 * the same request into the fake. CSP violations are a different message and are asserted
 * separately, through the page's own `__emwCsp` collector (STATE.md decision 396).
 */
function isBlockedCrossOriginLoad(message: string): boolean {
  return message.endsWith('due to access control checks.');
}

interface Fixtures {
  drive: FakeDrive;
  /** Gemini, answered at the network boundary. A test writes `gemini.script` before acting. */
  gemini: FakeGemini;
  pageErrors: string[];
  openDevice: (options?: DeviceOptions) => Promise<Page>;
  /** One device, already on the settings screen — the common case. */
  device: Page;
  /** Automatic: an uncaught exception anywhere in the app fails the test that caused it. */
  failOnPageError: void;
}

export const test = base.extend<Fixtures>({
  drive: async ({}, use) => {
    await use(new FakeDrive());
  },

  gemini: async ({}, use) => {
    await use(createFakeGemini());
  },

  pageErrors: async ({}, use) => {
    await use([]);
  },

  openDevice: async ({ browser, drive, gemini, baseURL, pageErrors }, use) => {
    const contexts: BrowserContext[] = [];

    await use(async (options: DeviceOptions = {}) => {
      const context = await browser.newContext({
        ...(options.touch === true ? devices['Pixel 5'] : {}),
        serviceWorkers: options.serviceWorker === true ? 'allow' : 'block'
      });
      contexts.push(context);
      await installFakeGoogle(context, drive, options);
      await installFakeGemini(context, gemini);

      const page = await context.newPage();
      // The sync paths are full of `void promise` calls whose rejections surface nowhere
      // else; an uncaught one is a failure even when every assertion passes.
      page.on('pageerror', (error) => {
        if (isBlockedCrossOriginLoad(error.message)) return;
        pageErrors.push(error.message);
      });

      const route = options.route ?? '/settings';
      await page.goto(`${baseURL ?? ''}/#${route}`);

      // Everything below this line, and everything the test does afterwards, happens on a
      // database nobody else is writing to.
      if (options.raceNutritionImport !== true) await nutritionReady(page);

      // A fresh browser meets the first-run wizard (Phase 11 task 2). Skipping it writes the
      // `setupDone` meta key, so it stays skipped for the rest of the test.
      if (options.keepSetup !== true) {
        const skip = page.getByRole('button', { name: 'Pomiń kreator' });
        await skip.waitFor({ state: 'visible' });
        await skip.click();
        // Let the wizard land before going anywhere else. From phase 21 it writes `setupDone`
        // and *then* navigates, so a `goto` fired straight after the click would be overtaken
        // by the app's own push a moment later.
        await page.waitForURL(/#\/$/);
        await page.goto(`${baseURL ?? ''}/#${route}`);
        // The reload re-runs the import, which this time reads the meta flag and skips — but
        // it still warms the ingredient index off the table, and that is a read worth letting
        // finish before a test starts writing.
        if (options.raceNutritionImport !== true) await nutritionReady(page);
      }

      // The settings screen is the default landing spot; anywhere else, the caller asserts —
      // as does a device that kept the wizard, which is about to be redirected off it.
      if (options.route === undefined && options.keepSetup !== true) {
        await expect(page.getByRole('heading', { name: 'Dysk Google' })).toBeVisible();
      }
      return page;
    });

    for (const context of contexts) await context.close();
  },

  device: async ({ openDevice }, use) => {
    await use(await openDevice());
  },

  failOnPageError: [
    async ({ pageErrors }, use) => {
      await use();
      expect(pageErrors, 'the app threw while the test ran').toEqual([]);
    },
    { auto: true }
  ]
});

export { expect } from '@playwright/test';
