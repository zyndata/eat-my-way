<script lang="ts">
  import type { Macros } from '../types';
  import { goalRatio, isOverGoal } from '../calendar';

  /**
   * The three protein / carbohydrate / fat bars of the day header. Each bar is an SVG
   * `<rect>` whose `width` is a geometry attribute, not a style — see STATE.md decision 71.
   */

  let { totals, goals }: { totals: Macros; goals: Macros } = $props();

  const rows = $derived([
    { key: 'protein', label: 'Białko', value: totals.protein, goal: goals.protein },
    { key: 'carbs', label: 'Węglowodany', value: totals.carbs, goal: goals.carbs },
    { key: 'fat', label: 'Tłuszcz', value: totals.fat, goal: goals.fat }
  ]);
</script>

<ul class="grid grid-cols-3 gap-3">
  {#each rows as row (row.key)}
    {@const over = isOverGoal(row.value, row.goal)}
    <!-- Two lines, not one. „Węglowodany" and „249/250" together need about 124 px at this
         size and a third of a 400 px screen is 114, so a single row overflowed its column and
         printed over „Tłuszcz" — a flex item does not shrink below its content, and a grid
         track is `auto`-sized. Stacking fits both at any width this app supports, keeps the
         three bars on one baseline, and costs one line of height per day card. Truncating the
         label instead was tried and left „Węglo…", which is not a word. -->
    <li class="min-w-0">
      <p class="truncate text-xs text-(--color-ink-muted)">{row.label}</p>
      <p class="text-xs font-medium tabular-nums {over ? 'text-(--color-warn)' : ''}">
        {Math.round(row.value)}/{Math.round(row.goal)}
      </p>
      <svg
        class="mt-1 h-1.5 w-full rounded-full bg-(--color-border) {over
          ? 'text-(--color-warn)'
          : 'text-(--color-accent)'}"
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        role="img"
        aria-label="{row.label}: {Math.round(row.value)} z {Math.round(row.goal)} g"
      >
        <rect x="0" y="0" height="6" width={100 * goalRatio(row.value, row.goal)} fill="currentColor" />
      </svg>
    </li>
  {/each}
</ul>
