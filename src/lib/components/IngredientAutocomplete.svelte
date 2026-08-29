<script lang="ts">
  import type { Ingredient } from '../types';
  import type { IngredientIndex, IngredientMatch } from '../ingredients';
  import { ingredientIndex as defaultIndex } from '../ingredients';
  import { clampActive, keyAction, moveActive } from '../autocomplete';

  /**
   * Ingredient picker. Queries only the local IndexedDB snapshot — no network, ever.
   *
   * ARIA combobox pattern: focus stays in the input, the active option is named through
   * `aria-activedescendant`, and the listbox is reachable by pointer and by touch. Options
   * commit on `pointerdown` so a tap lands before the input's blur closes the list.
   */

  let {
    id = 'ingredient-autocomplete',
    label = 'Składnik',
    placeholder = 'Zacznij pisać, np. „ser zolty”',
    limit = 8,
    index = defaultIndex,
    onselect
  }: {
    id?: string;
    label?: string;
    placeholder?: string;
    limit?: number;
    index?: IngredientIndex;
    onselect?: (ingredient: Ingredient) => void;
  } = $props();

  let query = $state('');
  let open = $state(false);
  let active = $state(-1);
  let matches = $state<IngredientMatch[]>([]);
  /** Guards against an older search resolving after a newer one. */
  let searchToken = 0;

  const listboxId = $derived(`${id}-listbox`);
  const optionId = $derived((position: number) => `${id}-option-${position}`);

  async function runSearch(text: string): Promise<void> {
    const token = ++searchToken;
    const found = await index.search(text, limit);
    if (token !== searchToken) return;
    matches = found;
    active = clampActive(active, matches.length);
  }

  function onInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
    open = true;
    active = -1;
    void runSearch(query);
  }

  function choose(match: IngredientMatch | undefined): void {
    if (match === undefined) return;
    query = match.ingredient.name;
    open = false;
    active = -1;
    onselect?.(match.ingredient);
  }

  function onKeydown(event: KeyboardEvent): void {
    const action = keyAction(event.key, open);
    if (action === 'none') return;

    if (action === 'close') {
      // Tab must still move focus; only Escape swallows the key.
      if (event.key === 'Escape') event.preventDefault();
      open = false;
      active = -1;
      return;
    }

    event.preventDefault();

    if (action === 'open') {
      open = true;
      void runSearch(query);
      return;
    }
    if (action === 'select') {
      choose(matches[active]);
      return;
    }
    active = moveActive(active, matches.length, action);
  }

  function onFocus(): void {
    open = true;
    void runSearch(query);
  }
</script>

<div class="relative">
  <label class="block text-sm font-medium" for={id}>{label}</label>

  <!-- svelte-ignore a11y_autocomplete_valid -- 'list' is the ARIA combobox convention here -->
  <input
    {id}
    class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base outline-none focus:border-(--color-accent)"
    type="text"
    role="combobox"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
    {placeholder}
    value={query}
    oninput={onInput}
    onkeydown={onKeydown}
    onfocus={onFocus}
    onblur={() => (open = false)}
  />

  {#if open && matches.length > 0}
    <ul
      id={listboxId}
      class="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-(--color-border) bg-(--color-surface-raised) py-1 shadow-lg"
      role="listbox"
      aria-label={label}
    >
      {#each matches as match, position (match.ingredient.id)}
        <li
          id={optionId(position)}
          class="cursor-pointer px-3 py-2 {position === active ? 'bg-(--color-accent) text-(--color-accent-ink)' : ''}"
          role="option"
          aria-selected={position === active}
          onpointerdown={(event) => {
            event.preventDefault();
            choose(match);
          }}
          onpointerenter={() => (active = position)}
        >
          <span class="block text-sm font-medium">{match.ingredient.name}</span>
          <span
            class="block text-xs {position === active
              ? 'text-(--color-accent-ink)/80'
              : 'text-(--color-ink-muted)'}"
          >
            {Math.round(match.ingredient.per100g.kcal)} kcal / 100 g ·
            {match.ingredient.state === 'cooked' ? 'po ugotowaniu' : 'surowy'}
            {#if match.useCount > 0}
              · używany w {match.useCount}
              {match.useCount === 1 ? 'przepisie' : 'przepisach'}
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {:else if open && query.trim() !== ''}
    <p
      class="absolute inset-x-0 top-full z-10 mt-1 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-sm text-(--color-ink-muted) shadow-lg"
      role="status"
    >
      Brak składników pasujących do „{query}”.
    </p>
  {/if}
</div>
