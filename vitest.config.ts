import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The data layer is plain TypeScript; no DOM is needed. IndexedDB comes from
    // fake-indexeddb in the setup file, which is enough for Dexie.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts']
  }
});
