<script lang="ts">
  import { flip } from 'svelte/animate';
  import {
    SHADOW_PLACEHOLDER_ITEM_ID,
    dragHandleZone,
    setAriaStrings,
    setKeyboardDragTrigger,
    type DndEvent
  } from 'svelte-dnd-action';
  import type { PlannedMeal } from '../types';
  import MealCard from './MealCard.svelte';

  /**
   * The day's meals, reorderable. Array order IS the display order (PLAN.md), so a drag ends
   * in one call that hands the repository the new order.
   *
   * `dragHandleZone` rather than `dndzone`: a drag can only start on a card's handle, so a
   * touch anywhere else on the list scrolls it (STATE.md decision 69). `delayTouchStart`
   * guards the handle itself against an accidental press while scrolling.
   *
   * The reorder travels as ids, never as the objects the library hands back — those came out
   * of `$state` and are proxies that IndexedDB refuses to clone (decisions 56 and 77).
   */

  const FLIP_MS = 180;
  const TOUCH_DELAY_MS = 200;

  // Global, and set once: the library speaks to screen readers, and this app speaks Polish.
  setAriaStrings({
    dragStarted: ({ itemLabel, position, count }) =>
      `Przenoszenie: ${itemLabel}. Pozycja ${position} z ${count}. Strzałkami zmień kolejność, spacją upuść, klawiszem Escape anuluj.`,
    movedToPosition: ({ itemLabel, position, count }) =>
      `${itemLabel} na pozycji ${position} z ${count}.`,
    movedToZoneStart: ({ itemLabel }) => `${itemLabel} na początku listy.`,
    movedToZoneEnd: ({ itemLabel }) => `${itemLabel} na końcu listy.`,
    dropped: ({ itemLabel, position, count }) =>
      `Upuszczono ${itemLabel} na pozycji ${position} z ${count}.`,
    zoneActiveInstruction: 'Lista posiłków. Naciśnij spację na uchwycie, aby zmienić kolejność.',
    zoneDragDisabledInstruction: 'Zmiana kolejności jest teraz niedostępna.'
  });
  // Enter stays free, so it still opens the focused meal.
  setKeyboardDragTrigger('space');

  let {
    meals,
    date,
    nameOf,
    onreorder,
    onduplicate,
    oncopy,
    onremove
  }: {
    meals: readonly PlannedMeal[];
    date: string;
    /** Recipe name for a meal, already resolved by the day screen. */
    nameOf: (meal: PlannedMeal) => { name: string; missing: boolean };
    onreorder: (mealIds: string[]) => void;
    onduplicate: (mealId: string) => void;
    oncopy: (mealId: string) => void;
    onremove: (mealId: string) => void;
  } = $props();

  /**
   * The list the drag library owns while a drag is in flight. It is re-seeded whenever the
   * day is re-read, which is what puts the persisted order back on screen.
   */
  let items = $state<PlannedMeal[]>([]);

  $effect(() => {
    items = meals.map((meal) => ({ ...meal }));
  });

  /** During a drag the library inserts its own placeholder; it is not a real meal. */
  const isPlaceholder = (meal: PlannedMeal): boolean => meal.id === SHADOW_PLACEHOLDER_ITEM_ID;

  function consider(event: CustomEvent<DndEvent<PlannedMeal>>): void {
    items = event.detail.items;
  }

  function finalize(event: CustomEvent<DndEvent<PlannedMeal>>): void {
    items = event.detail.items;
    onreorder(items.filter((meal) => !isPlaceholder(meal)).map((meal) => meal.id));
  }
</script>

<ul
  class="flex flex-col gap-2"
  aria-label="Posiłki dnia"
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
  {#each items as meal (meal.id)}
    <li animate:flip={{ duration: FLIP_MS }}>
      {#if isPlaceholder(meal)}
        <div class="h-16 rounded-xl border border-dashed border-(--color-border)"></div>
      {:else}
        {@const resolved = nameOf(meal)}
        <MealCard
          {meal}
          {date}
          name={resolved.name}
          missing={resolved.missing}
          onduplicate={() => onduplicate(meal.id)}
          oncopy={() => oncopy(meal.id)}
          onremove={() => onremove(meal.id)}
        />
      {/if}
    </li>
  {/each}
</ul>
