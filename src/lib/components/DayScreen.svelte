<script lang="ts">
  import type { Day, Macros, PlannedMeal, Recipe } from '../types';
  import type { DaySummary } from '../calendar';
  import { isOverGoal, monthWeeks, summarizeDates, weekDates } from '../calendar';
  import { formatDayLong, formatDayMonth, isDateKey, relativeDayLabel } from '../dates';
  import { emptyDay } from '../day';
  import { dayTotals } from '../macros';
  import { repository } from '../repository';
  import { scheduleSync, syncState } from '../sync/state.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import DateMultiSelect from './DateMultiSelect.svelte';
  import MacroBars from './MacroBars.svelte';
  import MealList from './MealList.svelte';
  import MonthGrid from './MonthGrid.svelte';
  import NavIcon from './NavIcon.svelte';
  import RecipePicker from './RecipePicker.svelte';
  import ShoppingListSheet from './ShoppingListSheet.svelte';
  import WeekStrip from './WeekStrip.svelte';

  /**
   * The calendar and day view — one component behind both `/` and `/day/:date`
   * (STATE.md decision 79).
   *
   * Everything is read straight from IndexedDB and re-read after every write, so the week
   * strip, the header and the list can never disagree about what a day holds. The day rows
   * fetched cover the whole month grid around the selected day, which is at most ~42 small
   * rows and means the month toggle needs no second trip.
   */

  const DOTS = 'M12 6h.01M12 12h.01M12 18h.01';
  const PLUS = 'M12 5v14M5 12h14';
  const CALENDAR =
    'M7 3v3M17 3v3M3.5 9.5h17M5 6h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-12A1.5 1.5 0 0 1 5 6Z';

  let { date, today }: { date: string; today: string } = $props();

  let goals = $state<Macros>({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  // Seeded from the route's date; every later value comes from `load`.
  // svelte-ignore state_referenced_locally
  let day = $state<Day>(emptyDay(date));
  let rangeDays = $state<Day[]>([]);
  let recipes = $state(new Map<string, Recipe>());
  let loading = $state(true);

  let monthShown = $state(false);
  // svelte-ignore state_referenced_locally
  let monthAnchor = $state(date);

  let pickerOpen = $state(false);
  /** Meal waiting for „Kopiuj do…"; `null` when the sheet is closed. */
  let copyMealId = $state<string | null>(null);
  let copyDayOpen = $state(false);
  let copyFromOpen = $state(false);
  let clearOpen = $state(false);
  let removeMealId = $state<string | null>(null);
  /** Targets of a day copy that already have meals — the replace/append question. */
  let conflictDates = $state<string[]>([]);
  /** Days the shopping list covers; empty while the sheet is closed (STATE.md decision 158). */
  let shoppingDates = $state<string[]>([]);
  let shoppingTitle = $state('');

  let dayMenu = $state<HTMLDetailsElement>();

  const valid = $derived(isDateKey(date));
  const totals = $derived(dayTotals(day));
  const week = $derived<DaySummary[]>(summarizeDates(weekDates(date), rangeDays, goals));
  const headerGoals = $derived(day.goalSnapshot ?? goals);
  const dayLabel = $derived(relativeDayLabel(date, today));
  const fullDate = $derived(formatDayLong(date));

  function nameOf(meal: PlannedMeal): { name: string; missing: boolean } {
    const recipe = recipes.get(meal.recipeId);
    // A meal outlives the recipe it came from — STATE.md decisions 51 and 73.
    return recipe === undefined
      ? { name: 'Usunięty przepis', missing: true }
      : { name: recipe.name, missing: false };
  }

  async function load(target: string, anchor: string, withMonth: boolean): Promise<void> {
    if (!isDateKey(target)) {
      loading = false;
      return;
    }
    loading = true;

    const grid = monthWeeks(target);
    const dates = withMonth ? [...grid.flat(), ...monthWeeks(anchor).flat()].sort() : grid.flat();
    const from = dates[0] ?? target;
    const to = dates[dates.length - 1] ?? target;

    const [profile, days, current] = await Promise.all([
      repository.getProfile(),
      repository.getDays(from, to),
      repository.getDay(target)
    ]);

    goals = profile.goals;
    rangeDays = days;
    day = current;
    recipes = await repository.recipesByIds(current.meals.map((meal) => meal.recipeId));
    loading = false;
  }

  // The date, the month being browsed — and a sync that brought something in. Without the
  // last one, a day planned on the other device stays invisible for as long as this screen is
  // open, while `startAutoSync` keeps pulling it every few minutes (STATE.md decision 228).
  $effect(() => {
    syncState.dataVersion;
    void load(date, monthAnchor, monthShown);
  });

  /** Every write goes through here, so the strip and the header follow the list. */
  async function refresh(): Promise<void> {
    await load(date, monthAnchor, monthShown);
    // Debounced, and silent unless it fails — see `sync/state.svelte.ts`.
    scheduleSync();
  }

  /** „Lista zakupów" for this day or for its whole week. */
  function openShopping(scope: 'day' | 'week'): void {
    closeMenu();
    const dates = scope === 'day' ? [date] : weekDates(date);
    shoppingTitle =
      scope === 'day'
        ? `Lista zakupów — ${formatDayLong(date)}`
        : `Lista zakupów — tydzień ${formatDayMonth(dates[0] ?? date)} – ${formatDayMonth(dates[dates.length - 1] ?? date)}`;
    shoppingDates = dates;
  }

  function closeMenu(): void {
    if (dayMenu !== undefined) dayMenu.open = false;
  }

  async function addRecipe(recipeId: string): Promise<void> {
    pickerOpen = false;
    await repository.addRecipeToDay(date, recipeId);
    await refresh();
  }

  async function reorder(mealIds: string[]): Promise<void> {
    await repository.setMealOrder(date, mealIds);
    await refresh();
  }

  async function duplicate(mealId: string): Promise<void> {
    await repository.duplicateMeal(date, mealId);
    await refresh();
  }

  async function removeMeal(): Promise<void> {
    const mealId = removeMealId;
    removeMealId = null;
    if (mealId === null) return;
    await repository.removeMealFromDay(date, mealId);
    await refresh();
  }

  async function copyMeal(targets: string[]): Promise<void> {
    const mealId = copyMealId;
    copyMealId = null;
    if (mealId === null) return;
    await repository.copyMealToDays(date, mealId, targets);
    await refresh();
  }

  /**
   * „Kopiuj dzień do…". The replace/append question is only asked when at least one target
   * already has meals — otherwise both answers do the same thing (STATE.md decision 78).
   */
  async function copyDay(targets: string[]): Promise<void> {
    copyDayOpen = false;
    const existing = await repository.getDays(targets[0] ?? date, targets[targets.length - 1] ?? date);
    const busy = targets.filter((target) =>
      existing.some((row) => row.date === target && row.meals.length > 0)
    );

    if (busy.length > 0) {
      conflictDates = targets;
      return;
    }
    await repository.copyDay(date, targets, 'append');
    await refresh();
  }

  async function resolveConflict(mode: 'append' | 'replace'): Promise<void> {
    const targets = conflictDates;
    conflictDates = [];
    await repository.copyDay(date, targets, mode);
    await refresh();
  }

  /** The empty-day hint runs the copy the other way round: this day is the target. */
  async function copyFrom(sources: string[]): Promise<void> {
    copyFromOpen = false;
    const source = sources[0];
    if (source === undefined) return;
    await repository.copyDay(source, [date], 'append');
    await refresh();
  }

  async function clearDay(): Promise<void> {
    clearOpen = false;
    await repository.clearDay(date);
    await refresh();
  }
</script>

{#if !valid}
  <section>
    <h1 class="text-2xl font-semibold tracking-tight">Nie ma takiej daty</h1>
    <p class="pt-2 text-sm text-(--color-ink-muted)">
      „{date}” nie wygląda na dzień kalendarza.
      <a class="font-medium text-(--color-accent) underline" href="#/">Wróć do dzisiaj</a>.
    </p>
  </section>
{:else}
  <WeekStrip summaries={week} selected={date} {today} />

  <div class="flex justify-center pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-(--color-ink-muted)"
      aria-expanded={monthShown}
      onclick={() => {
        monthAnchor = date;
        monthShown = !monthShown;
      }}
    >
      <NavIcon path={CALENDAR} class="size-4" />
      {monthShown ? 'Ukryj miesiąc' : 'Pokaż miesiąc'}
    </button>
  </div>

  {#if monthShown}
    <div class="pt-2">
      <MonthGrid
        anchor={monthAnchor}
        days={rangeDays}
        {goals}
        selected={date}
        {today}
        onmonthchange={(next) => (monthAnchor = next)}
      />
    </div>
  {/if}

  <header class="sticky top-0 z-10 -mx-4 mt-3 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
    <div class="flex items-baseline justify-between gap-2">
      <div class="min-w-0">
        <h1 class="truncate text-lg font-semibold first-letter:uppercase">{dayLabel}</h1>
        {#if dayLabel !== fullDate}
          <!-- „Dziś" needs the date spelled out under it; „poniedziałek, 5 października"
               is already the date and must not be printed twice. -->
          <p class="text-xs text-(--color-ink-muted)">{fullDate}</p>
        {/if}
      </div>

      <p class="shrink-0 text-right">
        <span
          class="text-lg font-semibold tabular-nums {isOverGoal(totals.kcal, headerGoals.kcal)
            ? 'text-(--color-warn)'
            : ''}"
        >
          {Math.round(totals.kcal)}
        </span>
        <span class="text-sm text-(--color-ink-muted) tabular-nums">
          / {Math.round(headerGoals.kcal)} kcal
        </span>
      </p>

      <details class="relative shrink-0" bind:this={dayMenu}>
        <summary
          class="cursor-pointer list-none rounded-lg p-2 text-(--color-ink-muted) [&::-webkit-details-marker]:hidden"
          aria-label="Menu dnia"
        >
          <NavIcon path={DOTS} class="size-5" />
        </summary>
        <div
          class="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-1 shadow-lg"
        >
          <button
            type="button"
            class="block w-full rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => {
              closeMenu();
              copyDayOpen = true;
            }}
          >
            Kopiuj dzień do…
          </button>
          <button
            type="button"
            class="block w-full rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => {
              closeMenu();
              copyFromOpen = true;
            }}
          >
            Skopiuj z innego dnia
          </button>
          <button
            type="button"
            class="block w-full rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => openShopping('day')}
          >
            Lista zakupów — dzień
          </button>
          <button
            type="button"
            class="block w-full rounded-lg px-3 py-2 text-left text-sm"
            onclick={() => openShopping('week')}
          >
            Lista zakupów — tydzień
          </button>
          <button
            type="button"
            class="block w-full rounded-lg px-3 py-2 text-left text-sm text-(--color-danger) disabled:opacity-40"
            disabled={day.meals.length === 0}
            onclick={() => {
              closeMenu();
              clearOpen = true;
            }}
          >
            Wyczyść dzień
          </button>
        </div>
      </details>
    </div>

    <div class="pt-2">
      <MacroBars {totals} goals={headerGoals} />
    </div>
  </header>

  <div class="pt-4">
    {#if loading}
      <p class="text-sm text-(--color-ink-muted)">Wczytywanie…</p>
    {:else if day.meals.length === 0}
      <div class="rounded-xl border border-dashed border-(--color-border) p-6 text-center">
        <p class="text-sm text-(--color-ink-muted)">Nic jeszcze nie zaplanowano na ten dzień.</p>
        <div class="flex flex-wrap justify-center gap-2 pt-3">
          <button
            type="button"
            class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink)"
            onclick={() => (pickerOpen = true)}
          >
            Dodaj posiłek
          </button>
          <button
            type="button"
            class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium"
            onclick={() => (copyFromOpen = true)}
          >
            Skopiuj z innego dnia
          </button>
        </div>
      </div>
    {:else}
      <MealList
        meals={day.meals}
        {date}
        {nameOf}
        onreorder={(ids) => void reorder(ids)}
        onduplicate={(id) => void duplicate(id)}
        oncopy={(id) => (copyMealId = id)}
        onremove={(id) => (removeMealId = id)}
      />

      {#if day.goalSnapshot !== undefined}
        <p class="pt-3 text-xs text-(--color-ink-muted)">
          Cele tego dnia zapisano przy pierwszym posiłku i późniejsze zmiany w ustawieniach ich
          nie ruszają.
        </p>
      {/if}
    {/if}
  </div>

  <button
    type="button"
    class="fixed right-4 bottom-20 z-20 flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-3 text-sm font-medium text-(--color-accent-ink) shadow-lg md:bottom-6"
    onclick={() => (pickerOpen = true)}
  >
    <NavIcon path={PLUS} class="size-5" />
    Dodaj posiłek
  </button>

  <RecipePicker
    open={pickerOpen}
    {totals}
    goals={headerGoals}
    onpick={(recipeId) => void addRecipe(recipeId)}
    onclose={() => (pickerOpen = false)}
  />

  <ShoppingListSheet
    open={shoppingDates.length > 0}
    title={shoppingTitle}
    dates={shoppingDates}
    onclose={() => (shoppingDates = [])}
  />

  <DateMultiSelect
    open={copyMealId !== null}
    title="Kopiuj posiłek do…"
    source={date}
    {today}
    onconfirm={(dates) => void copyMeal(dates)}
    oncancel={() => (copyMealId = null)}
  />

  <DateMultiSelect
    open={copyDayOpen}
    title="Kopiuj dzień do…"
    source={date}
    {today}
    onconfirm={(dates) => void copyDay(dates)}
    oncancel={() => (copyDayOpen = false)}
  />

  <DateMultiSelect
    open={copyFromOpen}
    title="Skopiuj z innego dnia"
    confirmLabel="Skopiuj tutaj"
    single
    source={date}
    {today}
    onconfirm={(dates) => void copyFrom(dates)}
    oncancel={() => (copyFromOpen = false)}
  />

  <BottomSheet
    open={conflictDates.length > 0}
    title="Te dni już mają posiłki"
    onclose={() => (conflictDates = [])}
  >
    <p class="text-sm text-(--color-ink-muted)">
      Dopisać posiłki do tego, co już tam jest, czy zastąpić zawartość tych dni?
    </p>
    <div class="flex flex-wrap justify-end gap-2 pt-4">
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        onclick={() => (conflictDates = [])}
      >
        Anuluj
      </button>
      <button
        type="button"
        class="rounded-lg border border-(--color-danger-border) px-3 py-2 text-sm font-medium text-(--color-danger)"
        onclick={() => void resolveConflict('replace')}
      >
        Zastąp
      </button>
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink)"
        onclick={() => void resolveConflict('append')}
      >
        Dopisz
      </button>
    </div>
  </BottomSheet>

  <ConfirmDialog
    open={clearOpen}
    title="Wyczyścić ten dzień?"
    confirmLabel="Wyczyść"
    danger
    onconfirm={() => void clearDay()}
    oncancel={() => (clearOpen = false)}
  >
    Usuniemy wszystkie posiłki z dnia {formatDayLong(date)}. Przepisy zostaną nietknięte.
  </ConfirmDialog>

  <ConfirmDialog
    open={removeMealId !== null}
    title="Usunąć posiłek?"
    confirmLabel="Usuń"
    danger
    onconfirm={() => void removeMeal()}
    oncancel={() => (removeMealId = null)}
  >
    Posiłek zniknie z tego dnia. Przepis zostanie w bibliotece.
  </ConfirmDialog>
{/if}
