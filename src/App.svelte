<script lang="ts">
  import Router from 'svelte-spa-router';
  import { routes } from './lib/routes';
  import AppShell from './lib/components/AppShell.svelte';
  import { ensureNutritionImported } from './lib/nutrition/status.svelte';

  // First run loads the bundled USDA subset into IndexedDB; every later load reads a meta
  // flag and skips it. Deliberately not awaited: the app is usable while it runs.
  void ensureNutritionImported();
</script>

<AppShell>
  <Router {routes} />
</AppShell>
