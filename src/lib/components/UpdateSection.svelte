<script lang="ts">
  import { applyUpdate, checkForUpdate, pwaState, type UpdateCheck } from '../pwa.svelte';
  import { APP_VERSION_LABEL } from '../version';

  /**
   * „Wersja i aktualizacje". Two things a user cannot otherwise find out: which build they are
   * looking at, and whether it is the current one.
   *
   * The worker is registered with `registerType: 'prompt'`, so a new bundle waits for consent
   * and an installed app can run an old build for as long as nobody reloads it. Coming back to
   * the app now checks by itself (STATE.md decision 225) — this button is for the moment when
   * someone actively wonders, and it is only worth having because it can answer **„masz
   * najnowszą wersję"**. A button that silently does nothing when there is no update reads as
   * broken, which is the whole reason the result line is not optional here.
   */

  let checking = $state(false);
  let result = $state<UpdateCheck | null>(null);

  async function check(): Promise<void> {
    checking = true;
    result = null;
    result = await checkForUpdate();
    checking = false;
  }
</script>

<section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
  <h2 class="text-base font-semibold">Wersja i aktualizacje</h2>
  <p class="pt-2 text-sm text-(--color-ink-muted)">
    Masz wersję <strong class="font-medium text-(--color-ink)">{APP_VERSION_LABEL}</strong>.
  </p>

  {#if pwaState.updateReady}
    <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">
      Jest nowa wersja i czeka na wczytanie. Nic nie zginie — dane zostają na urządzeniu.
    </p>
    <button
      type="button"
      class="mt-3 rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink)"
      onclick={applyUpdate}
    >
      Wczytaj nową wersję
    </button>
  {:else if pwaState.canCheckUpdates}
    <button
      type="button"
      class="mt-3 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium disabled:opacity-60"
      disabled={checking}
      onclick={() => void check()}
    >
      {checking ? 'Sprawdzam…' : 'Sprawdź aktualizacje'}
    </button>

    {#if result !== null}
      <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">
        {#if result === 'current'}
          Masz najnowszą wersję.
        {:else if result === 'offline'}
          Bez połączenia nie mogę sprawdzić. Spróbuj, kiedy będziesz online.
        {:else}
          Nie udało się sprawdzić — pobieranie nowej wersji się nie powiodło. Spróbuj przy
          lepszym połączeniu; nic się nie zepsuło i nic nie zginęło.
        {/if}
      </p>
    {/if}
  {:else}
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      Ta wersja działa bez zapisu na urządzeniu, więc nie ma czego sprawdzać — odśwież stronę,
      żeby wczytać najnowszą.
    </p>
  {/if}
</section>
