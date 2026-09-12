<script lang="ts">
  import type { Macros, PlannedMeal, Recipe } from '../types';
  import type { MenuDay } from '../menu';
  import { formatMenu, formatMenuTotals, menuDays } from '../menu';
  import { formatDayLong } from '../dates';
  import { formatPortions } from '../text';
  import { repository } from '../repository';
  import { shareText, type ShareOutcome } from '../share';
  import BottomSheet from './BottomSheet.svelte';

  /**
   * „Jadłospis" (PLAN.md Phase 18 task C): the planned meals of a range of days as text, out
   * of the app through the share sheet or the clipboard.
   *
   * Deliberately the shopping list's twin — same scopes, same sheet, same two ways out, same
   * fallback of leaving the text on screen when neither works. What differs is what it carries:
   * meals, portions and each day's totals against its goals, and **no ingredients at all**
   * (STATE.md decision 334).
   *
   * Neither route is a network request, so the CSP is untouched (decision 144).
   */

  let {
    open = false,
    title,
    dates,
    onclose
  }: {
    open?: boolean;
    /** Polish heading, and the first line of the shared text. */
    title: string;
    /** Days the menu covers, in order. */
    dates: readonly string[];
    onclose: () => void;
  } = $props();

  let loading = $state(false);
  let days = $state<MenuDay[]>([]);
  let outcome = $state<ShareOutcome | null>(null);

  const text = $derived(formatMenu(title, days));
  const planned = $derived(days.some((day) => day.meals.length > 0));

  async function load(): Promise<void> {
    loading = true;
    outcome = null;

    const from = dates[0] ?? '';
    const to = dates[dates.length - 1] ?? from;
    const wanted = new Set(dates);
    const rows = (await repository.getDays(from, to)).filter((day) => wanted.has(day.date));

    const recipes: Map<string, Recipe> = await repository.recipesByIds(
      rows.flatMap((day) => day.meals.map((meal) => meal.recipeId))
    );
    // A meal outlives the recipe it came from — the day still counted, so it is still on the
    // menu, under the same words the day view uses (STATE.md decisions 51 and 73).
    const nameOf = (meal: PlannedMeal): string =>
      recipes.get(meal.recipeId)?.name ?? 'Usunięty przepis';

    // Only the fallback for a day that never froze goals of its own — `menuDays` prefers the
    // day's `goalSnapshot` wherever there is one (decision 75).
    const goals: Macros = (await repository.getProfile()).goals;

    days = menuDays(dates, rows, goals, nameOf);
    loading = false;
  }

  $effect(() => {
    if (!open) return;
    void load();
  });

  async function share(): Promise<void> {
    outcome = await shareText(title, text);
  }
</script>

<BottomSheet {open} title="Jadłospis" {onclose}>
  <p class="text-sm text-(--color-ink-muted)">{title}</p>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Posiłki i podsumowanie dnia. Składniki są na liście zakupów.
  </p>

  {#if loading}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if !planned}
    <p class="pt-4 text-sm text-(--color-ink-muted)">
      W tym zakresie nie ma nic zaplanowanego.
    </p>
  {:else}
    {#each days as day (day.date)}
      <h3 class="pt-4 text-xs font-semibold tracking-wide text-(--color-ink-muted) uppercase">
        {formatDayLong(day.date)}
      </h3>
      {#if day.meals.length === 0}
        <p class="pt-1 text-sm text-(--color-ink-muted)">Nic nie zaplanowano.</p>
      {:else}
        <ul class="flex flex-col gap-1 pt-1">
          {#each day.meals as meal, index (index)}
            <li
              class="rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-sm"
            >
              {meal.name} — {formatPortions(meal.portionsEaten)}
            </li>
          {/each}
        </ul>
        <p class="pt-1 text-xs text-(--color-ink-muted)">
          {formatMenuTotals(day.totals, day.goals)}
        </p>
      {/if}
    {/each}

    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink)"
        onclick={() => void share()}
      >
        Udostępnij jadłospis
      </button>
      {#if outcome === 'copied'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Skopiowano do schowka.</span>
      {:else if outcome === 'shared'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Udostępniono.</span>
      {:else if outcome === 'failed'}
        <span class="text-sm text-(--color-warn)" role="status">
          Nie udało się udostępnić ani skopiować — zaznacz jadłospis powyżej i skopiuj ręcznie.
        </span>
      {/if}
    </div>
  {/if}
</BottomSheet>
