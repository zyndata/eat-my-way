<script lang="ts">
  import type { DaySummary } from '../calendar';
  import { goalRatio, isOverGoal, isSameMonth, monthWeeks, summarizeDates } from '../calendar';
  import type { Day, Macros } from '../types';
  import {
    addDays,
    dayOfMonth,
    formatDayLong,
    formatMonthYear,
    formatWeekdayShort
  } from '../dates';
  import MacroRing from './MacroRing.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * Month overview — PLAN.md is explicit that this is a toggle for orientation only, so a
   * cell is a link to that day and nothing more. The grid is as tall as the month needs it
   * to be, five rows or six (STATE.md decision 74).
   */

  const CHEVRON_LEFT = 'M15 5l-7 7 7 7';
  const CHEVRON_RIGHT = 'M9 5l7 7-7 7';

  let {
    anchor,
    days,
    goals,
    selected,
    today,
    onmonthchange
  }: {
    /** Any day of the month to show. */
    anchor: string;
    /** Day rows that exist anywhere in the visible grid. */
    days: readonly Day[];
    /** Profile goals, for days with no snapshot of their own. */
    goals: Macros;
    selected: string;
    today: string;
    /** Asked to show the month containing this date instead. */
    onmonthchange: (date: string) => void;
  } = $props();

  const weeks = $derived(monthWeeks(anchor));
  const summaries = $derived(
    new Map<string, DaySummary>(
      summarizeDates(weeks.flat(), days, goals).map((summary) => [summary.date, summary])
    )
  );
  /** Weekday headers, taken from the first row so they follow the same Monday-first order. */
  const weekdays = $derived((weeks[0] ?? []).map(formatWeekdayShort));
</script>

<section class="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
  <header class="flex items-center justify-between gap-2">
    <button
      type="button"
      class="rounded-lg p-2 text-(--color-ink-muted)"
      aria-label="Poprzedni miesiąc"
      onclick={() => onmonthchange(addDays(`${anchor.slice(0, 7)}-01`, -1))}
    >
      <NavIcon path={CHEVRON_LEFT} class="size-5" />
    </button>
    <h2 class="text-sm font-semibold first-letter:uppercase">{formatMonthYear(anchor)}</h2>
    <button
      type="button"
      class="rounded-lg p-2 text-(--color-ink-muted)"
      aria-label="Następny miesiąc"
      onclick={() => onmonthchange(addDays(`${anchor.slice(0, 7)}-01`, 32))}
    >
      <NavIcon path={CHEVRON_RIGHT} class="size-5" />
    </button>
  </header>

  <div class="grid grid-cols-7 gap-1 pt-2 text-center text-xs text-(--color-ink-muted)">
    {#each weekdays as name, index (index)}
      <span>{name}</span>
    {/each}
  </div>

  {#each weeks as week, index (index)}
    <div class="grid grid-cols-7 gap-1 pt-1">
      {#each week as date (date)}
        {@const summary = summaries.get(date)}
        {@const inMonth = isSameMonth(date, anchor)}
        <a
          class="flex justify-center rounded-lg py-1 {date === selected
            ? 'bg-(--color-accent)/10 ring-1 ring-(--color-accent)'
            : ''} {inMonth ? '' : 'opacity-40'}"
          href="#/day/{date}"
          aria-current={date === selected ? 'date' : undefined}
          aria-label="{formatDayLong(date)} — {Math.round(summary?.totals.kcal ?? 0)} kcal"
        >
          <MacroRing
            ratio={goalRatio(summary?.totals.kcal ?? 0, summary?.goals.kcal ?? 0)}
            over={isOverGoal(summary?.totals.kcal ?? 0, summary?.goals.kcal ?? 0)}
          >
            <span class="tabular-nums {date === today ? 'font-bold text-(--color-accent)' : ''}">
              {dayOfMonth(date)}
            </span>
          </MacroRing>
        </a>
      {/each}
    </div>
  {/each}
</section>
