import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Hover, press and focus — the states the app did not have (Phase 20 UI audit).
 *
 * The app had 157 clickable elements and one `hover:` rule between them, so nothing moved under
 * the cursor; and because `body` sets `-webkit-tap-highlight-color: transparent`, the native
 * flash was gone on touch as well. A press painted *nothing* on either input, which is how the
 * goals calculator's „Wypełnij pola" came to be reported as a broken button while it was in
 * fact working correctly.
 *
 * Covered the way `comfort.spec.ts` covers the theme and the spinner — by reading computed
 * styles off real elements — with two habits this file cannot do without:
 *
 *  - **Settle before reading.** The states transition over 120 ms, so a read taken straight
 *    after `hover()` catches an interpolated colour part-way between two states. Every read
 *    goes through `settled`, which waits for the value to stop moving.
 *  - **`hover()` before `mouse.down()`.** The button sits below the fold; Playwright's `hover()`
 *    scrolls it into view first, which raw viewport coordinates from `boundingBox()` do not.
 */

/** The primary „Zapisz cele" button — enabled on the default goals, and on screen at /settings. */
const saveGoals = (page: Page) => page.getByRole('button', { name: 'Zapisz cele' });

/**
 * Read a computed property once it has stopped changing. Five identical animation frames is the
 * bar: a single repeat can happen mid-transition when two frames round to the same string.
 */
