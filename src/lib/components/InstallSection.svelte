<script lang="ts">
  import { promptInstall, pwaState } from '../pwa.svelte';

  /**
   * „Aplikacja na urządzeniu". The browser's own install prompt, offered from a place where
   * there is room to say what installing does — rather than as a banner over the calendar the
   * first time someone opens the app.
   *
   * **The section says nothing when it has nothing to offer** (PLAN.md Phase 11 task 1, STATE.md
   * decision 189). It used to end with „look in your browser's menu for Install", which is not
   * an instruction — the item is in a different place in every browser and absent in most — so
   * on Android, where the prompt never appeared, the whole screen read as a broken feature.
   * Now there are exactly two offers, and where neither applies the section renders nothing:
   *
   * - the captured `beforeinstallprompt`, which is a button that works; and
   * - the iOS share-sheet route, which is one real menu path on one platform.
   *
   * Two states are informational rather than offers and get their own copy: running as an
   * installed app, and — new — a *tab* of a browser that already has the app installed. Chrome
   * withholds `beforeinstallprompt` in that case and the tab does not match
   * `display-mode: standalone`, so the section read „this browser cannot install the app" to
   * someone who had already installed it (STATE.md decision 191).
   *
   * The offline note is not install advice; it stays whenever it is true.
   */

  let outcome = $state<'accepted' | 'dismissed' | 'unavailable' | null>(null);

  /** Anything to say about installing at all — otherwise only the offline note can show. */
  const hasInstallCopy = $derived(
    pwaState.installed || pwaState.installedElsewhere || pwaState.installable || pwaState.ios
  );
</script>

{#if hasInstallCopy || pwaState.offlineReady}
  <section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4">
    <h2 class="text-base font-semibold">Aplikacja na urządzeniu</h2>

    {#if pwaState.installed}
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Aplikacja jest zainstalowana i działa jak zwykły program — także bez internetu.
      </p>
    {:else if pwaState.installedElsewhere}
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Aplikacja jest już zainstalowana na tym urządzeniu — teraz oglądasz ją w karcie
        przeglądarki. Uruchom ją z ekranu głównego albo z listy programów, żeby działała w
        osobnym oknie. Dane są te same w obu miejscach.
      </p>
    {:else if hasInstallCopy}
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
        <!-- iOS: the only platform where „look in the menu" names one real, stable path. -->
        <p class="pt-3 text-sm text-(--color-ink-muted)">
          Na iPhonie i iPadzie: „Udostępnij” → „Do ekranu początkowego”.
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
{/if}
