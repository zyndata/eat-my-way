import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
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
