import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // TypeScript in <script lang="ts">. No other preprocessors: every extra
  // transform is another thing that can inject styles a strict CSP rejects.
  preprocess: vitePreprocess()
};
