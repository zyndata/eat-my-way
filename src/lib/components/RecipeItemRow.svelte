<script lang="ts">
  import type { Ingredient } from '../types';
  import type { DraftItem } from '../recipes';
  import { isDraftComplete, overrideSeed, toRecipeItem } from '../recipes';
  import { itemGrams, itemMacros } from '../macros';
  import IngredientAutocomplete from './IngredientAutocomplete.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * One ingredient row of the recipe editor. Amounts are always for a single portion.
   *
   * `item` is the parent's `$state` draft object, so writing to its fields here updates the
   * live macro sum without any event plumbing.
   */

  const PENCIL = 'M4 20h4L18 10a2.83 2.83 0 0 0-4-4L4 16v4Zm9.5-13.5 4 4';

  let {
    item,
    position,
    ingredient,
    canRestore,
    restoredName,
    onpick,
    onclear,
    onrestore,
    onremove,
    oncreate
  }: {
    item: DraftItem;
    /** 1-based, for labels and for a unique field id per row. */
    position: number;
    ingredient: Ingredient | undefined;
    /** This row was emptied by „Zmień" and the old ingredient can still be put back. */
    canRestore: boolean;
    /** Name of that ingredient, when it is still in the database. */
    restoredName: string | undefined;
    onpick: (ingredient: Ingredient) => void;
    onclear: () => void;
    onrestore: () => void;
    onremove: () => void;
    oncreate: (query: string) => void;
  } = $props();

  // A recipe loaded with an override already on the row opens with the panel visible.
  // Deliberately the initial value only: later toggling is the user's, not the data's.
  // svelte-ignore state_referenced_locally
  let overrideOpen = $state(item.macroOverride !== null);

  const wire = $derived(toRecipeItem(item));
  const grams = $derived(itemGrams(wire));
  const macros = $derived(itemMacros(wire, ingredient));
  const complete = $derived(isDraftComplete(item));
  const overridden = $derived(item.macroOverride !== null);

  /** The pencil. Opening seeds the fields from the database values, so the user edits a
   * real starting point rather than four zeros. Closing the panel keeps the override — only
   * „Przywróć wartości z bazy" removes it. */
  function toggleOverride(): void {
    if (overrideOpen) {
      overrideOpen = false;
      return;
    }
    if (item.macroOverride === null) item.macroOverride = overrideSeed(ingredient);
    overrideOpen = true;
  }

  function clearOverride(): void {
    item.macroOverride = null;
    overrideOpen = false;
  }
</script>

