import { expect, test } from './fixtures';
import { cspViolations } from './fake-google';

/**
 * „Zero console CSP violations across all screens" — PLAN.md's Phase 8 acceptance criterion,
 * as a walk rather than as a claim.
 *
 * Every route in `routes.ts` is visited in one session, with a recipe and a planned meal in
 * place so the screens that need data have some. Meaningful against the Caddy container
 * (`npm run docker:up`, then `npm run test:e2e:csp`) — that run serves the real policy; the
 * `vite preview` run serves none and this spec then only proves the screens render.
 *
 * Google's own violation inside the GIS iframe (STATE.md decision 88) is not reachable here:
 * nothing on this walk connects Drive.
 */

/** Every route the app has, in the order a user would meet them. */
const ROUTES = ['/', '/recipes', '/ingredients', '/settings', '/about', '/setup', '/nie-ma-takiej-strony'];

test('every screen renders under the production policy and reports no violation', async ({
  device
}) => {
  const errors: string[] = [];
  device.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // A recipe and a planned meal, so the day view and the meal view are not empty screens.
  await device.goto('#/recipes/new/edit');
  await device.getByLabel('Nazwa').fill('Owsianka');
  await device.getByRole('button', { name: 'Dodaj składnik' }).click();
  await device.getByLabel('Składnik 1').fill('jajko');
  await device.getByRole('option').first().click();
  await device.getByLabel('Ilość').first().fill('100');
  await device.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(device.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await device.goto('#/');
  await device.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await device.getByRole('button', { name: /Owsianka/ }).click();

  // The meal view, reached the way a user reaches it.
  await device.getByRole('link', { name: /Owsianka/ }).first().click();
  await expect(device.getByRole('heading', { name: 'Owsianka' })).toBeVisible();

  for (const route of ROUTES) {
    await device.goto(`#${route}`);
    // Something rendered: every screen in this app has exactly one <h1>.
    await expect(device.locator('h1')).toHaveCount(1);
  }

  expect(await cspViolations(device), 'the page reported a CSP violation').toEqual([]);
  expect(errors, 'the page logged a console error').toEqual([]);
});
