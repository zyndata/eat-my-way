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
  import type { MealGroup, MealPlacement } from '../day';
  import { mealMacros } from '../macros';
  import MealCard from './MealCard.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * The day's meals, grouped by the category each one names and reorderable inside and between
   * those groups (PLAN.md Phase 24 task 4).
   *
   * Groups are a **rendering** of `day.meals`, never a second ordering (STATE.md decision 442):
   * the zones are drawn in template order with „Pozostałe" last, and one write hands back every
   * meal in exactly that order, with the category it now sits in. Dragging a card into another
   * group is what changes its category (decision 443).
   *
   * `dragHandleZone` rather than `dndzone`: a drag can only start on a card's handle, so a
   * touch anywhere else on the list scrolls it (decision 69). `delayTouchStart` guards the
   * handle itself against an accidental press while scrolling. Every zone shares one `type`,
   * which is what lets a card cross between them.
   *
   * The write travels as ids and strings, never as the objects the library hands back — those
   * came out of `$state` and are proxies that IndexedDB refuses to clone (decisions 56 and 77).
   */

  const FLIP_MS = 180;
  const TOUCH_DELAY_MS = 200;
  /** One drag type for every category, so a card can be dropped into any of them. */
  const ZONE_TYPE = 'emw-meal';
  const PLUS = 'M12 5v14M5 12h14';

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
    groups,
    date,
    nameOf,
    onplace,
    onadd,
    onportions,
    onduplicate,
    oncopy,
    onremove
  }: {
    /** The day's meals as the screen draws them — `groupMeals`, template order, rest last. */
    groups: readonly MealGroup[];
    date: string;
    /** Recipe name for a meal, already resolved by the day screen. */
    nameOf: (meal: PlannedMeal) => { name: string; missing: boolean };
    onplace: (placements: MealPlacement[]) => void;
    /** „+ Dodaj" under a heading: the picker opens knowing where the meal goes. */
    onadd: (slotId: string | undefined) => void;
    onportions: (mealId: string) => void;
    onduplicate: (mealId: string) => void;
    oncopy: (mealId: string) => void;
    onremove: (mealId: string) => void;
  } = $props();

  /** One zone per group: what the drag library owns while a drag is in flight. */
  type Zone = { key: string; slotId?: string; label: string; items: PlannedMeal[] };

  let zones = $state<Zone[]>([]);

  // Re-seeded whenever the day is re-read, which is what puts the persisted placement back on
  // screen. „Pozostałe" has no slot id, so its key is a name no category can collide with.
  $effect(() => {
    zones = groups.map((group) => ({
      key: group.slot?.id ?? '',
      ...(group.slot === undefined ? {} : { slotId: group.slot.id }),
      label: group.label,
      items: group.meals.map((meal) => ({ ...meal }))
    }));
  });

  /** During a drag the library inserts its own placeholder; it is not a real meal. */
  const isPlaceholder = (meal: PlannedMeal): boolean => meal.id === SHADOW_PLACEHOLDER_ITEM_ID;

  function update(key: string, items: PlannedMeal[]): void {
    zones = zones.map((zone) => (zone.key === key ? { ...zone, items } : zone));
  }

  /**
   * A drag between two groups finalizes **both** of them, one after the other in the same
   * task: the zone the card left, then the zone it landed in. Writing on each would be two
   * writes for one move — and the first of them would describe a day the card has left and not
   * yet arrived on. So the zones are updated as the events come and the write is flushed once,
   * after both have been seen.
   */
  let flush: ReturnType<typeof setTimeout> | undefined;

  function finalize(key: string, items: PlannedMeal[]): void {
    update(key, items);
    if (flush !== undefined) clearTimeout(flush);
    flush = setTimeout(() => {
      flush = undefined;
      onplace(
        zones.flatMap((zone) =>
          zone.items
            .filter((meal) => !isPlaceholder(meal))
            .map((meal) => ({ id: meal.id, ...(zone.slotId === undefined ? {} : { slotId: zone.slotId }) }))
        )
      );
    }, 0);
  }

  /** What the heading says the category comes to. Rounded once, as every other kcal is. */
  function groupKcal(items: readonly PlannedMeal[]): number {
    return Math.round(
      items
        .filter((meal) => !isPlaceholder(meal))
        .reduce((sum, meal) => sum + mealMacros(meal).kcal, 0)
    );
  }
</script>

<section class="flex flex-col gap-4" aria-label="Posiłki dnia">
  {#each zones as zone (zone.key)}
    <section aria-label={zone.label}>
      <div class="flex items-baseline justify-between gap-2 pb-1.5">
        <h2 class="min-w-0 truncate text-sm font-semibold">{zone.label}</h2>
        <div class="flex shrink-0 items-baseline gap-2">
          {#if zone.items.length > 0}
            <span class="text-xs text-(--color-ink-muted) tabular-nums">
              {groupKcal(zone.items)} kcal
            </span>
          {/if}
          <button
            type="button"
            class="emw-press emw-btn-chip emw-tint border border-(--color-border) px-2 py-0.5 text-xs font-medium text-(--color-accent)"
            aria-label="Dodaj do: {zone.label}"
            onclick={() => onadd(zone.slotId)}
          >
            <NavIcon path={PLUS} class="size-3.5" />
            Dodaj
          </button>
        </div>
      </div>

      <!-- An empty category is a heading and a dashed drop target, so a day with three
           categories planned still shows the two that are not. -->
      <ul
        class="flex flex-col gap-2 {zone.items.length === 0
          ? 'min-h-12 rounded-xl border border-dashed border-(--color-border)'
          : ''}"
        aria-label="Posiłki: {zone.label}"
        use:dragHandleZone={{
          items: zone.items,
          type: ZONE_TYPE,
          flipDurationMs: FLIP_MS,
          delayTouchStart: TOUCH_DELAY_MS,
          // Highlighting is a class, never an inline style — see STATE.md decision 71.
          dropTargetStyle: {},
          dropTargetClasses: ['rounded-2xl', 'outline-2', 'outline-dashed', 'outline-(--color-accent)']
        }}
        onconsider={(event: CustomEvent<DndEvent<PlannedMeal>>) =>
          update(zone.key, event.detail.items)}
        onfinalize={(event: CustomEvent<DndEvent<PlannedMeal>>) =>
          finalize(zone.key, event.detail.items)}
      >
        {#each zone.items as meal (meal.id)}
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
                onportions={() => onportions(meal.id)}
                onduplicate={() => onduplicate(meal.id)}
                oncopy={() => oncopy(meal.id)}
                onremove={() => onremove(meal.id)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</section>