<div class="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
  {#if item.ingredientId === ''}
    {#if canRestore && restoredName !== undefined}
      <p class="pb-2 text-xs text-(--color-ink-muted)">
        Zmieniasz składnik: <span class="font-medium">{restoredName}</span>
      </p>
    {/if}
    <IngredientAutocomplete
      id="recipe-item-{position}"
      label="Składnik {position}"
      onselect={onpick}
      oncreate={oncreate}
    />
    <div class="flex flex-wrap items-center gap-4 pt-2">
      {#if canRestore}
        <button type="button" class="text-sm text-(--color-accent) underline" onclick={onrestore}>
          Anuluj zmianę
        </button>
      {/if}
      <button type="button" class="text-sm text-(--color-ink-muted) underline" onclick={onremove}>
        Usuń wiersz
      </button>
    </div>
  {:else}
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{ingredient?.name ?? 'Nieznany składnik'}</p>
        <p class="text-xs text-(--color-ink-muted)">
          {#if ingredient}
            {Math.round(ingredient.per100g.kcal)} kcal / 100 g ·
            {ingredient.state === 'cooked' ? 'po ugotowaniu' : 'surowy'}
          {:else}
            Składnik nie istnieje już w bazie.
          {/if}
          {#if overridden}
            · wartości nadpisane ręcznie
          {/if}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="rounded-lg border border-(--color-border) p-2 {overridden ? 'text-(--color-accent)' : 'text-(--color-ink-muted)'}"
          aria-label="Nadpisz makroskładniki na 100 g"
          aria-pressed={overrideOpen}
          onclick={toggleOverride}
        >
          <NavIcon path={PENCIL} class="size-4" />
        </button>
        <button
          type="button"
          class="rounded-lg border border-(--color-border) px-2 py-2 text-sm text-(--color-ink-muted)"
          onclick={onclear}
        >
          Zmień
        </button>
        <button
          type="button"
          class="rounded-lg border border-(--color-border) px-2 py-2 text-sm text-(--color-ink-muted)"
          aria-label="Usuń składnik {ingredient?.name ?? ''}"
          onclick={onremove}
        >
          Usuń
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 pt-3 {item.unit === 'g' ? '' : 'sm:grid-cols-3'}">
      <label class="block text-sm font-medium">
        Ilość
        <input
          id="recipe-item-{position}-amount"
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
          type="number"
          inputmode="decimal"
          min="0"
          step="any"
          bind:value={item.amount}
        />
      </label>

      <label class="block text-sm font-medium">
        Jednostka
        <select
          id="recipe-item-{position}-unit"
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
          bind:value={item.unit}
        >
          <option value="g">g</option>
          <option value="ml">ml</option>
          <option value="szt">szt.</option>
        </select>
      </label>

      {#if item.unit !== 'g'}
        <label class="col-span-2 block text-sm font-medium sm:col-span-1">
          {item.unit === 'szt' ? 'Waga 1 szt. (g)' : 'Gęstość (g/ml)'}
          <input
            id="recipe-item-{position}-grams"
            class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
            type="number"
            inputmode="decimal"
            min="0"
            step="any"
            placeholder={item.unit === 'ml' ? '1' : ''}
            bind:value={item.gramsPerUnit}
          />
        </label>
      {/if}
    </div>

    {#if !complete}
      <p class="pt-2 text-xs text-red-700">
        Podaj wagę 1 szt. — bez niej składnik waży 0 g i nie wnosi makroskładników.
      </p>
    {/if}

    {#if overrideOpen && item.macroOverride !== null}
      <fieldset class="mt-3 rounded-lg border border-(--color-border) p-3">
        <legend class="px-1 text-xs font-medium text-(--color-ink-muted)">
          Własne wartości na 100 g
        </legend>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label class="block text-xs font-medium">
            kcal
            <input
              class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1.5 text-base font-normal outline-none focus:border-(--color-accent)"
              type="number"
              inputmode="decimal"
              min="0"
              step="any"
              bind:value={item.macroOverride.kcal}
            />
          </label>
          <label class="block text-xs font-medium">
            Białko (g)
            <input
              class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1.5 text-base font-normal outline-none focus:border-(--color-accent)"
              type="number"
              inputmode="decimal"
              min="0"
              step="any"
              bind:value={item.macroOverride.protein}
            />
          </label>
          <label class="block text-xs font-medium">
            Węgl. (g)
            <input
              class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1.5 text-base font-normal outline-none focus:border-(--color-accent)"
              type="number"
              inputmode="decimal"
              min="0"
              step="any"
              bind:value={item.macroOverride.carbs}
            />
          </label>
          <label class="block text-xs font-medium">
            Tłuszcz (g)
            <input
              class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1.5 text-base font-normal outline-none focus:border-(--color-accent)"
              type="number"
              inputmode="decimal"
              min="0"
              step="any"
              bind:value={item.macroOverride.fat}
            />
          </label>
        </div>
        <button type="button" class="pt-3 text-sm text-(--color-accent) underline" onclick={clearOverride}>
          Przywróć wartości z bazy
        </button>
      </fieldset>
    {/if}

    <p class="pt-2 text-xs text-(--color-ink-muted)">
      {Math.round(grams)} g · {Math.round(macros.kcal)} kcal · B {macros.protein.toFixed(1)} · W
      {macros.carbs.toFixed(1)} · T {macros.fat.toFixed(1)}
    </p>
  {/if}
</div>
