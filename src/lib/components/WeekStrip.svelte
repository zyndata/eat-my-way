<script lang="ts">
  import type { DaySummary } from '../calendar';
  import { goalRatio, isOverGoal } from '../calendar';
  import { addDays, dayOfMonth, formatDayLong, formatWeekdayShort } from '../dates';
  import MacroRing from './MacroRing.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * The week containing the selected day, Monday first, each day showing a kcal ring against
   * that day's goals. Horizontally scrollable on a narrow screen; the arrows step a whole
   * week while keeping the weekday, so „previous week" lands on the same weekday.
   */

  const CHEVRON_LEFT = 'M15 5l-7 7 7 7';
  const CHEVRON_RIGHT = 'M9 5l7 7-7 7';

  let {
    summaries,
    selected,
    today
  }: { summaries: readonly DaySummary[]; selected: string; today: string } = $props();
</script>

<div class="flex items-center gap-1">
  <a
    class="rounded-lg p-2 text-(--color-ink-muted)"
    href="#/day/{addDays(selected, -7)}"
    aria-label="Poprzedni tydzień"
  >
    <NavIcon path={CHEVRON_LEFT} class="size-5" />
  </a>

  <ul class="flex flex-1 gap-1 overflow-x-auto scroll-smooth" aria-label="Tydzień">
    {#each summaries as day (day.date)}
      {@const isSelected = day.date === selected}
      {@const isToday = day.date === today}
      <li class="flex-1">
        <a
          class="flex flex-col items-center gap-1 rounded-xl border px-1 py-2 {isSelected
            ? 'border-(--color-accent) bg-(--color-surface-raised)'
            : 'border-transparent'}"
          href="#/day/{day.date}"
          aria-current={isSelected ? 'date' : undefined}
          aria-label="{formatDayLong(day.date)} — {Math.round(day.totals.kcal)} z {Math.round(
            day.goals.kcal
          )} kcal"
        >
          <span class="text-xs {isToday ? 'font-semibold text-(--color-accent)' : 'text-(--color-ink-muted)'}">
            {formatWeekdayShort(day.date)}
          </span>
          <MacroRing
            ratio={goalRatio(day.totals.kcal, day.goals.kcal)}
            over={isOverGoal(day.totals.kcal, day.goals.kcal)}
          >
            <span class="{isToday ? 'font-bold' : ''} tabular-nums">{dayOfMonth(day.date)}</span>
          </MacroRing>
          <span class="text-[0.65rem] tabular-nums text-(--color-ink-muted)">
            {day.mealCount === 0 ? '—' : Math.round(day.totals.kcal)}
          </span>
        </a>
      </li>
    {/each}
  </ul>

  <a
    class="rounded-lg p-2 text-(--color-ink-muted)"
    href="#/day/{addDays(selected, 7)}"
    aria-label="Następny tydzień"
  >
    <NavIcon path={CHEVRON_RIGHT} class="size-5" />
  </a>
</div>
