<script lang="ts">
  import type { PlannedMeal } from '../types';
  import { parsePortions, stepPortions } from '../day';
  import { mealMacros } from '../macros';
  import { portionWord } from '../text';
  import BottomSheet from './BottomSheet.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * „Porcje" off a meal card's actions: portions eaten without opening the meal (STATE.md
   * decision 438). The same two ways in as „Ile zjadam" on the meal screen — a stepper to the
   * nearest whole or half portion, and a field for any other count — and the same rule: every
   * change is written at once, so there is nothing to confirm or lose on „Zamknij".
   *
   * The cooking scale is not offered here. It changes the ingredient amounts and not the day,
   * and it stays on the meal screen next to the ingredients it scales.
   */

  const MINUS = 'M5 12h14';
  const PLUS = 'M12 5v14M5 12h14';

  let {
    meal,
    name,
    onchange,
    onclose
  }: {
    /** The meal being changed; the sheet is open while there is one. */
    meal: PlannedMeal | undefined;
    name: string;
    onchange: (portions: number) => void;
    onclose: () => void;
  } = $props();

  let field = $state<HTMLInputElement>();

  const portions = $derived(meal?.portionsEaten ?? 1);
  const kcal = $derived(meal === undefined ? 0 : mealMacros(meal).kcal);
  const perPortion = $derived(meal?.macroSnapshot.kcal ?? 0);

  function commit(value: number): void {
    const parsed = parsePortions(value);
    // A cleared or broken field goes back to the stored count instead of writing a guess.
    if (parsed === undefined || parsed === portions) {
      if (field !== undefined) field.value = String(portions);
      return;
    }
    onchange(parsed);
  }
</script>

<BottomSheet open={meal !== undefined} title="Porcje" {onclose}>
  <p class="emw-recipe-name text-sm font-medium">{name}</p>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Ile porcji zjadasz. Zmienia podsumowanie dnia; ilości do ugotowania zostają bez zmian.
  </p>

  <div class="flex items-center gap-2 pt-4">
    <button
      type="button"
      class="emw-press emw-btn-icon border border-(--color-border)"
      aria-label="Mniej zjedzonych porcji"
      onclick={() => commit(stepPortions(portions, -1))}
    >
      <NavIcon path={MINUS} class="size-4" />
    </button>
    <label class="text-sm">
      <span class="sr-only">Zjedzone porcje</span>
      <input
        bind:this={field}
        class="w-20 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-center text-base tabular-nums outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        value={portions}
        onchange={(event) => commit(event.currentTarget.valueAsNumber)}
        onkeydown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.valueAsNumber);
        }}
      />
    </label>
    <button
      type="button"
      class="emw-press emw-btn-icon border border-(--color-border)"
      aria-label="Więcej zjedzonych porcji"
      onclick={() => commit(stepPortions(portions, 1))}
    >
      <NavIcon path={PLUS} class="size-4" />
    </button>
    <span class="text-sm text-(--color-ink-muted)">{portionWord(portions)}</span>
  </div>

  <p class="pt-4 text-sm">
    <span class="font-medium tabular-nums">{Math.round(kcal)} kcal</span>
    <span class="text-(--color-ink-muted)">· 1 porcja = {Math.round(perPortion)} kcal</span>
  </p>
</BottomSheet>
