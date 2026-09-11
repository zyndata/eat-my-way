import type { Locator, Page } from '@playwright/test';
import { expect, test, type DeviceOptions } from './fixtures';

/**
 * The geometry of a phone that reserves part of its screen (PLAN.md Phase 15).
 *
 * An installed iPhone keeps a strip at the bottom for the home indicator and, in landscape, a
 * strip at the side for the notch. Chromium cannot be told to report one, and nothing in this
 * repository had ever rendered a viewport that has one — which is why a primary action was
 * half-hidden behind the navigation bar for fourteen phases without a single test noticing
 * (STATE.md decisions 319 and 320).
 *
 * So the insets reach the stylesheet through custom properties, and this spec moves them. It
 * is emulation, not a device: it proves the arithmetic and the plumbing, and it is what keeps
 * the fix from rotting. What only a device can answer is listed in STATE.md open question 30.
 */

/** An iPhone with a home indicator, portrait and landscape, in CSS pixels. */
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const HOME_INDICATOR = 34;
const NOTCH = 47;

/** BottomNav's content box, and the gap every element above it keeps. Both from `app.css`. */
const BAR = 61;
const GAP = 19;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Move the safe-area insets.
 *
 * Written through the CSSOM rather than with `addStyleTag` or an inline `style`, because both
 * of those are blocked by the production policy (`style-src 'self'`, STATE.md decision 44) and
 * this spec has to mean the same thing under `npm run test:e2e:csp`. A rule inserted into a
 * stylesheet the page already loaded is not an inline style and CSP does not govern it.
 *
 * The rule is unlayered, so it beats `app.css`'s `@layer base` definition whatever the
 * selectors say. It does not survive a navigation — set the insets after the last `goto`.
 */
