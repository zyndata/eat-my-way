<script lang="ts">
  import type { Ingredient, PlannedMeal, Recipe } from '../lib/types';
  import {
    displayedAmount,
    displayedGrams,
    ingredientLookup,
    itemMacros,
    recipePortionMacros,
    scaleMacros
  } from '../lib/macros';
  import { findMeal } from '../lib/day';
  import { portionWord, sourceHost } from '../lib/text';
  import {
    addDays,
    formatDayLong,
    formatDayMonth,
    isDateKey,
    relativeDayLabel,
    todayDate
  } from '../lib/dates';
  import { repository } from '../lib/repository';
  import { scheduleSync } from '../lib/sync/state.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import NavIcon from '../lib/components/NavIcon.svelte';
  import ShoppingListSheet from '../lib/components/ShoppingListSheet.svelte';

  /**
   * `/day/:date/:mealId` — one planned meal, in PLAN.md's order: name, the recipe, the
   * cooking scale, the portions actually eaten, then the per-ingredient breakdown.
   *
   * The two numbers do very different things and the screen has to make that obvious:
   * `cookingScale` rescales the ingredient amounts and nothing else, while `portionsEaten`
   * is the only one that moves the day's totals. Macros always come from the meal's frozen
   * `macroSnapshot`, never recomputed from the recipe — a recipe edited afterwards must not
   * silently rewrite what was eaten.
   */

  const CHEVRON_LEFT = 'M15 5l-7 7 7 7';
  const MINUS = 'M5 12h14';
  const PLUS = 'M12 5v14M5 12h14';

  let { params }: { params?: Record<string, string | undefined> } = $props();

  const date = $derived(params?.date ?? '');
  const mealId = $derived(params?.mealId ?? '');
  const today = todayDate();
  const tomorrow = $derived(isDateKey(date) ? addDays(date, 1) : '');

  let loading = $state(true);
  let meal = $state<PlannedMeal | undefined>(undefined);
  let recipe = $state<Recipe | undefined>(undefined);
  let ingredients = $state<Ingredient[]>([]);
  /** Ids of tomorrow's meals from this same recipe — what „Dodaj też jutro" reflects. */
  let tomorrowMeals = $state<string[]>([]);
  let uncheckOpen = $state(false);
  let shoppingOpen = $state(false);

  const alreadyTomorrow = $derived(tomorrowMeals.length > 0);

  let scale = $state(1);
  let portions = $state(1);

  const lookup = $derived(ingredientLookup(ingredients));
  /** What the meal contributes to the day: the frozen snapshot times the portions eaten. */
  const eaten = $derived(
    meal === undefined
      ? { kcal: 0, protein: 0, carbs: 0, fat: 0 }
      : scaleMacros(meal.macroSnapshot, portions)
  );
  /** The recipe as it stands now — only used to point out that it has drifted. */
  const currentPortion = $derived(
    recipe === undefined ? undefined : recipePortionMacros(recipe, lookup)
  );
  const drifted = $derived(
    meal !== undefined &&
      currentPortion !== undefined &&
      Math.abs(currentPortion.kcal - meal.macroSnapshot.kcal) >= 1
  );

  async function load(dayDate: string, id: string): Promise<void> {
    loading = true;
    meal = undefined;
    recipe = undefined;
    ingredients = [];
    tomorrowMeals = [];

    if (!isDateKey(dayDate)) {
      loading = false;
      return;
    }

    const found = findMeal(await repository.getDay(dayDate), id);
    if (found === undefined) {
      loading = false;
      return;
    }

    meal = found;
    scale = found.cookingScale;
    portions = found.portionsEaten;

    const stored = await repository.getRecipe(found.recipeId);
    recipe = stored;
    if (stored !== undefined) {
      ingredients = await repository.ingredientsByIds(
        stored.items.map((item) => item.ingredientId)
      );
    }

    const next = await repository.getDay(addDays(dayDate, 1));
    tomorrowMeals = next.meals
      .filter((other) => other.recipeId === found.recipeId)
      .map((other) => other.id);
    loading = false;
  }

  $effect(() => {
    void load(date, mealId);
  });

  /** Cooking less than a whole batch is fine; cooking none of it is not. */
  function clampScale(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 1;
  }

  function clampPortions(value: number): number {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 1;
  }

  async function setScale(value: number): Promise<void> {
    scale = clampScale(value);
    if (meal === undefined) return;
    await repository.updateMeal(date, mealId, { cookingScale: scale });
    scheduleSync();
  }

  async function setPortions(value: number): Promise<void> {
    portions = clampPortions(value);
    if (meal === undefined) return;
    await repository.updateMeal(date, mealId, { portionsEaten: portions });
    scheduleSync();
  }

  /** „Gotuję na 2 dni": scale to 2 and drop a one-portion copy on tomorrow. */
  async function cookAlsoTomorrow(): Promise<void> {
    if (meal === undefined || alreadyTomorrow) return;
    await repository.cookAlsoOn(date, mealId, tomorrow, { scale: Math.max(2, scale) });
    await load(date, mealId);
    scheduleSync();
  }

  /**
   * Unchecking undoes exactly what checking did: the copy leaves tomorrow, and the cooking
   * scale goes back to 1 — but only if it is still the 2 the checkbox set, so a scale the
   * user typed themselves survives. Confirmed rather than silent, because the meal on
   * tomorrow may be one the user planned deliberately rather than the copy this made
   * (STATE.md decision 76).
   */
  async function undoTomorrow(): Promise<void> {
    uncheckOpen = false;
    const last = tomorrowMeals.at(-1);
    if (last === undefined) return;

    await repository.removeMealFromDay(tomorrow, last);
    if (scale === 2) await repository.updateMeal(date, mealId, { cookingScale: 1 });
    await load(date, mealId);
    scheduleSync();
  }
