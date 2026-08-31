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
    <li>
      <p class="flex items-baseline justify-between gap-1 text-xs">
        <span class="text-(--color-ink-muted)">{row.label}</span>
        <span class="font-medium tabular-nums {over ? 'text-amber-700' : ''}">
          {Math.round(row.value)}/{Math.round(row.goal)}
        </span>
      </p>
      <svg
        class="mt-1 h-1.5 w-full rounded-full bg-(--color-border) {over
          ? 'text-amber-600'
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
