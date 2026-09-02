<script lang="ts">
  import { syncNow, syncState } from '../sync/state.svelte';

  /**
   * A one-line sync status, shown only when there is something to say. Sync is background
   * work: a successful one is silent, because a badge that is always lit teaches the user to
   * stop reading it.
   */

  const visible = $derived(
    syncState.configured &&
      (syncState.phase === 'syncing' || syncState.phase === 'error' || syncState.foreignAccount !== null)
  );
</script>

{#if visible}
  <div class="px-4 pt-2" role="status" aria-live="polite">
    {#if syncState.phase === 'syncing'}
      <p class="text-xs text-(--color-ink-muted)">Synchronizacja z Dyskiem…</p>
    {:else if syncState.foreignAccount !== null}
      <p class="text-xs text-amber-700">
        Połączone inne konto Google.
        <a class="underline" href="#/settings">Rozstrzygnij w Ustawieniach</a>
      </p>
    {:else}
      <p class="text-xs text-amber-700">
        {syncState.message}
        <button type="button" class="underline" onclick={() => void syncNow({ interactive: true })}>
          Spróbuj ponownie
        </button>
      </p>
    {/if}
  </div>
{/if}
