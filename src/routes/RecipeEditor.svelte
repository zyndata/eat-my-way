<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import IngredientAutocomplete from '../lib/components/IngredientAutocomplete.svelte';
  import type { Ingredient } from '../lib/types';
  import { nutritionStatus } from '../lib/nutrition/status.svelte';

  let { params }: { params?: Record<string, string | undefined> } = $props();
  const id = $derived(params?.id ?? '—');

  /**
   * The editor itself lands in Phase 4. Until then this screen hosts the Phase 3
   * autocomplete on its own, which is what makes it verifiable in a real browser under the
   * production CSP rather than only in unit tests.
   */
  let picked = $state<Ingredient | null>(null);
</script>

<Screen title="Edytor przepisu" lead="Składniki, makroskładniki i instrukcje. Ekran powstanie w fazie 4.">
  <p class="text-sm">Identyfikator przepisu: <span class="font-medium">{id}</span></p>

  <section class="pt-6">
    <h2 class="text-base font-semibold">Wyszukiwarka składników</h2>
    <p class="pt-1 pb-3 text-sm text-(--color-ink-muted)">
      Podpowiedzi pochodzą wyłącznie z lokalnej bazy — działają bez internetu. Polskie znaki
      nie są wymagane: „zolty ser” znajdzie „ser żółty”.
    </p>

    {#if nutritionStatus.phase === 'importing'}
      <p class="text-sm text-(--color-ink-muted)">Trwa wczytywanie bazy składników…</p>
    {:else if nutritionStatus.phase === 'failed'}
      <p class="text-sm text-(--color-ink-muted)">{nutritionStatus.message}</p>
    {:else}
      <IngredientAutocomplete onselect={(ingredient) => (picked = ingredient)} />

      {#if picked}
        <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <dt class="text-(--color-ink-muted)">Kalorie</dt>
          <dd class="font-medium">{Math.round(picked.per100g.kcal)} kcal</dd>
          <dt class="text-(--color-ink-muted)">Białko</dt>
          <dd class="font-medium">{picked.per100g.protein} g</dd>
          <dt class="text-(--color-ink-muted)">Węglowodany</dt>
          <dd class="font-medium">{picked.per100g.carbs} g</dd>
          <dt class="text-(--color-ink-muted)">Tłuszcz</dt>
          <dd class="font-medium">{picked.per100g.fat} g</dd>
        </dl>
        <p class="pt-2 text-xs text-(--color-ink-muted)">Wartości na 100 g. Identyfikator: {picked.id}</p>
      {/if}
    {/if}
  </section>
</Screen>
