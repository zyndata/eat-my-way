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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
