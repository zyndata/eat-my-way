import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end runs of the login and sync flows.
 *
 * By default the suite builds the app and serves it with `vite preview`, which is enough for
 * everything except the production headers. Point `E2E_BASE_URL` at the Caddy container
 * (`npm run docker:up`, then `E2E_BASE_URL=http://localhost:8080 npm run test:e2e`) to run the
 * same specs under the real CSP — the specs assert that the page reported no violations, so
 * that run is the one that proves the policy still admits Google Identity Services.
 */

/**
 * Declared rather than pulled in with `@types/node`: this is the only file in the repo that
 * reads an environment variable, and the app's own type environment stays free of Node
 * globals that have no business being reachable from `src/`.
 */
declare const process: { env: Record<string, string | undefined> };

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const usesOwnServer = process.env.E2E_BASE_URL === undefined;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI !== undefined ? 1 : 0,
  reporter: process.env.CI !== undefined ? 'github' : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  /*
   * Two engines, one of them opt-in. Chromium is what every assertion was written against;
   * WebKit is the engine Safari uses, and Phase 15 added it because nothing in this repository
   * had ever run the app on anything an iPhone would recognise. It does not emulate a
   * safe-area inset — no browser does, which is what `e2e/safe-area.spec.ts` exists for — but
   * it does run the iOS layout and storage behaviour Chromium silently forgives.
   *
   * The defect it found — a write overlapping the first-run bundled nutrition import never
   * completes — was fixed in phase 21 (STATE.md open question 31, decisions 386–391). It stays
   * behind `E2E_WEBKIT=1` all the same, for a reason that is now cost rather than a bug: this
   * engine writes IndexedDB about nine hundred times slower than Chromium — 1 344 rows take
   * 21 s against 23 ms — so every test waits out the first-run import before it can act, and the
   * run takes minutes rather than seconds. A second engine in CI is its own cost on top of
   * that. Run it by hand with `E2E_WEBKIT=1 npm run test:e2e`.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_WEBKIT === undefined
      ? []
      : [
          {
            name: 'webkit',
            // Four minutes, against Chromium's default thirty seconds. Not slack for shaky
            // assertions: `e2e/fixtures.ts` waits for the bundled import before a test acts,
            // and on this engine that wait alone is about twenty seconds of the budget — a
            // two-device test pays it twice.
            timeout: 240_000,
            use: { ...devices['Desktop Safari'] }
          }
        ])
  ],
  ...(usesOwnServer
    ? {
        webServer: {
          command: 'npm run build && npx vite preview --port 4173 --strictPort',
          url: baseURL,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 180_000,
          // A fixed client id keeps the run identical on a machine with no .env.local. The
          // value is never sent anywhere: every Google request is intercepted.
          env: { VITE_GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com' }
        }
      }
    : {})
});
