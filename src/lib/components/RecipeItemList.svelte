<script lang="ts">
  import { flip } from 'svelte/animate';
  import {
    SHADOW_PLACEHOLDER_ITEM_ID,
    dragHandleZone,
    dragHandle,
    type DndEvent
  } from 'svelte-dnd-action';
  import type { Ingredient } from '../types';
  import type { DraftItem } from '../recipes';
  import CustomIngredientForm from './CustomIngredientForm.svelte';
  import NavIcon from './NavIcon.svelte';
  import RecipeItemRow from './RecipeItemRow.svelte';

  /**
   * The recipe editor's ingredient rows, reorderable (PLAN.md Phase 9 task 5).
   *
   * Follows the `reorderMeals` pattern of the day's `MealList`: `dragHandleZone` rather than
   * `dndzone`, so a touch anywhere but the handle scrolls the form instead of dragging a row,
   * and `delayTouchStart` guards the handle itself (STATE.md decision 69). The Polish
   * screen-reader strings are set once, globally, by `MealList`.
   *
   * Unlike the day's list this one reorders in memory only — nothing is written until the
   * recipe is saved, so the parent's draft array *is* the source of truth and is assigned
   * straight back.
   */

  const GRIP = 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01';
  const FLIP_MS = 180;
  const TOUCH_DELAY_MS = 200;

  let {
    items = $bindable(),
    customRowId,
    customName,
    replaced,
    lookup,
    onpick,
    onclear,
    onrestore,
    onremove,
    oncreate,
    oncustomsave,
    oncustomcancel
  }: {
    items: DraftItem[];
    /** Row currently showing the "new ingredient" form instead of its normal contents. */
    customRowId: string | null;
    customName: string;
    /** Ingredient each row held before „Zmień", keyed by row id — what „Anuluj zmianę" restores. */
    replaced: Record<string, string>;
    lookup: (id: string) => Ingredient | undefined;
    onpick: (rowId: string, ingredient: Ingredient) => void;
    onclear: (rowId: string) => void;
    onrestore: (rowId: string) => void;
    onremove: (rowId: string) => void;
    oncreate: (rowId: string, query: string) => void;
    oncustomsave: (rowId: string, ingredient: Ingredient) => void;
    oncustomcancel: () => void;
  } = $props();

  /**
   * The name „Anuluj zmianę" would put back, or `undefined` when the remembered ingredient has
   * since left the database. The button itself follows `replaced`, not this: a row can be
   * restorable without a name to show for it.
   */
  const replacedName = (rowId: string): string | undefined => {
    const previous = replaced[rowId];
    return previous === undefined ? undefined : lookup(previous)?.name;
  };

  /** During a drag the library inserts its own placeholder; it is not a real row. */
  const isPlaceholder = (item: DraftItem): boolean => item.id === SHADOW_PLACEHOLDER_ITEM_ID;

  function consider(event: CustomEvent<DndEvent<DraftItem>>): void {
    items = event.detail.items;
  }

  function finalize(event: CustomEvent<DndEvent<DraftItem>>): void {
    items = event.detail.items.filter((item) => !isPlaceholder(item));
  }
</script>

<ul
  class="flex flex-col gap-3 pt-3"
  aria-label="Składniki przepisu"
  use:dragHandleZone={{
    items,
    flipDurationMs: FLIP_MS,
    delayTouchStart: TOUCH_DELAY_MS,
    // Highlighting is a class, never an inline style — see STATE.md decision 71.
    dropTargetStyle: {},
    dropTargetClasses: ['rounded-2xl', 'outline-2', 'outline-dashed', 'outline-(--color-accent)']
  }}
  onconsider={consider}
  onfinalize={finalize}
>
  {#each items as item, index (item.id)}
    <li animate:flip={{ duration: FLIP_MS }}>
      {#if isPlaceholder(item)}
        <div class="h-24 rounded-xl border border-dashed border-(--color-border)"></div>
      {:else if customRowId === item.id}
        <CustomIngredientForm
          initialName={customName}
          onsave={(ingredient) => oncustomsave(item.id, ingredient)}
          oncancel={oncustomcancel}
        />
      {:else}
        <div class="flex items-stretch gap-2">
          <div
            use:dragHandle
            class="flex shrink-0 cursor-grab items-center rounded-lg px-1 text-(--color-ink-muted)"
            aria-label="Przenieś wiersz {index + 1}"
          >
            <NavIcon path={GRIP} class="size-5" />
          </div>
          <div class="min-w-0 flex-1">
            <RecipeItemRow
              {item}
              position={index + 1}
              ingredient={lookup(item.ingredientId)}
              canRestore={replaced[item.id] !== undefined}
              restoredName={replacedName(item.id)}
              onpick={(ingredient) => onpick(item.id, ingredient)}
              onclear={() => onclear(item.id)}
              onrestore={() => onrestore(item.id)}
              onremove={() => onremove(item.id)}
              oncreate={(query) => oncreate(item.id, query)}
            />
          </div>
        </div>
      {/if}
    </li>
  {/each}
</ul>
