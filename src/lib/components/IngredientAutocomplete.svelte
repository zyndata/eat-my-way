<script lang="ts">
  import type { Ingredient } from '../types';
  import type { IngredientIndex, IngredientMatch } from '../ingredients';
  import { ingredientIndex as defaultIndex } from '../ingredients';
  import { clampActive, keyAction, moveActive } from '../autocomplete';

  /**
   * Ingredient picker. Queries only the local IndexedDB snapshot — no network, ever.
   *
   * ARIA combobox pattern: focus stays in the input, the active option is named through
   * `aria-activedescendant`, and the listbox is reachable by pointer and by touch.
   *
   * Options commit on `click`, and the panel keeps the input focused by cancelling the
   * *mouse* press instead of the pointer press (STATE.md decision 221). Cancelling
   * `pointerdown` — which is what this did — also cancels the touch gesture that grew out
   * of it, so on Android a finger placed on an option to scroll the list selected it
   * instead of scrolling, and on a mouse a press on the panel's own scrollbar landed
   * outside any option, blurred the input and closed the list mid-drag.
   */

  let {
    id = 'ingredient-autocomplete',
    label = 'Składnik',
    placeholder = 'Zacznij pisać, np. „ser zolty”',
    limit = 8,
    index = defaultIndex,
    flow = false,
    onselect,
    oncreate
  }: {
    id?: string;
    label?: string;
    placeholder?: string;
    limit?: number;
    index?: IngredientIndex;
    /**
     * Put the suggestion panel in the flow instead of over the field, and let whatever scrolls
     * around it do the scrolling. An overlay panel is clipped by any scrolling ancestor, and
     * in the „replace this ingredient" sheet that left one suggestion visible through a slot
     * a few pixels tall (STATE.md decision 223).
     */
    flow?: boolean;
    onselect?: (ingredient: Ingredient) => void;
    /**
     * Offered when nothing matches, so a recipe is never blocked by a gap in the bundled
     * catalogue. The recipe editor opens its custom-ingredient form (STATE.md decision 53).
     */
    oncreate?: (query: string) => void;
  } = $props();

  let query = $state('');
  let open = $state(false);
  let active = $state(-1);
  let matches = $state<IngredientMatch[]>([]);
  /** Guards against an older search resolving after a newer one. */
  let searchToken = 0;

  const listboxId = $derived(`${id}-listbox`);
  /** Over the field, capped and scrolling; or in the flow, as tall as it needs to be. */
  const panelPosition = $derived(
    flow ? 'mt-1' : 'absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto overscroll-contain'
  );
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

  /**
   * Keep the caret in the input when the panel is pressed. `mousedown` is the event that
   * moves focus — on touch it arrives only after the gesture has been resolved as a tap,
   * so cancelling it costs scrolling nothing.
   */
  function keepFocus(event: MouseEvent): void {
    event.preventDefault();
  }

  /**
   * In the flow the panel can open below the fold of whatever is scrolling around it, so it
   * asks to be brought into view. `block: 'nearest'` scrolls only when something is actually
   * cut off, and never touches the page when the panel already fits.
   */
  let panel = $state<HTMLElement>();
  $effect(() => {
    if (flow && open && panel !== undefined) panel.scrollIntoView({ block: 'nearest' });
  });

  /** Hover follows the mouse only; on touch the finger is scrolling, not pointing. */
  function onOptionEnter(event: PointerEvent, position: number): void {
    if (event.pointerType === 'mouse') active = position;
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
      bind:this={panel}
      id={listboxId}
      class="{panelPosition} rounded-lg border border-(--color-border) bg-(--color-surface-raised) py-1 shadow-lg"
      role="listbox"
      aria-label={label}
      onmousedown={keepFocus}
    >
      {#each matches as match, position (match.ingredient.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -- combobox options are not focusable; the keyboard drives them from the input -->
        <li
          id={optionId(position)}
          class="cursor-pointer px-3 py-2 {position === active ? 'bg-(--color-accent) text-(--color-accent-ink)' : ''}"
          role="option"
          aria-selected={position === active}
          onclick={() => choose(match)}
          onpointerenter={(event) => onOptionEnter(event, position)}
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
    <!-- svelte-ignore a11y_no_static_element_interactions -- the press is cancelled, never handled -->
    <div
      bind:this={panel}
      class="{flow ? 'mt-1' : 'absolute inset-x-0 top-full z-10 mt-1'} rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 shadow-lg"
      onmousedown={keepFocus}
    >
      <p class="text-sm text-(--color-ink-muted)" role="status">
        Brak składników pasujących do „{query}”.
      </p>
      {#if oncreate}
        <button
          type="button"
          class="mt-2 text-sm font-medium text-(--color-accent) underline"
          onclick={() => oncreate?.(query.trim())}
        >
          Dodaj własny składnik „{query.trim()}”
        </button>
      {/if}
    </div>
  {/if}
</div>
