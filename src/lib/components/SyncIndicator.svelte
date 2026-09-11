<script lang="ts">
  import Spinner from './Spinner.svelte';
  import { STAGE_LABELS, syncNow, syncState } from '../sync/state.svelte';

  /**
   * A one-line sync status, shown only when there is something to say. Sync is background
   * work: a successful one is silent, because a badge that is always lit teaches the user to
   * stop reading it.
   *
   * Phase 11 changes how loud „in progress" is, not how long it lasts: the line gains a
   * spinner and names which of the two waits is running. The spinner is `aria-hidden`, so this
   * `role="status"` region is still announced exactly once.
   */

  const visible = $derived(
    syncState.configured &&
      (syncState.phase === 'syncing' || syncState.phase === 'error' || syncState.foreignAccount !== null)
  );
</script>

{#if visible}
  <!-- Same side padding as `main`: in landscape it has to clear the notch too (Phase 15). -->
  <div
    class="pt-2 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]"
    role="status"
    aria-live="polite"
  >
    {#if syncState.phase === 'syncing'}
      <p class="flex items-center gap-2 text-xs text-(--color-ink-muted)">
        <Spinner class="size-3" />
        {syncState.stage === null ? 'Synchronizacja z Dyskiem…' : STAGE_LABELS[syncState.stage]}
      </p>
    {:else if syncState.foreignAccount !== null}
      <p class="text-xs text-(--color-warn)">
        Połączone inne konto Google{syncState.foreignAccount.account.label
          ? ` (${syncState.foreignAccount.account.label})`
          : ''}.
        <a class="underline" href="#/settings">Rozstrzygnij w Ustawieniach</a>
      </p>
    {:else}
      <p class="text-xs text-(--color-warn)">
        {syncState.message}
        <button type="button" class="underline" onclick={() => void syncNow({ interactive: true })}>
          Spróbuj ponownie
        </button>
      </p>
    {/if}
  </div>
{/if}