async function setSafeArea(
  page: Page,
  insets: { bottom?: number; left?: number; right?: number }
): Promise<void> {
  await page.evaluate(
    (values) => {
      const sheets = document.styleSheets;
      const sheet = sheets[sheets.length - 1];
      if (sheet === undefined) throw new Error('the page loaded no stylesheet');
      sheet.insertRule(
        `:root{--safe-bottom:${values.bottom}px;--safe-left:${values.left}px;--safe-right:${values.right}px}`,
        sheet.cssRules.length
      );
    },
    { bottom: insets.bottom ?? 0, left: insets.left ?? 0, right: insets.right ?? 0 }
  );
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box: it is not rendered`).not.toBeNull();
  return box as Box;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/**
 * `--nav-h` as the browser resolved it.
 *
 * Read off the bar's own `min-height` rather than off `:root`: a custom property's computed
 * value is the text that was written, `calc(3.8125rem + 34px)`, and the number this phase is
 * about is what that becomes. Reading it from the bar also means the assertion is about the
 * bar, which is the point of giving it the token as a minimum height in the first place.
 */
async function navHeight(page: Page): Promise<string> {
  return await page
    .getByRole('navigation', { name: 'Nawigacja główna' })
    .first()
    .evaluate((element) => getComputedStyle(element).minHeight);
}

/** Everything the bar and the things above it are measured against, in one read. */
async function geometry(page: Page): Promise<{
  nav: Box;
  fab: Box;
  viewport: { width: number; height: number };
  navToken: string;
}> {
  const viewport = page.viewportSize();
  expect(viewport, 'the test set no viewport').not.toBeNull();
  return {
    nav: await boxOf(page.getByRole('navigation', { name: 'Nawigacja główna' }), 'the bar'),
    fab: await boxOf(page.getByRole('button', { name: 'Dodaj posiłek' }), 'the add button'),
    viewport: viewport as { width: number; height: number },
    navToken: await navHeight(page)
  };
}

/** A phone-sized browser on the calendar, where the „Dodaj posiłek" button lives. */
async function openPhone(
  openDevice: (options?: DeviceOptions) => Promise<Page>,
  size: { width: number; height: number } = PORTRAIT
): Promise<Page> {
  const page = await openDevice({ route: '/', touch: true });
  await page.setViewportSize(size);
  await expect(page.getByRole('button', { name: 'Dodaj posiłek' })).toBeVisible();
  return page;
}

// ---- the baseline: Android and the desktop must not move ---------------------------------

test('with no inset every position is the one it was before the fix', async ({ openDevice }) => {
  const page = await openPhone(openDevice);
  await setSafeArea(page, { bottom: 0 });

  const { nav, fab, viewport, navToken } = await geometry(page);

  // The bar is what the token says it is — the whole fix rests on these two being one number.
  expect(navToken).toBe(`${BAR}px`);
  expect(nav.height).toBe(BAR);
  expect(nav.y + nav.height).toBe(viewport.height);

  // `bottom-20` was 80px. It is now `--nav-h` + the gap, and at a zero inset that is 80 again.
  expect(viewport.height - (fab.y + fab.height)).toBe(BAR + GAP);

  // `pb-24` was 96px, and is now the bar plus the room a card keeps above it.
  const mainPadding = await page
    .locator('main')
    .evaluate((element) => getComputedStyle(element).paddingBottom);
  expect(mainPadding).toBe('96px');
});

// ---- the defect this phase exists for ----------------------------------------------------

test('an installed iPhone: the add-meal button is whole and clear of the bar', async ({
  openDevice
}) => {
  const page = await openPhone(openDevice);
  await setSafeArea(page, { bottom: HOME_INDICATOR });

  const { nav, fab, viewport, navToken } = await geometry(page);

  expect(navToken).toBe(`${BAR + HOME_INDICATOR}px`);
  expect(nav.height).toBe(BAR + HOME_INDICATOR);

  // The defect, stated as the assertion that would have caught it: the button's lowest 15px
  // used to be inside the bar's box.
  expect(overlaps(fab, nav), 'the add-meal button is behind the navigation bar').toBe(false);
  expect(fab.y + fab.height).toBeLessThanOrEqual(nav.y);
  expect(viewport.height - (fab.y + fab.height)).toBe(BAR + HOME_INDICATOR + GAP);

  // Whole, and still the thing it is: a tap on it has to open the picker.
  await expect(page.getByRole('button', { name: 'Dodaj posiłek' })).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Dodaj posiłek' }).click();
  await expect(page.getByRole('heading', { name: 'Dodaj posiłek' })).toBeVisible();
});

test('an installed iPhone: the new-version bar clears the navigation bar too', async ({
  openDevice
}) => {
  const page = await openDevice({ touch: true });
  await page.setViewportSize(PORTRAIT);

  /*
   * A registration holding a waiting worker is the one thing `checkForUpdate` asks about, and
   * it is the only part of the update path a browser cannot be talked into on demand — a real
   * one needs a second build sitting on the server. The property is only ever compared with
   * null, so a bare object is a faithful stand-in.
   */
  await page.addInitScript(() => {
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'waiting', {
      configurable: true,
      get: () => ({}) as ServiceWorker
    });
  });
  /*
   * The check answers „you are current" until a worker is *controlling* this client, and with
   * `registerType: 'prompt'` nothing calls `clients.claim()` — so a client is controlled only
   * from the first navigation after the worker activated. Wait for the activation, then make
   * that navigation.
   */
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000
  });

  // The bar is app-wide, so the settings screen the fixture lands on is as good as any.
  await page.getByRole('button', { name: 'Sprawdź aktualizacje' }).click();
  await expect(page.getByText('Jest nowa wersja aplikacji')).toBeVisible();

  await setSafeArea(page, { bottom: HOME_INDICATOR });

  const nav = await boxOf(page.getByRole('navigation', { name: 'Nawigacja główna' }), 'the bar');
  const prompt = await boxOf(
    page.getByRole('status').filter({ hasText: 'Jest nowa wersja aplikacji' }),
    'the new-version bar'
  );

  expect(overlaps(prompt, nav), 'the new-version bar is behind the navigation bar').toBe(false);
  await expect(page.getByRole('button', { name: 'Odśwież' })).toBeInViewport({ ratio: 1 });
});

test('an installed iPhone: the last meal of a full day scrolls clear of the bar', async ({
  openDevice
}) => {
  const page = await openPhone(openDevice);

  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill('Owsianka');
  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  // Enough meals that the day is longer than the screen, which is the only case in which the
  // bottom padding decides anything.
  await page.goto('#/');
  for (let index = 0; index < 6; index += 1) {
    await page.getByRole('button', { name: 'Dodaj posiłek' }).click();
    // Scoped to the picker: once a meal is on the day, its card matches the name as well.
    await page.getByRole('dialog').getByRole('button', { name: /Owsianka/ }).click();
  }
  const meals = page.getByRole('link', { name: /Owsianka/ });
  await expect(meals).toHaveCount(6);

  await setSafeArea(page, { bottom: HOME_INDICATOR });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  const nav = await boxOf(page.getByRole('navigation', { name: 'Nawigacja główna' }), 'the bar');
  const last = await boxOf(meals.last(), 'the last meal of the day');
  expect(overlaps(last, nav), 'the last meal is behind the navigation bar').toBe(false);
  expect(last.y + last.height).toBeLessThanOrEqual(nav.y);
});

// ---- landscape, where the inset is at the side --------------------------------------------

test('a landscape iPhone: nothing sits under the notch, the dialog included', async ({
  openDevice
}) => {
  const page = await openDevice({ route: '/recipes', touch: true });
  await page.setViewportSize(LANDSCAPE);

  // A recipe to delete, which is the shortest way to a real modal.
  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill('Owsianka');
  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await setSafeArea(page, { bottom: 21, left: NOTCH, right: NOTCH });

  // Landscape on a phone is past the md breakpoint, so the sidebar is what is on screen and
  // there is no bar left to clear.
  expect(await navHeight(page)).toBe('0px');

  const sidebar = page.getByRole('navigation', { name: 'Nawigacja główna' }).last();
  const link = await boxOf(sidebar.getByRole('link', { name: 'Przepisy' }), 'a sidebar link');
  expect(link.x, 'a sidebar link starts under the notch').toBeGreaterThanOrEqual(NOTCH);

  const heading = await boxOf(page.getByRole('heading', { name: 'Przepisy' }), 'the heading');
  expect(heading.x).toBeGreaterThanOrEqual(NOTCH);
  expect(heading.x + heading.width).toBeLessThanOrEqual(LANDSCAPE.width - NOTCH);

  // The dialogs sized themselves against 100vw, which with `viewport-fit=cover` spans the
  // insets, so in landscape one of them ran under the notch.
  await page.getByRole('link', { name: 'Owsianka' }).click();
  await page.getByRole('button', { name: 'Usuń przepis' }).click();
  const dialog = await boxOf(page.getByRole('dialog'), 'the confirmation dialog');
  expect(dialog.x).toBeGreaterThanOrEqual(NOTCH);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(LANDSCAPE.width - NOTCH);
});
