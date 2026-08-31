<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import {
    NUTRITION_ATTRIBUTION,
    NUTRITION_INGREDIENT_COUNT,
    NUTRITION_SOURCES
  } from '../lib/nutrition/meta';
  import { nutritionStatus } from '../lib/nutrition/status.svelte';

  /** Human-readable names for the pinned FoodData Central releases. */
  const SOURCE_LABELS: Record<string, string> = {
    'sr_legacy_2018-04': 'SR Legacy (kwiecień 2018)',
    'foundation_2026-04-30': 'Foundation Foods (30 kwietnia 2026)'
  };
</script>

<Screen title="O aplikacji" lead="Skąd pochodzą dane i na jakich zasadach są używane.">
  <section class="space-y-3">
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

  <section class="space-y-2 pt-6">
    <h2 class="text-base font-semibold">Licencja aplikacji</h2>
    <p class="text-sm text-(--color-ink-muted)">
      Eat My Way jest udostępniana na licencji MIT. Kod źródłowy jest publiczny.
    </p>
  </section>
</Screen>
