import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The swipe-left on a meal card, driven as a real gesture (STATE.md open question 12).
 *
 * It was left uncovered because the earlier CDP runs could not synthesize a horizontal drag
 * that the browser treats as touch rather than as a click. Playwright can: a context that
 * claims touch, plus `Input.dispatchTouchEvent` over a CDP session, produces `TouchEvent`s
 * from Chromium's own input pipeline rather than from `dispatchEvent` in page script — which
 * is the difference between testing the browser's behaviour and testing our own handler
 * against a fabricated object.
 *
 * `MealCard` reads only `touchstart` and `touchend`, so the move in between exists purely to
 * give the release a different position from the press.
 *
 * One half of the card's behaviour is still **not** covered here, and deliberately not
 * pretended otherwise: that a finished swipe does not also follow the link it crossed. Chromium
 * synthesizes a click from a *tap*, not from a CDP touch drag, so no click is generated for
 * `suppressClick` to swallow. Checked by mutation — deleting the `event.preventDefault()` in
 * `MealCard` leaves this suite green — which is why there is no assertion about it: one that
 * cannot fail reads like coverage and is worse than none. See STATE.md open question 12.
 */

/** One recipe, planned onto today, on a phone-sized touch device. */
async function seedPlannedMeal(page: Page): Promise<void> {
  await page.goto('#/recipes/new/edit');
  await page.getByLabel('Nazwa').fill('Owsianka z jajkiem');
  await page.getByRole('button', { name: 'Dodaj składnik' }).click();
  await page.getByLabel('Składnik 1').fill('jajko');
  await page.getByRole('option').first().click();
  await page.getByLabel('Ilość').first().fill('120');
  await page.getByRole('button', { name: 'Zapisz przepis' }).click();
  await expect(page.getByRole('heading', { name: 'Przepisy' })).toBeVisible();

  await page.goto('#/');
  await page.getByRole('button', { name: 'Dodaj posiłek' }).first().click();
  await page.getByRole('button', { name: /Owsianka/ }).click();
  await expect(page.getByRole('link', { name: /Owsianka/ }).first()).toBeVisible();
}

/**
 * The hidden action row behind a card. It is always painted — the card slides over it — so
 * „is it visible" answers nothing; what tells the two states apart is `inert`, which is also
 * the mechanism the component relies on to keep the buttons out of the focus order.
 */
function actionRow(page: Page) {
  return page.getByRole('button', { name: 'Kopiuj do…', exact: true }).locator('..');
}

/** A horizontal touch drag across the card, `dx` pixels wide. Negative goes left. */
async function swipe(page: Page, dx: number, dy = 0): Promise<void> {
  const card = page.getByRole('link', { name: /Owsianka/ }).first();
  const box = await card.boundingBox();
  if (box === null) throw new Error('the meal card has no box to swipe across');

  const x = box.x + box.width - 8;
  const y = box.y + box.height / 2;

  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }]
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: x + dx, y: y + dy }]
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

test('a swipe left reveals the card actions', async ({ openDevice }) => {
  const page = await openDevice({ touch: true, route: '/' });
  await seedPlannedMeal(page);

  await expect(actionRow(page)).toHaveAttribute('inert', '');

  await swipe(page, -120);

  // Revealed, and genuinely reachable — `inert` is gone and the action can be clicked.
  await expect(actionRow(page)).not.toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Usuń', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Usunąć posiłek?');
});

test('a short or vertical drag is not a swipe', async ({ openDevice }) => {
  const page = await openDevice({ touch: true, route: '/' });
  await seedPlannedMeal(page);

  // Under the 50 px threshold: a hesitant finger is not a gesture.
  await swipe(page, -30);
  await expect(actionRow(page)).toHaveAttribute('inert', '');

  // Far enough sideways, but also far enough down to be a scroll.
  await swipe(page, -120, 60);
  await expect(actionRow(page)).toHaveAttribute('inert', '');

  // Rightwards opens nothing either — the actions live on the right edge.
  await swipe(page, 120);
  await expect(actionRow(page)).toHaveAttribute('inert', '');
});
