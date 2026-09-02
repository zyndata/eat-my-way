import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // `state.svelte.ts` is a rune-enabled module: `$state` is compiler syntax, not a function,
  // so the Svelte plugin has to run over it before Vitest sees it. Everything else in the
  // suite is plain TypeScript and passes through untouched.
  plugins: [svelte()],
  test: {
    // No DOM is needed: the data layer is pure TypeScript, IndexedDB comes from
    // fake-indexeddb in the setup file, and the two modules that do touch `window`
    // (`google-auth`, `state.svelte`) stub exactly the handful of members they use.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts']
  }
});