</script>

{#if !isDateKey(date)}
  <section>
    <h1 class="text-2xl font-semibold tracking-tight">Nie ma takiej daty</h1>
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      <a class="font-medium text-(--color-accent) underline" href="#/">Wróć do dzisiaj</a>.
    </p>
  </section>
{:else}
  <a
    class="inline-flex items-center gap-1 text-sm font-medium text-(--color-accent)"
    href="#/day/{date}"
  >
    <NavIcon path={CHEVRON_LEFT} class="size-4" />
    {relativeDayLabel(date, today)}
  </a>

  {#if loading}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if meal === undefined}
    <section class="pt-2">
      <h1 class="text-2xl font-semibold tracking-tight">Nie ma takiego posiłku</h1>
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Ten posiłek nie jest już zaplanowany na {formatDayLong(date)}.
      </p>
    </section>
  {:else}
    <section class="pt-2">
      <h1 class="text-2xl font-semibold tracking-tight {recipe === undefined ? 'italic' : ''}">
        {recipe?.name ?? 'Usunięty przepis'}
      </h1>
      <p class="pt-1 text-sm text-(--color-ink-muted)">{formatDayLong(date)}</p>
      {#if recipe === undefined}
        <p class="pt-2 text-sm text-(--color-ink-muted)">
          Przepis został usunięty z biblioteki. Zapisane makroskładniki tego posiłku zostają —
          zmienić można tylko liczbę zjedzonych porcji.
        </p>
      {/if}
    </section>

    {#if recipe !== undefined}
      <section class="pt-5">
        <h2 class="text-base font-semibold">
          Składniki
          {#if scale !== 1}
            <span class="font-normal text-(--color-ink-muted)">na {scale} porcji do ugotowania</span>
          {:else}
            <span class="font-normal text-(--color-ink-muted)">na 1 porcję</span>
          {/if}
        </h2>

        {#if recipe.items.length === 0}
          <p class="pt-1 text-sm text-(--color-ink-muted)">Ten przepis nie ma składników.</p>
        {:else}
          <ul class="flex flex-col gap-1 pt-2">
            {#each recipe.items as item, index (index)}
              {@const ingredient = lookup(item.ingredientId)}
              <li
                class="flex items-baseline justify-between gap-3 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2"
              >
                <span class="min-w-0 truncate text-sm">
                  {ingredient?.name ?? 'Nieznany składnik'}
                </span>
                <span class="shrink-0 text-sm font-medium tabular-nums">
                  {Math.round(displayedAmount(item, scale) * 100) / 100}
                  {item.unit === 'szt' ? 'szt.' : item.unit}
                  {#if item.unit !== 'g'}
                    <span class="font-normal text-(--color-ink-muted)">
                      ({Math.round(displayedGrams(item, scale))} g)
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if recipe.instructions !== ''}
          <div class="pt-4">
            <h3 class="text-sm font-semibold">Przygotowanie</h3>
            <p class="pt-1 text-sm whitespace-pre-line">{recipe.instructions}</p>
          </div>
        {/if}

        {#if recipe.sourceUrl !== undefined}
          <div class="pt-4">
            <h3 class="text-sm font-semibold">Źródło</h3>
            <p class="pt-1 text-sm">
              <a
                class="font-medium text-(--color-accent) underline"
                href={recipe.sourceUrl}
                target="_blank"
                rel="noopener noreferrer">{sourceHost(recipe.sourceUrl)}</a>
            </p>
          </div>
        {/if}
      </section>
    {/if}

    <section class="mt-5 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
      <h2 class="text-sm font-semibold">Ile gotuję</h2>
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        Zmienia tylko ilości składników powyżej. Kalorie dnia zostają bez zmian.
      </p>

      <div class="flex items-center gap-2 pt-3">
        <button
          type="button"
          class="rounded-lg border border-(--color-border) p-2"
          aria-label="Mniej porcji do ugotowania"
          onclick={() => void setScale(Math.max(1, scale - 1))}
        >
          <NavIcon path={MINUS} class="size-4" />
        </button>
        <label class="text-sm">
          <span class="sr-only">Porcje do ugotowania</span>
          <input
            class="w-20 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-center text-base tabular-nums outline-none focus:border-(--color-accent)"
            type="number"
            inputmode="decimal"
            min="0.1"
            step="any"
            value={scale}
            onchange={(event) => void setScale(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          class="rounded-lg border border-(--color-border) p-2"
          aria-label="Więcej porcji do ugotowania"
          onclick={() => void setScale(scale + 1)}
        >
          <NavIcon path={PLUS} class="size-4" />
        </button>
        <span class="text-sm text-(--color-ink-muted)">
          {portionWord(scale)}
        </span>
      </div>

      <div class="pt-4">
        <!-- The shopping list belongs next to „ile gotuję": it is the number it reflects
             (PLAN.md Phase 9 task 7). A day's or a week's list lives on the day screen. -->
        <button
          type="button"
          class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
          onclick={() => (shoppingOpen = true)}
        >
          Lista zakupów
        </button>
      </div>

      <div class="pt-4">
        <label class="flex items-center gap-2 text-sm">
          <input
            class="size-4 accent-(--color-accent)"
            type="checkbox"
            checked={alreadyTomorrow}
            onchange={(event) => {
              // Tomorrow's day is the source of truth, not the box: both paths re-read it,
              // and the removal has to be confirmed first.
              event.currentTarget.checked = alreadyTomorrow;
              if (alreadyTomorrow) uncheckOpen = true;
              else void cookAlsoTomorrow();
            }}
          />
          Dodaj też jutro
        </label>
        <p class="pt-1 pl-6 text-xs text-(--color-ink-muted)">
          {#if alreadyTomorrow}
            Ten przepis jest zaplanowany na
            <a class="text-(--color-accent) underline" href="#/day/{tomorrow}">jutro</a>. Odznacz,
            żeby usunąć tamten posiłek.
          {:else}
            Ugotuje się na dwa dni: ustawimy 2 porcje i dopiszemy jeden posiłek do jutra.
          {/if}
        </p>
      </div>
    </section>

    <section class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
      <h2 class="text-sm font-semibold">Ile zjadam</h2>
      <p class="pt-1 text-xs text-(--color-ink-muted)">
        To jedyna liczba, która wpływa na podsumowanie dnia.
      </p>

      <div class="flex items-center gap-2 pt-3">
        <button
          type="button"
          class="rounded-lg border border-(--color-border) p-2"
          aria-label="Mniej zjedzonych porcji"
          onclick={() => void setPortions(Math.max(0, portions - 0.5))}
        >
          <NavIcon path={MINUS} class="size-4" />
        </button>
        <label class="text-sm">
          <span class="sr-only">Zjedzone porcje</span>
          <input
            class="w-20 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-center text-base tabular-nums outline-none focus:border-(--color-accent)"
            type="number"
            inputmode="decimal"
            min="0"
            step="any"
            value={portions}
            onchange={(event) => void setPortions(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          class="rounded-lg border border-(--color-border) p-2"
          aria-label="Więcej zjedzonych porcji"
          onclick={() => void setPortions(portions + 0.5)}
        >
          <NavIcon path={PLUS} class="size-4" />
        </button>
        <span class="text-sm text-(--color-ink-muted)">
          {portionWord(portions)}
        </span>
      </div>

      <dl class="grid grid-cols-2 gap-x-4 gap-y-1 pt-4 text-sm sm:grid-cols-4">
        <dt class="text-(--color-ink-muted)">Kalorie</dt>
        <dd class="font-medium tabular-nums">{Math.round(eaten.kcal)} kcal</dd>
        <dt class="text-(--color-ink-muted)">Białko</dt>
        <dd class="font-medium tabular-nums">{eaten.protein.toFixed(1)} g</dd>
        <dt class="text-(--color-ink-muted)">Węglowodany</dt>
        <dd class="font-medium tabular-nums">{eaten.carbs.toFixed(1)} g</dd>
        <dt class="text-(--color-ink-muted)">Tłuszcz</dt>
        <dd class="font-medium tabular-nums">{eaten.fat.toFixed(1)} g</dd>
      </dl>

      <p class="pt-2 text-xs text-(--color-ink-muted)">
        1 porcja = {Math.round(meal.macroSnapshot.kcal)} kcal, zapisane przy planowaniu.
      </p>

      {#if drifted && currentPortion !== undefined}
        <p class="pt-2 text-xs text-(--color-warn)">
          Przepis zmienił się od zaplanowania — dziś wyszłoby {Math.round(currentPortion.kcal)} kcal
          na porcję. Ten posiłek zachowuje wartości z dnia zaplanowania.
        </p>
      {/if}
    </section>

    {#if recipe !== undefined && recipe.items.length > 0}
      <details class="mt-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
        <summary class="cursor-pointer text-sm font-semibold">
          Makroskładniki składnik po składniku
        </summary>
        <p class="pt-1 text-xs text-(--color-ink-muted)">
          Wartości dla 1 porcji, wyliczone z aktualnego przepisu.
        </p>
        <ul class="flex flex-col gap-1 pt-2">
          {#each recipe.items as item, index (index)}
            {@const ingredient = lookup(item.ingredientId)}
            {@const macros = itemMacros(item, ingredient)}
            <li class="flex items-baseline justify-between gap-3 text-xs">
              <span class="min-w-0 truncate">{ingredient?.name ?? 'Nieznany składnik'}</span>
              <span class="shrink-0 tabular-nums text-(--color-ink-muted)">
                {Math.round(macros.kcal)} kcal · B {macros.protein.toFixed(1)} · W
                {macros.carbs.toFixed(1)} · T {macros.fat.toFixed(1)}
              </span>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
{/if}

<ShoppingListSheet
  open={shoppingOpen}
  title="Lista zakupów — {recipe?.name ?? 'posiłek'}, {formatDayMonth(date)}"
  dates={[date]}
  {mealId}
  onclose={() => (shoppingOpen = false)}
/>

<ConfirmDialog
  open={uncheckOpen}
  title="Usunąć jutrzejszy posiłek?"
  confirmLabel="Usuń z jutra"
  cancelLabel="Zostaw"
  danger
  onconfirm={() => void undoTomorrow()}
  oncancel={() => (uncheckOpen = false)}
>
  {#if tomorrowMeals.length > 1}
    Jutro są {tomorrowMeals.length} posiłki z tego przepisu — usuniemy ostatni z nich.
  {:else}
    Usuniemy posiłek z tego przepisu zaplanowany na {formatDayLong(tomorrow)}.
  {/if}
  {#if scale === 2}
    Liczba porcji do ugotowania wróci do 1.
  {/if}
</ConfirmDialog>
