<script lang="ts">
  import type { Recipe } from '../types';
  import type { ShoppingLine, ShoppingMeal } from '../shopping';
  import { formatShoppingLine, formatShoppingList, shoppingLines } from '../shopping';
  import { ingredientLookup } from '../macros';
  import { repository } from '../repository';
  import { shareText, type ShareOutcome } from '../share';
  import BottomSheet from './BottomSheet.svelte';

  /**
   * The shopping list (PLAN.md Phase 9 task 7), for whatever scope the caller hands it: one
   * meal, one day, or a whole week (STATE.md decision 158).
   *
   * Amounts follow `cookingScale` and never `portionsEaten` — the list is what has to be
   * bought and cooked, not what will be eaten off it. The same ingredient is summed across
   * every meal in the scope, per unit, because 2 szt and 100 g cannot be added.
   *
   * It leaves through `navigator.share()` or the clipboard, neither of which is a network
   * request: the CSP is untouched (decision 144). The text is also on screen, so a browser
   * where both routes fail still lets it be selected and copied by hand.
   */

  let {
    open = false,
    title,
    dates,
    mealId,
    onclose
  }: {
    open?: boolean;
    /** Polish heading, and the first line of the shared text. */
    title: string;
    /** Days the list covers, in order. */
    dates: readonly string[];
    /** Narrows the scope to a single meal on `dates[0]`. */
    mealId?: string | undefined;
    onclose: () => void;
  } = $props();

  let loading = $state(false);
  let lines = $state<ShoppingLine[]>([]);
  let outcome = $state<ShareOutcome | null>(null);

  const text = $derived(formatShoppingList(title, lines));

  async function load(): Promise<void> {
    loading = true;
    outcome = null;

    const from = dates[0] ?? '';
    const to = dates[dates.length - 1] ?? from;
    const wanted = new Set(dates);
    const days = (await repository.getDays(from, to)).filter((day) => wanted.has(day.date));

    const planned = days.flatMap((day) =>
      day.meals.filter((meal) => mealId === undefined || meal.id === mealId)
    );

    const recipes: Map<string, Recipe> = await repository.recipesByIds(
      planned.map((meal) => meal.recipeId)
    );
    const ingredientIds = [...recipes.values()].flatMap((recipe) =>
      recipe.items.map((item) => item.ingredientId)
    );
    const lookup = ingredientLookup(await repository.ingredientsByIds(ingredientIds));

    const meals: ShoppingMeal[] = planned.map((meal) => ({
      meal,
      recipe: recipes.get(meal.recipeId)
    }));

    lines = shoppingLines(meals, lookup);
    loading = false;
  }

  $effect(() => {
    if (!open) return;
    void load();
  });

  async function share(): Promise<void> {
    outcome = await shareText(title, text);
  }
</script>

<BottomSheet {open} title="Lista zakupów" {onclose}>
  <p class="text-sm text-(--color-ink-muted)">{title}</p>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Ilości według liczby porcji do ugotowania, nie zjedzonych.
  </p>

  {#if loading}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if lines.length === 0}
    <p class="pt-4 text-sm text-(--color-ink-muted)">
      Nie ma czego kupić — w tym zakresie nie ma posiłków ze składnikami.
    </p>
  {:else}
    <ul class="flex flex-col gap-1 pt-4">
      {#each lines as line (line.ingredientId + line.unit)}
        <li
          class="rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-sm"
        >
          {formatShoppingLine(line)}
        </li>
      {/each}
    </ul>

    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink)"
        onclick={() => void share()}
      >
        Udostępnij listę
      </button>
      {#if outcome === 'copied'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Skopiowano do schowka.</span>
      {:else if outcome === 'shared'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Udostępniono.</span>
      {:else if outcome === 'failed'}
        <span class="text-sm text-amber-700" role="status">
          Nie udało się udostępnić ani skopiować — zaznacz listę powyżej i skopiuj ręcznie.
        </span>
      {/if}
    </div>
  {/if}
</BottomSheet>
