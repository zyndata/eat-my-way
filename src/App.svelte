<script lang="ts">
  import Router, { push, router } from 'svelte-spa-router';
  import { routes } from './lib/routes';
  import AppShell from './lib/components/AppShell.svelte';
  import ConflictDialog from './lib/components/ConflictDialog.svelte';
  import VaultUnlock from './lib/components/VaultUnlock.svelte';
  import { ensureNutritionImported } from './lib/nutrition/status.svelte';
  import { migrateRetiredDefaultModel } from './lib/gemini/migrate';
  import {
    resolveConflicts,
    resumeSync,
    scheduleSync,
    startAutoSync,
    syncState
  } from './lib/sync/state.svelte';
  import { loadVault } from './lib/vault/session.svelte';

  // First run loads the bundled USDA subset into IndexedDB; every later load reads a meta
  // flag and skips it. Deliberately not awaited: the app is usable while it runs.
  void ensureNutritionImported();

  // A profile written by an earlier build still names the model Google has since retired, and
  // would fail every import with a 404. Nothing else about the profile is touched; a sync is
  // scheduled only when something actually changed.
  void migrateRetiredDefaultModel().then((changed) => {
    if (changed) scheduleSync();
  });

  // The vault is read from IndexedDB (never unlocked) so the settings screen knows whether one
  // exists. Drive sync then resumes silently — it opens no popup and shows no error when the
  // user has never connected, or is simply offline.
  void loadVault().then(() => resumeSync());

  // Drive offers no push channel, so a sync is attempted when the tab regains focus, when the
  // network comes back, and periodically while the tab is open.
  $effect(() => startAutoSync());

  // PLAN.md: the wizard is shown when Drive is connected and its folder holds no data. The
  // flag is cleared by the wizard itself, so skipping it does not bounce the user back.
  $effect(() => {
    if (syncState.setupNeeded && router.location !== '/setup') void push('/setup');
  });
</script>

<AppShell>
  <Router {routes} />
</AppShell>

<!-- Both dialogs are app-wide: a conflict can surface during a background sync from any
     screen, and the unlock prompt must hand control straight back to whatever asked. -->
{#if syncState.conflicts !== null}
  <ConflictDialog
    conflicts={syncState.conflicts}
    onresolve={(choices) => resolveConflicts(choices)}
    oncancel={() => resolveConflicts(null)}
  />
{/if}
<VaultUnlock />
