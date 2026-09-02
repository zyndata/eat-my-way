<script lang="ts">
  import { applyUpdate, pwaState } from '../pwa.svelte';

  /**
   * „A new version is ready" — a bar, not a dialog. A modal here would interrupt whatever the
   * user is doing to announce something that can wait indefinitely; the waiting worker does no
   * harm sitting there, and the current page keeps working exactly as it is.
   */
</script>

{#if pwaState.updateReady}
  <div
    class="fixed inset-x-3 bottom-20 z-40 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3 shadow-lg md:inset-x-auto md:right-4 md:bottom-4 md:max-w-sm"
    role="status"
  >
    <p class="text-sm">
      Jest nowa wersja aplikacji. Możesz ją wczytać teraz albo później — nic nie zginie.
    </p>
    <div class="flex gap-2">
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        onclick={() => (pwaState.updateReady = false)}
      >
        Później
      </button>
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink)"
        onclick={applyUpdate}
      >
        Odśwież
      </button>
    </div>
  </div>
{/if}
