<script lang="ts">
  import Router, { push, router } from 'svelte-spa-router';
  import { routes } from './lib/routes';
  import AppShell from './lib/components/AppShell.svelte';
  import ConflictDialog from './lib/components/ConflictDialog.svelte';
  import UpdatePrompt from './lib/components/UpdatePrompt.svelte';
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
  import { repository } from './lib/repository';

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
  //
  // The wizard's local trigger waits for that resume to have had its say, and this is why it
  // is chained rather than run alongside: a second device is „never used" for the seconds
  // before its first sync lands, and greeting it with a first-run wizard for an account it
  // already owns would be worse than never showing one (STATE.md decision 193). `isNeverUsed`
  // re-reads the database afterwards, so a sync that pulled anything cancels it by itself.
  void loadVault()
    .then(() => resumeSync())
    .then(() => offerSetup());

  /** Open the wizard on a database that has never been used, unless a sync already did. */
  async function offerSetup(): Promise<void> {
    if (syncState.setupNeeded) return;
    if (await repository.isNeverUsed()) syncState.setupNeeded = true;
  }

  // Drive offers no push channel, so a sync is attempted when the tab regains focus, when the
  // network comes back, and periodically while the tab is open.
  $effect(() => startAutoSync());

  // PLAN.md: the wizard is shown when Drive is connected and its folder holds no data — and,
  // from Phase 11, on a database that has never been used at all. The flag is cleared by the
  // wizard itself, which also records the visit in `meta`, so skipping does not bounce the
  // user back and a reload does not reopen it.
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

<!-- The new-version bar. App-wide because a worker can finish installing on any screen. -->
<UpdatePrompt />
