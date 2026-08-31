<script lang="ts">
  import { dragHandle } from 'svelte-dnd-action';
  import type { PlannedMeal } from '../types';
  import { mealMacros } from '../macros';
  import NavIcon from './NavIcon.svelte';

  /**
   * One planned meal. The card offers its actions two ways (STATE.md decision 72): a
   * swipe-left on touch, and a „⋮" button that works with a mouse or a keyboard. Both reveal
   * the same row, which stays `inert` while hidden so it never takes focus.
   *
   * The swipe never calls `preventDefault`, so scrolling the day vertically over a card is
   * untouched; it only suppresses the click that a horizontal drag on a link would otherwise
   * produce.
   */

  const GRIP = 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01';
  const DOTS = 'M12 6h.01M12 12h.01M12 18h.01';

  /** Minimum horizontal travel that counts as a swipe, and the vertical slack allowed. */
  const SWIPE_MIN_X = 50;
  const SWIPE_MAX_Y = 40;

  let {
    meal,
    date,
    name,
    missing = false,
    onduplicate,
    oncopy,
    onremove
  }: {
    meal: PlannedMeal;
    date: string;
    /** Recipe name, or the „Usunięty przepis" placeholder (decision 73). */
    name: string;
    /** The recipe this meal came from no longer exists. */
    missing?: boolean;
    onduplicate: () => void;
    oncopy: () => void;
    onremove: () => void;
  } = $props();

  let actionsOpen = $state(false);
  let startX = 0;
  let startY = 0;
  /** A finished swipe must not also open the meal. */
  let suppressClick = false;

  const macros = $derived(mealMacros(meal));

  function onTouchStart(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }

  function onTouchEnd(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dy) > SWIPE_MAX_Y || Math.abs(dx) < SWIPE_MIN_X) return;
    actionsOpen = dx < 0;
    suppressClick = true;
  }

  function act(action: () => void): void {
    actionsOpen = false;
    action();
  }
</script>

<div class="relative overflow-hidden rounded-xl border border-(--color-border)">
  <div class="absolute inset-y-0 right-0 flex items-stretch" inert={!actionsOpen}>
    <button
      type="button"
      class="px-3 text-xs font-medium text-(--color-ink-muted)"
      onclick={() => act(onduplicate)}
    >
      Powiel
    </button>
    <button
      type="button"
      class="px-3 text-xs font-medium text-(--color-ink-muted)"
      onclick={() => act(oncopy)}
    >
      Kopiuj do…
    </button>
    <button type="button" class="px-3 text-xs font-medium text-red-700" onclick={() => act(onremove)}>
      Usuń
    </button>
  </div>

  <!--
    The touch handlers only read a gesture; every action they reveal is also on the „⋮"
    button next to them, which is a real button. The container itself is not a control and
    deliberately has no role of its own.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="relative flex items-center gap-1 bg-(--color-surface-raised) p-2 transition-transform duration-200 {actionsOpen
      ? '-translate-x-56'
      : 'translate-x-0'}"
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
  >
    <span
      class="shrink-0 cursor-grab touch-none rounded-lg p-2 text-(--color-ink-muted)"
      use:dragHandle
      aria-label="Przeciągnij, aby zmienić kolejność: {name}"
    >
      <NavIcon path={GRIP} class="size-5" />
    </span>

    <a
      class="min-w-0 flex-1 py-1"
      href="#/day/{date}/{meal.id}"
      onclick={(event) => {
        if (!suppressClick) return;
        event.preventDefault();
        suppressClick = false;
      }}
    >
      <span class="block truncate font-medium {missing ? 'text-(--color-ink-muted) italic' : ''}">
        {name}
      </span>
      <span class="block pt-0.5 text-xs text-(--color-ink-muted)">
        {Math.round(macros.kcal)} kcal · {meal.portionsEaten === 1
          ? '1 porcja'
          : `${meal.portionsEaten} porcji`}
        {#if meal.cookingScale !== 1}
          · gotowane ×{meal.cookingScale}
        {/if}
      </span>
    </a>

    <button
      type="button"
      class="shrink-0 rounded-lg p-2 text-(--color-ink-muted)"
      aria-label="Akcje posiłku: {name}"
      aria-expanded={actionsOpen}
      onclick={() => (actionsOpen = !actionsOpen)}
    >
      <NavIcon path={DOTS} class="size-5" />
    </button>
  </div>
</div>
