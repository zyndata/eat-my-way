<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import {
    NUTRITION_ATTRIBUTION,
    NUTRITION_INGREDIENT_COUNT,
    NUTRITION_SOURCES
  } from '../lib/nutrition/meta';
  import { nutritionStatus } from '../lib/nutrition/status.svelte';
  import { APP_COMMIT, APP_VERSION_LABEL, builtOn } from '../lib/version';

  /** Human-readable names for the pinned FoodData Central releases. */
  const SOURCE_LABELS: Record<string, string> = {
    'sr_legacy_2018-04': 'SR Legacy (kwiecień 2018)',
    'foundation_2026-04-30': 'Foundation Foods (30 kwietnia 2026)'
  };
</script>

<Screen title="O aplikacji" lead="Skąd pochodzą dane i na jakich zasadach są używane.">
  <!-- The questions the first end-user review actually asked: where recipes come from, and
       what the app does with Drive (STATE.md decision 61). -->
  <section class="space-y-3">
    <h2 class="text-base font-semibold">Jak to działa</h2>
    <p class="text-sm text-(--color-ink-muted)">
      <strong class="font-medium text-(--color-ink)">Przepisy są Twoje.</strong>
      Wpisujesz je sam albo wklejasz link czy tekst z bloga — wtedy Gemini rozkłada przepis na
      składniki i ilości. Aplikacja nie ma własnej bazy przepisów i nie szuka ich w internecie
      za Ciebie.
    </p>
    <p class="text-sm text-(--color-ink-muted)">
      <strong class="font-medium text-(--color-ink)">Kalorie nie są zgadywane.</strong>
      Wartości odżywcze pochodzą wyłącznie z wbudowanej bazy USDA, przeliczanej na miejscu.
      Model językowy nigdy nie podaje liczb — dzięki temu ten sam posiłek zawsze liczy się tak
      samo, a zapisany posiłek zachowuje wartości z dnia, w którym go zaplanowałeś.
    </p>
    <p class="text-sm text-(--color-ink-muted)">
      <strong class="font-medium text-(--color-ink)">Dysk Google to kopia zapasowa, nie
        źródło przepisów.</strong>
      Dane trzymamy w przeglądarce (IndexedDB) i to one są źródłem prawdy; Dysk służy tylko do
      przeniesienia ich na inne urządzenie. Aplikacja zapisuje w prywatnym folderze aplikacji i
      <strong class="font-medium text-(--color-ink)">nie widzi żadnego innego pliku na Twoim
        Dysku</strong> — nie może go otworzyć ani wyszukać.
    </p>
    <p class="text-sm text-(--color-ink-muted)">
      <strong class="font-medium text-(--color-ink)">Działa offline.</strong>
      Kalendarz, przepisy i edycja nie wymagają połączenia. Internetu potrzebują tylko dwie
      rzeczy: synchronizacja z Dyskiem i import przepisu.
    </p>
  </section>

  <section class="space-y-3 pt-6">
    <h2 class="text-base font-semibold">Dane o wartościach odżywczych</h2>
    <p class="text-sm text-(--color-ink-muted)">{NUTRITION_ATTRIBUTION}</p>
    <p class="text-sm text-(--color-ink-muted)">
      Aplikacja zawiera {NUTRITION_INGREDIENT_COUNT} wybranych składników przeliczonych na
      100 g. Dane są wbudowane w aplikację i wczytywane raz, przy pierwszym uruchomieniu —
      później działają w pełni offline. Nie wysyłamy żadnych zapytań do FoodData Central.
    </p>
    <ul class="list-inside list-disc text-sm text-(--color-ink-muted)">
      {#each NUTRITION_SOURCES as source (source)}
        <li>{SOURCE_LABELS[source] ?? source}</li>
      {/each}
    </ul>
    <p class="text-sm text-(--color-ink-muted)">
      Nazwy polskie i synonimy to opracowanie własne — USDA nie odpowiada za tłumaczenia ani
      za dobór produktów.
    </p>
  </section>

  <section class="space-y-2 pt-6">
    <h2 class="text-base font-semibold">Stan lokalnej bazy</h2>
    <p class="text-sm text-(--color-ink-muted)">
      {#if nutritionStatus.phase === 'ready'}
        Wczytano składników: {nutritionStatus.count}.
      {:else if nutritionStatus.phase === 'importing'}
        Trwa wczytywanie bazy składników…
      {:else if nutritionStatus.phase === 'failed'}
        {nutritionStatus.message}
      {:else}
        Baza składników nie została jeszcze wczytana.
      {/if}
    </p>
  </section>

  <!-- An installed PWA can keep serving an old build until the user accepts the update, so the
       version is the one thing the app must be able to say about itself (STATE.md decision 224). -->
  <section class="space-y-2 pt-6">
    <h2 class="text-base font-semibold">Wersja aplikacji</h2>
    <p class="text-sm text-(--color-ink-muted)">
      <strong class="font-medium text-(--color-ink)">{APP_VERSION_LABEL}</strong>
      <span class="text-(--color-ink-muted)">({APP_COMMIT})</span>
    </p>
    {#if builtOn() !== null}
      <p class="text-sm text-(--color-ink-muted)">Zbudowano: {builtOn()}.</p>
    {/if}
  </section>

  <section class="space-y-2 pt-6">
    <h2 class="text-base font-semibold">Licencja aplikacji</h2>
    <p class="text-sm text-(--color-ink-muted)">
      Eat My Way jest udostępniana na licencji MIT. Kod źródłowy jest publiczny.
    </p>
  </section>
</Screen>
