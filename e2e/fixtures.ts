import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
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
      const context = await browser.newContext();
      contexts.push(context);
      await installFakeGoogle(context, drive, options);
      await installFakeGemini(context, gemini);

      const page = await context.newPage();
      // The sync paths are full of `void promise` calls whose rejections surface nowhere
      // else; an uncaught one is a failure even when every assertion passes.
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto(`${baseURL ?? ''}/#${options.route ?? '/settings'}`);
      await expect(page.getByRole('heading', { name: 'Dysk Google' })).toBeVisible();
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
