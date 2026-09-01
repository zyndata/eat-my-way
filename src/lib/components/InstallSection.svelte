<script lang="ts">
  import { promptInstall, pwaState } from '../pwa.svelte';

  /**
   * „Zainstaluj aplikację". The browser's own install prompt, offered from a place where
   * there is room to say what installing does — rather than as a banner over the calendar the
   * first time someone opens the app.
   *
   * Three states, because the browsers differ: Chromium hands us a prompt to fire, iOS Safari
   * hands us nothing and expects „Udostępnij → Dodaj do ekranu początkowego", and an app that
   * is already installed should say so and stop asking.
   */

  let outcome = $state<'accepted' | 'dismissed' | 'unavailable' | null>(null);
</script>

<section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
  <h2 class="text-base font-semibold">Aplikacja na urządzeniu</h2>

  {#if pwaState.installed}
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      Aplikacja jest zainstalowana i działa jak zwykły program — także bez internetu.
    </p>
  {:else}
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      Możesz dodać Eat My Way do ekranu głównego albo do listy programów. Uruchamia się wtedy w
      osobnym oknie, bez paska przeglądarki, i działa offline. Dane zostają te same — to ta sama
      aplikacja, nie kopia.
    </p>

    {#if pwaState.installable}
      <button
        type="button"
        class="mt-3 rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink)"
        onclick={() => void promptInstall().then((result) => (outcome = result))}
      >
        Zainstaluj aplikację
      </button>
      {#if outcome === 'dismissed'}
        <p class="pt-2 text-sm text-(--color-ink-muted)" role="status">
          Nic nie zainstalowano. Możesz wrócić tu w każdej chwili.
        </p>
      {/if}
    {:else}
      <p class="pt-3 text-sm text-(--color-ink-muted)">
        Ta przeglądarka nie daje przycisku instalacji. Na Androidzie i na komputerze poszukaj w
        menu przeglądarki pozycji „Zainstaluj aplikację" lub „Dodaj do ekranu głównego”; na
        iPhonie: „Udostępnij” → „Do ekranu początkowego”.
      </p>
    {/if}
  {/if}

  {#if pwaState.offlineReady}
    <p class="pt-3 text-sm text-(--color-ink-muted)">
      Aplikacja jest zapisana na urządzeniu i otworzy się bez internetu. Bez połączenia nie
      działają tylko dwie rzeczy: synchronizacja z Dyskiem i import przepisu.
    </p>
  {/if}
</section>
