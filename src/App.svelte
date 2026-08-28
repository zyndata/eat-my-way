<script lang="ts">
  import Router from 'svelte-spa-router';
  import { routes } from './lib/routes';
  import AppShell from './lib/components/AppShell.svelte';
</script>

<AppShell>
  <Router {routes} />
</AppShell>
