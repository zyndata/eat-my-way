import type { Page } from '@playwright/test';
import {
  cspViolations,
  forgetStoredToken,
  googleHints,
  googlePrompts,
  setGoogleSession
} from './fake-google';
import { expect, test } from './fixtures';
import { recipe, seedAccount } from './seed';

/**
 * The sign-in flow, from a browser that has never heard of Google to one holding a live
 * session — and back out again. The app runs its real `google-auth.ts` and its real Drive
 * client throughout; only the GIS script and the Drive REST API are answered by the test.
 */

const CONNECT = 'Połącz Dysk Google';

/** The „Stan" row of the settings screen. */
const status = (page: Page) =>
  page.locator('dt', { hasText: 'Stan' }).locator('xpath=following-sibling::dd[1]');

/**
 * The settings screen's own message. `exact` matters: the same sentence also appears in the
 * app-wide `SyncIndicator`, where it is followed by a „Spróbuj ponownie" button.
 */
const settingsMessage = (page: Page, text: string) => page.getByText(text, { exact: true });

test('a device that never connected reaches Google on no code path', async ({ device, drive }) => {
  // Give the load, the silent resume and the visibility handler every chance to fire.
  await device.waitForTimeout(1500);

  expect(drive.identityLoads, 'the GIS script was fetched before any click').toBe(0);
  expect(drive.requests, 'a Drive request was made before any click').toEqual([]);
  await expect(status(device)).toHaveText('Niepołączono');
});

test('connecting reports the account and pulls what is already on Drive', async ({ device, drive }) => {
  seedAccount(drive, { recipes: [recipe({ name: 'Naleśniki z Dysku' })] });

  await device.getByRole('button', { name: CONNECT }).click();

  await expect(status(device)).toContainText('Połączono');
  await expect(status(device)).toContainText('test@example.com');
  expect(await googlePrompts(device)).toEqual(['consent']);
  expect(drive.identityLoads).toBe(1);
  expect(await cspViolations(device)).toEqual([]);

  // The connect is only real if the data actually arrived.
  await device.getByRole('link', { name: 'Przepisy' }).click();
  await expect(device.getByText('Naleśniki z Dysku')).toBeVisible();
});

test('connecting asks only for the appdata scope', async ({ device, drive }) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  const clients = await device.evaluate(
    () => (window as unknown as { __emwGoogle: { clients: { scope: string }[] } }).__emwGoogle.clients
  );
  expect(clients).toHaveLength(1);
  expect(clients[0]?.scope).toBe('https://www.googleapis.com/auth/drive.appdata');
});

test('an empty Drive folder sends the user to the first-run wizard', async ({ device, drive }) => {
  expect(drive.names()).toEqual([]);

  await device.getByRole('button', { name: CONNECT }).click();

  await expect(device.getByRole('heading', { name: 'Pierwsze uruchomienie' })).toBeVisible();
  expect(device.url()).toContain('#/setup');
});

test('a folder that already holds data does not open the wizard', async ({ device, drive }) => {
  seedAccount(drive);

  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  expect(device.url()).toContain('#/settings');
});

test('a dismissed consent popup says so and changes nothing', async ({ device, drive }) => {
  seedAccount(drive);
  await setGoogleSession(device, { dismissPopup: true });

  await device.getByRole('button', { name: CONNECT }).click();

  await expect(settingsMessage(device, 'Nie udało się połączyć z Dyskiem Google.')).toBeVisible();
  await expect(status(device)).toHaveText('Niepołączono');
  await expect(device.getByRole('button', { name: CONNECT })).toBeVisible();
  expect(drive.snapshot()['recipes.json'], 'a failed sign-in wrote to Drive').toEqual({
    recipes: [recipe()],
    tags: []
  });
});

test('a reload keeps the session without going back to Google at all', async ({ device, drive }) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');
  const loadsBefore = drive.identityLoads;

  await device.reload();

  await expect(status(device)).toContainText('Połączono');
  // The token this tab already holds is enough. Asking Google again on a page load is exactly
  // what used to fail — GIS may want a window, and a load has no gesture to open one with.
  expect(await googlePrompts(device)).toEqual([]);
  expect(drive.identityLoads, 'the reload loaded GIS for nothing').toBe(loadsBefore);
});

test('a session lost with the tab comes back on the first tap', async ({ device, drive }) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  // A new tab, or an hour later: the grant stands, the token is gone.
  await forgetStoredToken(device);
  await device.reload();

  // The renewal on load cannot open a window, so this load starts disconnected — quietly.
  await expect(status(device)).toHaveText('Niepołączono');
  await expect(device.getByText('Nie udało się połączyć')).toHaveCount(0);

  // The first tap anywhere — here the heading, not a button — carries the activation GIS was
  // missing, and the renewal rides on it. Still no consent screen: `''`, never `'consent'`.
  await device.getByRole('heading', { name: 'Dysk Google' }).click();

  await expect(status(device)).toContainText('Połączono');
  expect(await googlePrompts(device)).toEqual(['', '']);
  // The renewal names the account, so a browser with several signed in renews the right one.
  expect(await googleHints(device)).toEqual(['test@example.com', 'test@example.com']);
});

test('a lapsed Google session on reload is quiet, not an error', async ({ device, drive }) => {
  seedAccount(drive);
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  // Signed out of Google in this browser, and this tab's token gone with it: the silent
  // renewal has nothing to work with.
  await setGoogleSession(device, { signedIn: false, consented: false });
  await forgetStoredToken(device);
  await device.reload();

  await expect(status(device)).toHaveText('Niepołączono');
  // Not being signed in right now is ordinary. It must not shout.
  await expect(device.getByText('Synchronizacja się nie powiodła')).toHaveCount(0);
  await expect(device.getByText('Nie udało się połączyć')).toHaveCount(0);
  // And the data on Drive is untouched by a load that could not sign in.
  expect(drive.names()).toContain('recipes.json');
});

test('a grant revoked at Google is reported without touching local data', async ({ device, drive }) => {
  seedAccount(drive, { recipes: [recipe({ name: 'Naleśniki z Dysku' })] });
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');

  drive.revokeToken('e2e-token-1');
  await device.getByRole('button', { name: 'Synchronizuj teraz' }).click();

  await expect(settingsMessage(device, 'Nie udało się połączyć z Dyskiem Google.')).toBeVisible();
  await expect(status(device)).toHaveText('Niepołączono');

  // The whole promise of the failure paths: the calendar and the library are still there.
  await device.getByRole('link', { name: 'Przepisy' }).click();
  await expect(device.getByText('Naleśniki z Dysku')).toBeVisible();
});

test('disconnecting revokes the grant and keeps every local row', async ({ device, drive }) => {
  seedAccount(drive, { recipes: [recipe({ name: 'Naleśniki z Dysku' })] });
  await device.getByRole('button', { name: CONNECT }).click();
  await expect(status(device)).toContainText('Połączono');
  const before = drive.names();

  await device.getByRole('button', { name: 'Rozłącz konto' }).click();

  await expect(status(device)).toHaveText('Niepołączono');
  const revoked = await device.evaluate(
    () => (window as unknown as { __emwGoogle: { revoked: string[] } }).__emwGoogle.revoked
  );
  expect(revoked).toEqual(['e2e-token-1']);
  // Disconnecting is not deleting: nothing leaves Drive, and nothing leaves this device.
  expect(drive.names()).toEqual(before);
  await device.getByRole('link', { name: 'Przepisy' }).click();
  await expect(device.getByText('Naleśniki z Dysku')).toBeVisible();
});
