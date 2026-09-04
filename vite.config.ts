import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { versionDefines } from './scripts/app-version.mjs';

/** `--color-accent` from `src/app.css`, as the hex a manifest and a meta tag can carry. */
const ACCENT = '#529888';
const SURFACE = '#fdfcf8';

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    VitePWA({
      // The user is asked before a new version takes over; nothing swaps under their hands
      // mid-edit. `registerSW` in `src/lib/pwa.svelte.ts` drives the prompt.
      registerType: 'prompt',
      // The plugin's own registration snippet is an inline <script>, which the production CSP
      // (no 'unsafe-inline') blocks. `main.ts` imports the virtual module instead, so the
      // registration ends up inside the hashed bundle. See STATE.md decision 10.
      injectRegister: null,
      manifest: {
        id: '/',
        name: 'Eat My Way — planer posiłków',
        short_name: 'Eat My Way',
        description: 'Osobisty kalendarz planowania posiłków. Działa offline, dane zostają u Ciebie.',
        lang: 'pl',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: SURFACE,
        theme_color: ACCENT,
        categories: ['food', 'health', 'lifestyle'],
        // What makes `navigator.getInstalledRelatedApps()` able to answer at all: it reports
        // only applications the manifest names here, so without this entry the „already
        // installed, opened in a tab" copy could never appear (STATE.md decision 208). The URL
        // is relative, so it resolves per origin and the container run is not a special case.
        // `prefer_related_applications` stays absent — installability is untouched.
        related_applications: [{ platform: 'webapp', url: '/manifest.webmanifest' }],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // Everything the app needs to start and run, including the bundled USDA subset — it is
        // fetched as a hashed asset on first run, and without it a fresh install that happens
        // to be offline would have no ingredients at all (STATE.md open question 5).
        globPatterns: ['**/*.{js,css,html,json,png,svg,webmanifest}'],
        // Hash routing means one document answers every URL.
        navigateFallback: '/index.html',
        // …with one deliberate exception. Answering every navigation from the cache is what
        // makes the app open instantly and work offline, and it is also why a challenge at the
        // edge can never be seen: the only request able to display one is the navigation, and
        // the worker settles that without asking the network. `/polaczenie` is the way out —
        // the worker does not claim it, so opening it is a real trip to the origin, whatever
        // stands in front of the origin gets its chance to ask, and the answer is the app like
        // any other unknown path. See STATE.md decision 238.
        navigateFallbackDenylist: [/^\/polaczenie$/],
        cleanupOutdatedCaches: true,
        // Deliberately no `runtimeCaching`. Workbox then routes navigations and precached
        // assets and nothing else, so no OAuth redirect, token response or Gemini call ever
        // reaches a cache (STATE.md open question 4).
        runtimeCaching: []
      },
      // The dev server does not apply the production CSP, so a service worker there would test
      // nothing the container run does not test better.
      devOptions: { enabled: false }
    })
  ],
  // Which build this is. Read by `src/lib/version.ts`, declared in `src/vite-env.d.ts`.
  define: versionDefines(),
  build: {
    // Vite's module-preload polyfill is injected as an inline <script>, which the
    // production CSP (no 'unsafe-inline') blocks. Every browser we target supports
    // <link rel="modulepreload"> natively. See STATE.md decision 10.
    modulePreload: { polyfill: false },
    target: 'es2022'
  },
  server: {
    port: 5173
  }
});