function settled(locator: Locator, property: 'backgroundColor' | 'transform'): Promise<string> {
  return locator.evaluate(async (element, name) => {
    const read = () => getComputedStyle(element)[name as 'backgroundColor' | 'transform'];
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    let previous = read();
    let stable = 0;
    for (let i = 0; i < 120 && stable < 5; i += 1) {
      await frame();
      const current = read();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
    return previous;
  }, property);
}

/**
 * Hold the pointer down on a button and read it mid-press. `:active` exists only while the
 * button is genuinely held, so the read has to happen between `down` and `up` — a `click()` has
 * let go again before anything can be measured.
 */
async function whilePressed<T>(page: Page, button: Locator, read: () => Promise<T>): Promise<T> {
  await button.hover();
  await page.mouse.down();
  try {
    return await read();
  } finally {
    await page.mouse.up();
  }
}

test('a primary button answers the cursor and the press with two different colours', async ({
  device
}) => {
  const button = saveGoals(device);
  const resting = await settled(button, 'backgroundColor');

  await button.hover();
  const hovered = await settled(button, 'backgroundColor');
  expect(hovered, 'hover did not repaint the button').not.toBe(resting);

  const pressed = await whilePressed(device, button, () => settled(button, 'backgroundColor'));
  expect(pressed, 'the press did not repaint the button').not.toBe(resting);
  // The press is not merely „hover, held" — it is the state a touch user sees instead of hover.
  expect(pressed, 'press and hover are the same colour').not.toBe(hovered);
});

test('a press also pushes the button in, and lets go of it afterwards', async ({ device }) => {
  const button = saveGoals(device);
  expect(await settled(button, 'transform')).toBe('none');

  const pressed = await whilePressed(device, button, () => settled(button, 'transform'));
  // The 2% scale, as a matrix. „Not none" is the assertion; the exact number is the CSS's.
  expect(pressed, 'the press applied no transform').toContain('matrix');
  expect(pressed).not.toBe('none');

  await device.mouse.move(0, 0);
  expect(await settled(button, 'transform'), 'the button stayed pushed in').toBe('none');
});

test('the press keeps its colour but drops the motion under prefers-reduced-motion', async ({
  openDevice
}) => {
  const device = await openDevice();
  await device.emulateMedia({ reducedMotion: 'reduce' });
  const button = saveGoals(device);

  const resting = await settled(button, 'backgroundColor');
  const pressed = await whilePressed(device, button, async () => ({
    colour: await settled(button, 'backgroundColor'),
    shape: await settled(button, 'transform')
  }));

  // The colour carries the whole feedback once the scale is gone, so it still has to move.
  expect(pressed.colour, 'reduced motion also removed the press colour').not.toBe(resting);
  expect(pressed.shape, 'reduced motion kept the press scale').toBe('none');
});

test('a disabled button refuses to light up, and says so with the cursor', async ({ device }) => {
  // An empty calories field is what disables „Zapisz cele" — the form's own existing guard.
  await device.getByLabel(/Kalorie/).fill('');
  const button = saveGoals(device);
  await expect(button).toBeDisabled();

  const resting = await settled(button, 'backgroundColor');

  await button.hover({ force: true });
  expect(await settled(button, 'backgroundColor'), 'a disabled button lit up on hover').toBe(
    resting
  );

  const pressed = await whilePressed(device, button, () => settled(button, 'transform'));
  expect(pressed, 'a disabled button shrank under the press').toBe('none');

  expect(await button.evaluate((element) => getComputedStyle(element).cursor)).toBe('not-allowed');
});

test('hover is gated behind a real pointer, so a tap does not leave a button stuck', async ({
  openDevice,
  browserName
}) => {
  // The phone context is `devices['Pixel 5']`, which sets `isMobile` — and Playwright only
  // supports that on Chromium, the same limit that keeps `swipe.spec.ts` to one engine. The
  // gating itself is plain `@media (hover: hover)` and is not engine-specific.
  test.skip(browserName !== 'chromium', 'the phone context needs isMobile, which only Chromium has');

  // A phone: touch-capable, and therefore `hover: none`. An ungated `:hover` latches after a tap
  // on these and stays painted until something else is tapped — which is the entire reason the
  // hover rules sit inside `@media (hover: hover)`.
  const device = await openDevice({ touch: true });
  const button = saveGoals(device);

  expect(
    await device.evaluate(() => matchMedia('(hover: hover)').matches),
    'the touch context still claims a hover-capable pointer'
  ).toBe(false);

  const resting = await settled(button, 'backgroundColor');
  await button.tap();
  expect(await settled(button, 'backgroundColor'), 'the tap left a hover painted on').toBe(resting);
});

test('a keyboard focus is visible', async ({ device }) => {
  const button = saveGoals(device);
  await button.focus();

  // Programmatic focus counts as `:focus-visible` on a button, the same as arriving by Tab.
  const outline = await button.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(outline, 'a focused button has no ring').not.toBe('0px');
});

test('the press states follow the dark theme rather than staying light', async ({ device }) => {
  const button = saveGoals(device);
  const light = await whilePressed(device, button, () => settled(button, 'backgroundColor'));

  await device.getByRole('radio', { name: 'Ciemny' }).check();
  await expect(device.locator('html')).toHaveAttribute('data-theme', 'dark');

  const dark = await whilePressed(device, button, () => settled(button, 'backgroundColor'));
  // Each theme defines its own `--color-accent-active`; a token declared only once for the light
  // theme would make these two identical.
  expect(dark, 'the pressed colour did not follow the theme').not.toBe(light);
});

test('the pill variants are actually round', async ({ device }) => {
  // `.emw-btn-chip` first shipped with `border-radius: var(--radius-full)` — a variable Tailwind
  // v4 does not define, since it compiles `rounded-full` to `calc(infinity * 1px)` rather than
  // to a token. An undefined variable makes the declaration invalid and is reported nowhere, so
  // the floating „Dodaj posiłek" button quietly came out square. Only a screenshot caught it.
  await device.goto('#/');

  const fab = device.getByRole('button', { name: 'Dodaj posiłek' });
  await fab.waitFor({ state: 'visible' });

  const { radius, height } = await fab.evaluate((element) => ({
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
    height: element.getBoundingClientRect().height
  }));

  // A pill's radius is at least half its height; the square version measured 0.
  expect(radius).toBeGreaterThanOrEqual(height / 2);
});
