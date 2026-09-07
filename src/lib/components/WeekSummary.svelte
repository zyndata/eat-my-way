<script lang="ts">
  import type { DaySummary } from '../calendar';
  import { goalRatio, isOverGoal, summarizeWeekTotals } from '../calendar';
  import { formatDayMonth } from '../dates';

  /**
   * What the seven days above this add up to. The week strip answers „ile w środę"; this
   * answers „ile w tym tygodniu", which is the question a week gets planned against.
   *
   * The bar is the same SVG `<rect>` trick as `MacroBars` — `width` is a geometry attribute,
   * not a style, so the production CSP needs no `style-src` loophole (decision 71).
   */

  let { summaries }: { summaries: readonly DaySummary[] } = $props();

  const week = $derived(summarizeWeekTotals(summaries));
  const first = $derived(summaries[0]?.date);
  const last = $derived(summaries[summaries.length - 1]?.date);
  const over = $derived(isOverGoal(week.totals.kcal, week.goals.kcal));

  /**
   * A week's kcal runs to five digits, where the day header's never does — „14000" is a
   * number you have to count the digits of, „14 000" is not. Polish groups with a space.
   */
  function grouped(value: number): string {
    return Math.round(value).toLocaleString('pl-PL');
  }
</script>

<section
  class="mt-2 rounded-xl border border-(--color-border) bg-(--color-surface-raised) px-3 py-2"
  aria-label="Podsumowanie tygodnia"
>
  <div class="flex items-baseline justify-between gap-2">
    <p class="min-w-0 truncate text-xs font-medium text-(--color-ink-muted)">
      {#if first !== undefined && last !== undefined}
        Tydzień {formatDayMonth(first)} – {formatDayMonth(last)}
      {:else}
        Tydzień
      {/if}
    </p>
    <p class="shrink-0 text-right">
      <span class="text-sm font-semibold tabular-nums {over ? 'text-(--color-warn)' : ''}">
        {grouped(week.totals.kcal)}
      </span>
      <span class="text-xs text-(--color-ink-muted) tabular-nums">
        / {grouped(week.goals.kcal)} kcal
      </span>
    </p>
  </div>

  <svg
    class="mt-1.5 h-1.5 w-full rounded-full bg-(--color-border) {over
      ? 'text-(--color-warn)'
      : 'text-(--color-accent)'}"
    viewBox="0 0 100 6"
    preserveAspectRatio="none"
    role="img"
    aria-label="Tydzień: {grouped(week.totals.kcal)} z {grouped(week.goals.kcal)} kcal"
  >
    <rect
      x="0"
      y="0"
      height="6"
      width={100 * goalRatio(week.totals.kcal, week.goals.kcal)}
      fill="currentColor"
    />
  </svg>

  <p class="pt-1.5 text-xs text-(--color-ink-muted)">
    {#if week.plannedDays === 0}
      Nic jeszcze nie zaplanowano w tym tygodniu.
    {:else}
      <!-- „Zaplanowano 4 z 7 dni" rather than „4 z 7 dni zaplanowanych": after „z 7" Polish
           wants the genitive „dni" whatever the count is, so this phrasing needs no plural
           rule and cannot be got wrong. -->
      Zaplanowano {week.plannedDays} z {week.dayCount} dni · średnio {grouped(week.averageKcal)} kcal
      na dzień
    {/if}
  </p>
</section>
