import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The Phase 8 acceptance criterion nobody can check by reading code: with the network gone,
 * the calendar, the library and editing still work.
 *
 * The run is a real second load with the browser context switched offline, so what answers is
 * the service worker's precache and nothing else — the first load is the only one allowed to
 * touch the server.
 *
 * What this deliberately does *not* cover is the offline message on the two online-only
 * actions. `context.setOffline` does not reach Playwright's own route handlers, so the fake
 * Google and the fake Gemini keep answering happily while the browser calls itself offline;
 * the messages are asserted where they are decided instead — `state.svelte.test.ts` for sync,
 * `client.ts` / `key-test.ts` for Gemini.
 */

/** Registered and *controlling* — a worker that has not taken over answers nothing. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active == null) return false;
      // `controller` is null on the very first load until the worker claims the client.
      return navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 30_000 }
  );
}

test('the calendar, the library and the editor all work with the network gone', async ({
  device,
  context
}) => {
  await waitForServiceWorker(device);

  // The bundled ingredients are fetched once, on the first run. Visiting the editor before
  // going offline is what proves the offline load is not the one that needs them.
  await device.goto('#/recipes/new/edit');
  await expect(device.getByLabel('Nazwa')).toBeVisible();

  await context.setOffline(true);
  await device.goto('#/');
  await device.reload();

  // What the reload was served from. Chromium's offline emulation covers the page but not the
  // service worker's own fetches, so „it loaded" is not by itself proof of a cache hit — the
  // precache holding the document and the USDA bundle is (STATE.md open question 5).
  const cached = await device.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached).toContain('/index.html');
  expect(cached.some((url) => /^\/assets\/ingredients-.*\.json$/.test(url))).toBe(true);

  // The shell came out of the cache and the day screen is live.
  await expect(device.getByRole('button', { name: 'Dodaj posiłek' }).first()).toBeVisible();

  // The library, and the editor behind it, are just as usable — including the ingredient
  // autocomplete, which reads the precached USDA subset out of IndexedDB.
  await device.goto('#/recipes');
  await expect(device.getByRole('link', { name: 'Nowy przepis' }).first()).toBeVisible();

  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Kanapka offline');
  await expect(device.getByLabel('Nazwa')).toHaveValue('Kanapka offline');

  await context.setOffline(false);
});

test('the app meets the installability requirements', async ({ device }) => {
  await waitForServiceWorker(device);

  // Chromium installs a page that has a manifest with a name, a start_url in scope, a
  // standalone display mode and an icon of at least 192 px — plus a service worker with a
  // fetch handler, which the assertion above already established.
  const href = await device.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).not.toBeNull();

  const manifest = await device.evaluate(async (url: string) => {
    const response = await fetch(url);
    return { type: response.headers.get('content-type') ?? '', body: await response.json() };
  }, href as string);

  // Caddy has to know the extension; a manifest served as octet-stream is not read at all.
  expect(manifest.type).toContain('manifest+json');
  expect(manifest.body.name).toBe('Eat My Way — planer posiłków');
  expect(manifest.body.short_name).toBe('Eat My Way');
  expect(manifest.body.lang).toBe('pl');
  expect(manifest.body.display).toBe('standalone');
  expect(manifest.body.start_url).toBe('/');

  const sizes = (manifest.body.icons as { sizes: string; purpose: string }[]).map(
    (icon) => `${icon.sizes} ${icon.purpose}`
  );
  expect(sizes).toContain('192x192 any');
  expect(sizes).toContain('512x512 any');
  // Without a maskable icon Android crops the square one into its own shape.
  expect(sizes).toContain('512x512 maskable');

  // Every icon the manifest promises has to actually be served.
  for (const icon of manifest.body.icons as { src: string }[]) {
    const status = await device.evaluate(
      async (src: string) => (await fetch(src)).status,
      icon.src
    );
    expect(status, `${icon.src} is missing`).toBe(200);
  }
});

/**
 * The build a device is running is invisible to its user, and with `registerType: 'prompt'` an
 * installed app can serve an old one for as long as nobody reloads it. Settings answers both
 * halves: which version this is, and whether anything newer is waiting.
 *
 * Only the „you are current" answer is asserted here, because it is the one true in both runs —
 * the `vite preview` run and the container run serve the same build the browser already has.
 * The other answer needs a *different* worker on the server, which no run can arrange without
 * writing to what it serves; it was verified against a mutated `dist/sw.js` (STATE.md
 * decision 225).
 */
test('settings names the version and can say that it is the newest', async ({ device }) => {
  await waitForServiceWorker(device);

  const section = device.locator('section', {
    has: device.getByRole('heading', { name: 'Wersja i aktualizacje' })
  });
  await expect(section.getByText(/^Masz wersję \d+\.\d+\.\d+/)).toBeVisible();

  await section.getByRole('button', { name: 'Sprawdź aktualizacje' }).click();
  await expect(section.getByText('Masz najnowszą wersję.')).toBeVisible();
});
