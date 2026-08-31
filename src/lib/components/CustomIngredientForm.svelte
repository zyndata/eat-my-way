<script lang="ts">
  import type { Ingredient, IngredientState } from '../types';
  import { newCustomIngredientId } from '../ids';

  /**
   * Creates a `custom:*` ingredient when the bundled USDA subset has no match. Values are
   * per 100 g, like every other ingredient in the database (STATE.md decision 53). The form
   * only *builds* the ingredient — the editor persists it and invalidates the search index.
   */

  let {
    initialName = '',
    onsave,
    oncancel
  }: {
    initialName?: string;
    onsave: (ingredient: Ingredient) => void;
    oncancel: () => void;
  } = $props();

  // The form is created fresh for each row, so seeding from the prop once is the point.
  // svelte-ignore state_referenced_locally
  let name = $state(initialName);
  let form = $state<IngredientState>('raw');
  let kcal = $state<number | null>(null);
  let protein = $state<number | null>(null);
  let carbs = $state<number | null>(null);
  let fat = $state<number | null>(null);

  const canSave = $derived(name.trim() !== '');

  function value(input: number | null): number {
    return input !== null && Number.isFinite(input) ? Math.max(0, input) : 0;
  }

  function save(): void {
    if (!canSave) return;
    onsave({
      id: newCustomIngredientId(),
      name: name.trim(),
      aliases: [],
      state: form,
      per100g: {
        kcal: value(kcal),
        protein: value(protein),
        carbs: value(carbs),
        fat: value(fat)
      },
      source: 'custom'
    });
  }
</script>

<div id="custom-ingredient-form" class="rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
  <h3 class="text-sm font-semibold">Nowy własny składnik</h3>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Wartości podaj na 100 g. Składnik zostanie zapisany lokalnie i będzie dostępny w innych
    przepisach.
  </p>

  <div class="grid gap-3 pt-3 sm:grid-cols-2">
    <label class="block text-sm font-medium">
      Nazwa
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="text"
        bind:value={name}
      />
    </label>

    <label class="block text-sm font-medium">
      Postać
      <select
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        bind:value={form}
      >
        <option value="raw">surowy</option>
        <option value="cooked">po ugotowaniu</option>
      </select>
    </label>
  </div>

  <div class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
    <label class="block text-sm font-medium">
      kcal
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={kcal}
      />
    </label>
    <label class="block text-sm font-medium">
      Białko (g)
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={protein}
      />
    </label>
    <label class="block text-sm font-medium">
      Węgl. (g)
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={carbs}
      />
    </label>
    <label class="block text-sm font-medium">
      Tłuszcz (g)
      <input
        class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={fat}
      />
    </label>
  </div>

  <div class="flex flex-wrap gap-2 pt-4">
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
      disabled={!canSave}
      onclick={save}
    >
      Zapisz składnik
    </button>
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      Anuluj
    </button>
  </div>
</div>
