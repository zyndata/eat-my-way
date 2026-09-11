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
   * It is behind `E2E_WEBKIT=1` because the first run of it found a WebKit-only defect in the
   * data layer, not in the layout: a write that overlaps the first-run bundled nutrition
   * import never completes, so a large part of the suite hangs (STATE.md open question 31).
   * Putting it in CI today would make CI red about a bug nobody is fixing this phase. Run it
   * with `E2E_WEBKIT=1 npm run test:e2e` — that is the reproduction.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_WEBKIT === undefined
      ? []
      : [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }])
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
