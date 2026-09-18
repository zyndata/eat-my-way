<script lang="ts">
  import type { Day, Macros, MealPlanTemplate, PlannedMeal, Recipe } from '../types';
  import type {
    DayPlanOptions,
    PlanDay,
    PlanDayInput,
    PlanProposal,
    PlanRun,
    SkippedRecipes
  } from '../planner';
  import {
    MAX_BATCH_DAYS,
    NO_SKIPPED,
    NO_BALANCE,
    type WeekBalance,
    cookingLabel,
    failureMessage,
    planCandidates,
    planDayInputs,
    planRange,
    planWrites,
    portionLabel,
    resizeRun,
    runsForDates,
    skippedLabel,
    slotTargetKcal,
    templateOf,
    weekBalance
  } from '../planner';
  import { goalRatio, isOverGoal, rangeFrom, weekDates } from '../calendar';
  import {
    addDays,
    formatDayLong,
    formatDayMonth,
    formatWeekdayLong,
    isDateKey,
    relativeDayLabel
  } from '../dates';
  import { UNFILED_LABEL } from '../day';
  import { ingredientLookup } from '../macros';
  import { repository } from '../repository';
  import BottomSheet from './BottomSheet.svelte';
  import MacroBars from './MacroBars.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * The proposal (PLAN.md Phase 13 tasks 6 and 7) — and the reason anyone will use the planner
   * twice. It never writes: „Zastosuj" is the only control that touches IndexedDB, and it goes
   * through `repository.applyPlan`, which is the copy path every other screen already uses.
   *
   * Day mode and week mode are the same component and the same solver call, because they are
   * the same problem over a range of one or seven days. What differs is what the range is, and
   * whether a day can be unticked before applying.
   *
   * Three controls make it a tool rather than a black box: „Losuj ponownie" for everything, a
   * **lock** per proposed cook, and a reroll of one cook that respects every lock. A cook that
   * spans days is one unit here too — one row, one lock, one 1/2/3 control.
   *
   * Since Phase 24 a day card lists the **template's categories**, in order, rather than only
   * the proposal's runs: what is already filed in one, its planuj/pomiń toggle, the kcal it is
   * solved against (editable) and either the proposed cook or „Dołóż tu coś". None of it is
   * remembered — skips, typed kcal and top-ups are sheet state like `locks` and `runLengths`,
   * cleared by `load` and never written to `profile.mealPlan` (STATE.md decision 449).
   */

  const CHEVRON_LEFT = 'M15 5l-7 7 7 7';
  const CHEVRON_RIGHT = 'M9 5l7 7-7 7';
  const LOCK = 'M7 11V8a5 5 0 0 1 10 0v3M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z';
  const UNLOCK = 'M8 11V8a5 5 0 0 1 9.5-2M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z';
  // Was a die, which at 16 px is a square with three specks in it — next to a padlock that
  // reads as an unchecked checkbox. Pips cannot be made to survive that size, so the glyph
  // says the action instead of the metaphor: the same circular arrow „Losuj ponownie" earns.
  const REROLL = 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4';

  let {
    open = false,
    dates,
    today,
    onclose,
    onapplied
  }: {
    open?: boolean;
    /** The range to plan: one date, or the seven of a week. */
    dates: readonly string[];
    today: string;
    onclose: () => void;
    onapplied: () => void;
  } = $props();

  const weekMode = $derived(dates.length > 1);

  /**
   * The first day of the range. A week is seven days from here rather than a fixed
   * Monday-to-Sunday block: „planuję od poniedziałku 7.09" is the normal way to think about
   * a week that has not started yet, and the caller's Monday is only a proposal (decision 294).
   * Day mode has nothing to move — its range is the day the sheet was opened on.
   */
  let start = $state('');
  const range = $derived(
    weekMode && isDateKey(start) ? rangeFrom(start, dates.length) : [...dates]
  );

  let loading = $state(true);
  let applying = $state(false);
  let error = $state('');
  /** Why a click did less than it looked like it would. Cleared by the next solve. */
  let note = $state('');

  let goals = $state<Macros>({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  let template = $state<MealPlanTemplate>(templateOf(undefined));
  let dayRows = $state<Day[]>([]);
  let recipeNames = $state(new Map<string, string>());
  let skipped = $state<SkippedRecipes>(NO_SKIPPED);
  let balance = $state<WeekBalance>(NO_BALANCE);

  let proposal = $state<PlanProposal | null>(null);
  /** The best plan found when nothing fitted — offered anyway, with its difference. */
  let missMessage = $state<{ title: string; detail: string; hint: string } | null>(null);
  let missed = $state(false);

  /** Run ids the user locked. Survives every reroll until the sheet is closed. */
  let locks = $state<string[]>([]);
  /** The sheet's own 1/2/3 control. A one-off — never written back into the template. */
  let runLengths = $state<Record<string, number>>({});
  /** Ticked days. An unticked one is not planned at all — as if it were not in the range. */
  let picked = $state<string[]>([]);
  /** The ticked days in calendar order: what is solved, shown in full, and written. */
  const solveDates = $derived(range.filter((date) => picked.includes(date)));
  /** „Zastąp" — the day is cleared first, so the plan is solved as if it were empty. */
  let replace = $state(false);
  /**
   * What the sheet has been told about each day, keyed by date: categories turned off, ones
   * asked for an extra meal, and kcal typed on one. All three are one-off (decision 449).
   */
  let skips = $state<Record<string, string[]>>({});
  let topUps = $state<Record<string, string[]>>({});
  let typedKcal = $state<Record<string, Record<string, number>>>({});
  /** The per-day inputs of the last solve — what `slotTargetKcal` is shown from. */
  let dayInputs = $state<PlanDayInput[]>([]);

  /** The three, as the solver takes them. */
  const dayOptions = $derived.by<Record<string, DayPlanOptions>>(() => {
    const options: Record<string, DayPlanOptions> = {};
    for (const date of new Set([...Object.keys(skips), ...Object.keys(topUps), ...Object.keys(typedKcal)])) {
      options[date] = {
        ...(skips[date] === undefined ? {} : { skipSlotIds: skips[date] }),
        ...(topUps[date] === undefined ? {} : { topUpSlotIds: topUps[date] }),
        ...(typedKcal[date] === undefined ? {} : { slotKcal: typedKcal[date] })
      };
    }
    return options;
  });

  const candidatesRef: { list: ReturnType<typeof planCandidates>['candidates'] } = { list: [] };

  const busyDates = $derived(
    dayRows.filter((row) => row.meals.length > 0 && solveDates.includes(row.date)).map((row) => row.date)
  );

  const title = $derived(
    weekMode
      ? `Zaplanuj tydzień ${formatDayMonth(range[0] ?? today)} – ${formatDayMonth(range[range.length - 1] ?? today)}`
      : busyDates.length > 0
        ? `Uzupełnij ${relativeDayLabel(range[0] ?? today, today).toLowerCase()}`
        : `Zaplanuj ${relativeDayLabel(range[0] ?? today, today).toLowerCase()}`
  );

  /** Runs keyed by the day they appear on, so a day card can list its slots in order. */
  const runsByDate = $derived.by(() => {
    const map = new Map<string, PlanRun[]>();
    for (const run of proposal?.runs ?? []) {
      for (const date of run.dates) map.set(date, [...(map.get(date) ?? []), run]);
    }
    return map;
  });

  function slotLabel(slotId: string): string {
    return template.slots.find((slot) => slot.id === slotId)?.label ?? slotId;
  }

  function mealsOn(date: string): PlannedMeal[] {
    if (replace) return [];
    return dayRows.find((row) => row.date === date)?.meals ?? [];
  }

  /**
   * Which `load` is the current one. „Pierwszy dzień" changes the range, and the effect below
   * starts a fresh load for it — while the previous one is still reading. Both then wrote their
   * results into the same state, and a run drawn for the week that was being left could arrive
   * after the header had moved: the sheet ended up holding a proposal for one range and a
   * `picked` list for another, said „nie zmieściło się w zaplanowanym zakresie", and dropped
   * the proposal. „Zastosuj" then did nothing at all, silently, because `apply` returns on a
   * null proposal — and the sheet simply sat there.
   *
   * Nothing here was WebKit-specific except the odds: five reads apiece on an engine that
   * charges milliseconds a row is a wide enough window to lose the race every time, where
   * Chromium wins it every time (STATE.md decision 394).
   */
  let loadRun = 0;

  async function load(): Promise<void> {
    const run = ++loadRun;
    /** True once a newer load has started; everything this one read is then out of date. */
    const stale = (): boolean => run !== loadRun;

    loading = true;
    error = '';
    proposal = null;
    locks = [];
    runLengths = {};
    skips = {};
    topUps = {};
    typedKcal = {};
    dayInputs = [];
    replace = false;
    picked = [...range];

    const profile = await repository.getProfile();
    if (stale()) return;
    goals = profile.goals;
    template = templateOf(profile.mealPlan);

    // The whole week around the range, because the balance is measured over a week even when
    // only one day is being planned.
    const span = [...new Set([...range, ...weekDates(range[0] ?? today)])].sort();
    const rows = await repository.getDays(span[0] ?? today, span[span.length - 1] ?? today);
    if (stale()) return;
    dayRows = rows;

    const [recipes, usage] = await Promise.all([
      repository.allRecipes(),
      repository.recipeUsage(today)
    ]);
    const lookup = ingredientLookup(
      await repository.ingredientsByIds(
        recipes.flatMap((recipe: Recipe) => recipe.items.map((item) => item.ingredientId))
      )
    );
    if (stale()) return;

    const built = planCandidates(recipes, lookup, usage);
    candidatesRef.list = built.candidates;
    skipped = built.skipped;
    recipeNames = new Map(recipes.map((recipe: Recipe) => [recipe.id, recipe.name]));

    loading = false;
    solve();
  }

  /**
   * One solve. `only` rerolls a single cook by locking every other one, which is exactly what
   * „przelosuj ten posiłek" has to mean if the rest of the plan is to stay put.
   *
   * Rerolling one run also **bars the recipe it currently holds**. The search returns the
   * cheapest complete draw, so with everything else locked it answers the same recipe every
   * time: the first click changed the row, every click after it did nothing and said nothing.
   * When barring it leaves the slot with nothing to offer, the row keeps what it had and the
   * sheet says so, rather than dropping the whole proposal for a click that asked for very
   * little (decision 288).
   */
  function solve(only?: string, resize?: { run: PlanRun; length: number }): void {
    error = '';
    note = '';
    const dates = solveDates;
    const previous = proposal;
    if (dates.length === 0) {
      // Every day unticked: nothing to solve, and the cards stay so a day can be ticked again.
      proposal = null;
      missMessage = null;
      missed = false;
      balance = NO_BALANCE;
      return;
    }

    const rows = replace ? dayRows.filter((row) => !dates.includes(row.date)) : dayRows;
    balance = weekBalance(dates, dayRows, goals);
    const days = planDayInputs(dates, rows, goals, template, balance, dayOptions);
    dayInputs = days;
    const runs = previous?.runs ?? [];

    // A whole reroll keeps the locks, trimmed to the days still ticked — a lock whose cooking
    // day was unticked has nothing left to hold. A reroll of one cook, or a new length for one,
    // is local: every other run is kept as it is.
    let locked: PlanRun[];
    let pinned: PlanRun[] = [];
    if (resize !== undefined) {
      const resized = resizeRun(runs, resize.run.id, resize.length, days, locks);
      if (resized === undefined) return;
      locked = resized.locked;
      pinned = [resized.pinned];
    } else if (only !== undefined) {
      locked = runs.filter((run) => run.id !== only);
    } else {
      locked = runsForDates(
        runs.filter((run) => locks.includes(run.id)),
        dates
      );
      locks = locked.map((run) => run.id);
    }

    const rerolled = only === undefined ? undefined : runs.find((run) => run.id === only);

    const request = {
      days,
      template,
      candidates: candidatesRef.list,
      locked,
      pinned,
      runLengths,
      random: Math.random
    };

    let result =
      rerolled === undefined
        ? planRange(request)
        : planRange({ ...request, avoid: [rerolled.recipeId] });

    if (!result.ok && rerolled !== undefined) {
      // Nothing else fits this slot. Solve again without the bar so the row keeps a meal, and
      // say why it did not change — an unexplained no-op is what this whole branch is for.
      result = planRange(request);
      note = `Nie ma innego przepisu na „${slotLabel(rerolled.slotId)}" — zostaje ten sam.`;
    }

    if (!result.ok && resize !== undefined && result.failure.kind !== 'tolerance') {
      // A click on one cook's length must not throw the whole proposal away.
      note = `Nie da się tak zmienić gotowania na „${slotLabel(resize.run.slotId)}" — plan zostaje bez zmian.`;
      return;
    }

    if (result.ok) {
      proposal = result.proposal;
      missMessage = null;
      missed = false;
      return;
    }

    missMessage = failureMessage(result.failure);
    if (result.failure.kind === 'tolerance') {
      // The best plan found comes back anyway, with its difference spelled out.
      proposal = result.failure.proposal;
      missed = true;
      return;
    }
    proposal = null;
    missed = false;
  }

  function toggleLock(id: string): void {
    locks = locks.includes(id) ? locks.filter((other) => other !== id) : [...locks, id];
  }

  /**
   * A new length changes this cook, the days it gives up or reaches into, and nothing else:
   * re-solving the range for it rerolled every other meal of the week for one click.
   */
  function setRunLength(run: PlanRun, length: number): void {
    if (run.dates.length === length) return;
    runLengths = { ...runLengths, [run.id]: length };
    solve(undefined, { run, length });
  }

  /**
   * Unticking a day takes it out of the plan entirely — its card folds away, and the rest is
   * re-solved as if it were not in the range, so no pot is cooked on it or carried over from
   * it. Locks are honoured; ticking it back plans it afresh.
   */
  function togglePicked(date: string): void {
    picked = picked.includes(date) ? picked.filter((other) => other !== date) : [...picked, date];
    solve();
  }

  function setReplace(value: boolean): void {
    replace = value;
    locks = [];
    solve();
  }

  /** „Pierwszy dzień" — from the field or from the ± steps; anything unparseable is ignored. */
  function setStart(value: string): void {
    if (isDateKey(value)) start = value;
  }

  /**
   * „Pomiń" — this category gets no block for this one solve, and the solver's `shares` map
   * renormalises over what is left, so its share lands on the others and the main course's
   * target grows by itself (decision 447). „Planuj" puts it back.
   */
  function toggleSkip(date: string, slotId: string): void {
    const current = skips[date] ?? [];
    const next = current.includes(slotId)
      ? current.filter((other) => other !== slotId)
      : [...current, slotId];
    skips = { ...skips, [date]: next };
    locks = [];
    solve();
  }

  /** „Dołóż tu coś" — a category that already holds a meal is asked for one more. */
  function topUp(date: string, slotId: string): void {
    const current = topUps[date] ?? [];
    if (current.includes(slotId)) return;
    topUps = { ...topUps, [date]: [...current, slotId] };
    solve();
  }

  /** A kcal typed on a category beats its share; an empty field gives the share back. */
  function setSlotKcal(date: string, slotId: string, value: number): void {
    const day = { ...(typedKcal[date] ?? {}) };
    if (!Number.isFinite(value) || value < 0) delete day[slotId];
    else day[slotId] = Math.round(value);
    typedKcal = { ...typedKcal, [date]: day };
    locks = [];
    solve();
  }

  const isSkipped = (date: string, slotId: string): boolean =>
    (skips[date] ?? []).includes(slotId);

  /** What this category is solved against on this day — the solver's own number. */
  function targetKcal(date: string, slotId: string): number | undefined {
    const input = dayInputs.find((row) => row.date === date);
    if (input === undefined) return undefined;
    return slotTargetKcal(input, template).get(slotId);
  }

  /** Meals of the day filed under one category. */
  function mealsIn(date: string, slotId: string): PlannedMeal[] {
    return mealsOn(date).filter((meal) => meal.slotId === slotId);
  }

  /**
   * Meals nobody filed: no category, or one the template no longer has. They count in the
   * day's kcal and occupy no category, which is why the card names them (decision 451).
   */
  function unfiledOn(date: string): PlannedMeal[] {
    const ids = new Set(template.slots.map((slot) => slot.id));
    return mealsOn(date).filter((meal) => meal.slotId === undefined || !ids.has(meal.slotId));
  }

  async function apply(): Promise<void> {
    if (proposal === null || solveDates.length === 0) return;
    applying = true;
    try {
      // The proposal is already solved over exactly these days; the trim is a guard, not a rule.
      const runs = runsForDates(proposal.runs, solveDates);
      await repository.applyPlan(planWrites(runs, solveDates), replace ? 'replace' : 'append');
      onapplied();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Nie udało się zapisać planu.';
    } finally {
      applying = false;
    }
  }

  /**
   * Opening re-anchors the range on what the caller proposed; „Pierwszy dzień" moves it from
   * there.
   *
   * The guard is the whole point: this effect re-runs on later updates too, and without it
   * every re-run put the range back on the caller's first day — so „Pierwszy dzień" was set by
   * the user and then silently taken away again, the proposal was solved for a week the header
   * no longer showed, and „Zastosuj" wrote a week the user had not asked for or, when the
   * solve came back empty, did nothing at all. Chromium raced through the whole sequence
   * fast enough to hide it; WebKit lost it every time (STATE.md decision 394).
   *
   * `anchored` is a plain variable on purpose: it must not become a dependency of the effect
   * that maintains it.
   */
  let anchored = false;
  $effect(() => {
    if (!open) {
      anchored = false;
      return;
    }
    const first = dates[0] ?? today;
    if (anchored) return;
    anchored = true;
    start = first;
  });

  $effect(() => {
    if (!open) return;
    // The range, not just `open`: moving the first day is a different week and a fresh solve.
    range;
    void load();
  });

  /** kcal of the day against the goal it is judged by — what the bar under a card draws. */
  function barRatio(day: PlanDay): number {
    return goalRatio(day.totals.kcal, day.goals.kcal);
  }
</script>

<BottomSheet {open} {title} {onclose}>
  <!-- Which week is being planned. The calendar screen proposes one, this decides it: without
       it a week could only ever be the Monday-to-Sunday block around the day in view, and
       „planuję od 7 września" had no way to be said (decision 294). -->
  {#if weekMode}
    <div class="flex flex-wrap items-center gap-2 rounded-lg bg-(--color-surface) px-3 py-2">
      <span class="text-xs text-(--color-ink-muted)">Pierwszy dzień</span>
      <button
        type="button"
        class="emw-press emw-btn-icon border border-(--color-border) text-(--color-ink-muted)"
        aria-label="Zacznij dzień wcześniej"
        onclick={() => setStart(addDays(start, -1))}
      >
        <NavIcon path={CHEVRON_LEFT} class="size-4" />
      </button>
      <input
        type="date"
        class="rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1 text-sm tabular-nums"
        aria-label="Pierwszy dzień planowanego tygodnia"
        value={start}
        onchange={(event) => setStart(event.currentTarget.value)}
      />
      <button
        type="button"
        class="emw-press emw-btn-icon border border-(--color-border) text-(--color-ink-muted)"
        aria-label="Zacznij dzień później"
        onclick={() => setStart(addDays(start, 1))}
      >
        <NavIcon path={CHEVRON_RIGHT} class="size-4" />
      </button>
      <!-- The heading already carries the range; what a date field cannot say is which
           weekday it landed on, which is the whole question being asked here. -->
      <span class="text-xs text-(--color-ink-muted)">{formatWeekdayLong(range[0] ?? today)}</span>
    </div>
  {/if}

  {#if loading}
    <p class="text-sm text-(--color-ink-muted)">Układamy plan…</p>
  {:else}
    {#if balance.note !== ''}
      <p class="rounded-lg bg-(--color-surface) px-3 py-2 text-xs text-(--color-ink-muted)">
        {balance.note}
      </p>
    {/if}

    {#if missMessage !== null}
      <div class="mt-3 rounded-lg border border-(--color-warn-border) bg-(--color-warn-surface) px-3 py-2">
        <p class="text-sm font-medium text-(--color-warn)">{missMessage.title}</p>
        <p class="pt-1 text-xs text-(--color-ink-muted)">{missMessage.detail}</p>
        <p class="pt-1 text-xs text-(--color-ink-muted)">{missMessage.hint}</p>
      </div>
    {/if}

    {#if proposal !== null && busyDates.length > 0}
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span class="text-(--color-ink-muted)">
            {busyDates.length === 1 ? 'Ten dzień ma już posiłki:' : 'Część dni ma już posiłki:'}
          </span>
          <button
            type="button"
            class="emw-press emw-tint rounded-lg border px-2 py-1 font-medium {replace
              ? 'border-(--color-border)'
              : 'border-(--color-accent) text-(--color-accent)'}"
            onclick={() => setReplace(false)}
          >
            Dopisz
          </button>
          <button
            type="button"
            class="emw-press emw-tint rounded-lg border px-2 py-1 font-medium {replace
              ? 'border-(--color-accent) text-(--color-accent)'
              : 'border-(--color-border)'}"
            onclick={() => setReplace(true)}
          >
            Zastąp
          </button>
        </div>
    {/if}

    {#if proposal !== null || weekMode}
      <!-- Every day of the range keeps its card, so an unticked one can be ticked again; only a
           ticked day unfolds into a plan. -->
      <ul class="pt-3">
        {#each range as date (date)}
          {@const day = proposal?.days.find((row) => row.date === date)}
          {@const runs = runsByDate.get(date) ?? []}
          <li
            class="mt-3 rounded-xl border border-(--color-border) first:mt-0 {day === undefined
              ? 'px-3 py-2'
              : 'p-3'}"
          >
            <div class="flex items-baseline justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                {#if weekMode}
                  <input
                    id="plan-day-{date}"
                    type="checkbox"
                    class="size-4 accent-(--color-accent)"
                    checked={picked.includes(date)}
                    onchange={() => togglePicked(date)}
                  />
                {/if}
                <label
                  class="truncate text-sm font-medium first-letter:uppercase {picked.includes(date)
                    ? ''
                    : 'text-(--color-ink-muted)'}"
                  for="plan-day-{date}"
                >
                  {weekMode ? formatDayLong(date) : relativeDayLabel(date, today)}
                </label>
              </div>
              {#if day === undefined}
                {#if !picked.includes(date)}
                  <p class="shrink-0 text-xs text-(--color-ink-muted)">nie planuję</p>
                {/if}
              {:else}
                <p class="shrink-0 text-right text-sm tabular-nums">
                  <span class={isOverGoal(day.totals.kcal, day.goals.kcal) ? 'text-(--color-warn)' : ''}>
                    {Math.round(day.totals.kcal)}
                  </span>
                  <span class="text-xs text-(--color-ink-muted)">/ {Math.round(day.goals.kcal)} kcal</span>
                </p>
              {/if}
            </div>

            {#if day !== undefined}
            <svg
              class="mt-2 h-1.5 w-full rounded-full bg-(--color-border) {day.outOfBand
                ? 'text-(--color-warn)'
                : 'text-(--color-accent)'}"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              role="img"
              aria-label="{Math.round(day.totals.kcal)} z {Math.round(day.goals.kcal)} kcal"
            >
              <rect x="0" y="0" height="6" width={100 * barRatio(day)} fill="currentColor" />
            </svg>

            <!-- The three tie-breakers, drawn the way every other screen draws them. Per day
                 rather than per meal: four rows of three numbers on a phone is a wall, and the
                 question a proposal has to answer is „does this day work". -->
            <div class="pt-2">
              <MacroBars totals={day.totals} goals={day.goals} />
            </div>

            <!-- „Pozostałe" above the categories, and what it costs (STATE.md decision 451).
                 A meal nobody filed counts in the day's calories but occupies no category, so
                 the planner will still offer a breakfast next to the eggs already on the day —
                 correct, since nothing told it those eggs were breakfast, and exactly the
                 surprise this is here to remove. Seeing it is the fix; nothing is refiled. -->
            {@const unfiled = unfiledOn(day.date)}
            {#if unfiled.length > 0}
              <div class="mt-2 rounded-lg bg-(--color-surface) px-3 py-2">
                <p class="text-xs font-medium">{UNFILED_LABEL}</p>
                <ul>
                  {#each unfiled as meal (meal.id)}
                    <li class="emw-recipe-name py-0.5 text-sm text-(--color-ink-muted)">
                      {recipeNames.get(meal.recipeId) ?? 'Usunięty przepis'}
                    </li>
                  {/each}
                </ul>
                <p class="pt-1 text-xs text-(--color-ink-muted)">
                  wliczone w kalorie, ale nie zajmują żadnej kategorii
                </p>
              </div>
            {/if}

            <!-- Every category of the template, in its order — not only the ones the proposal
                 filled. A category the user has already filled is left alone (decision 446),
                 „Pomiń" moves its share to the others (447), and a kcal typed on it beats that
                 share for this solve (448). -->
            <ul class="pt-1">
              {#each template.slots as slot (slot.id)}
                {@const filed = mealsIn(day.date, slot.id)}
                {@const slotRuns = runs.filter((run) => run.slotId === slot.id)}
                {@const off = isSkipped(day.date, slot.id)}
                {@const target = targetKcal(day.date, slot.id)}
                <li class="border-t border-(--color-border) py-2 first:border-t-0">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <p class="min-w-0 text-xs font-medium {off ? 'text-(--color-ink-muted)' : ''}">
                      {slot.label}
                    </p>
                    <div class="flex shrink-0 items-center gap-2">
                      {#if !off && target !== undefined}
                        <!-- The number the solver aims at, from `slotTargetKcal` — the same call
                             `blockTarget` makes, so what is shown cannot drift from what is
                             solved against. Typing one turns it into an override. -->
                        <label class="flex items-center gap-1 text-xs text-(--color-ink-muted)">
                          <input
                            class="w-16 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-1.5 py-0.5 text-right text-xs tabular-nums"
                            type="number"
                            inputmode="numeric"
                            min="0"
                            step="10"
                            aria-label="Kalorie na {slot.label}"
                            value={Math.round(target)}
                            onchange={(event) =>
                              setSlotKcal(day.date, slot.id, event.currentTarget.valueAsNumber)}
                          />
                          kcal
                        </label>
                      {/if}
                      <button
                        type="button"
                        class="emw-press emw-tint rounded-lg border px-2 py-0.5 text-xs font-medium {off
                          ? 'border-(--color-accent) text-(--color-accent)'
                          : 'border-(--color-border) text-(--color-ink-muted)'}"
                        aria-pressed={off}
                        aria-label="{off ? 'Planuj' : 'Pomiń'} {slot.label}"
                        onclick={() => toggleSkip(day.date, slot.id)}
                      >
                        {off ? 'Planuj' : 'Pomiń'}
                      </button>
                    </div>
                  </div>

                  {#each filed as meal (meal.id)}
                    <p class="emw-recipe-name pt-1 text-sm text-(--color-ink-muted)">
                      {recipeNames.get(meal.recipeId) ?? 'Usunięty przepis'}
                      <span class="text-xs">· już zaplanowane</span>
                    </p>
                  {/each}

                  {#each slotRuns as run (run.id)}
                    {@const cooking = run.dates[0] === day.date}
                    <div class="flex items-start justify-between gap-2 pt-1">
                      <div class="min-w-0 flex-1">
                        <!-- Wrapped, never clipped (emw-recipe-name): „Sałatka z chrupiącym…" is
                             the one thing on this row the user has to read to judge the proposal,
                             and on a phone the 1/2/3 control and the two buttons leave it about
                             half the width. -->
                        <p class="emw-recipe-name text-sm font-medium">{run.recipeName}</p>
                        <p class="text-xs text-(--color-ink-muted)">
                          {portionLabel(run)}
                          {#if cooking && run.dates.length > 1}
                            · {cookingLabel(run.dates.length)}
                          {:else if !cooking}
                            · z garnka z {formatDayMonth(run.dates[0] ?? day.date)}
                          {/if}
                        </p>
                      </div>

                      {#if cooking}
                        <div class="flex shrink-0 items-center gap-1">
                          <!-- A cook never overruns the range, so on a single day it can only
                               ever last one — the control would be a button that does nothing. -->
                          {#if weekMode}
                            <div class="flex overflow-hidden rounded-lg border border-(--color-border)">
                              {#each [1, 2, MAX_BATCH_DAYS] as length (length)}
                                <button
                                  type="button"
                                  class="emw-press px-2 py-1 text-xs tabular-nums {run.dates.length === length
                                    ? 'emw-btn-primary'
                                    : 'emw-tint'}"
                                  aria-label="Gotuj na {length} dni"
                                  title="Gotuj na {length} dni"
                                  aria-pressed={run.dates.length === length}
                                  onclick={() => setRunLength(run, length)}
                                >
                                  {length}
                                </button>
                              {/each}
                            </div>
                          {/if}
                          <button
                            type="button"
                            class="emw-press emw-btn-icon border border-(--color-border) {locks.includes(run.id)
                              ? 'text-(--color-accent)'
                              : 'text-(--color-ink-muted)'}"
                            aria-label="{locks.includes(run.id) ? 'Odblokuj' : 'Zablokuj'} {run.recipeName}"
                            title={locks.includes(run.id)
                              ? 'Odblokuj — kolejne losowanie może to zmienić'
                              : 'Zablokuj — kolejne losowanie tego nie ruszy'}
                            aria-pressed={locks.includes(run.id)}
                            onclick={() => toggleLock(run.id)}
                          >
                            <NavIcon path={locks.includes(run.id) ? LOCK : UNLOCK} class="size-4" />
                          </button>
                          <button
                            type="button"
                            class="emw-press emw-btn-icon border border-(--color-border) text-(--color-ink-muted)"
                            aria-label="Przelosuj {slot.label}"
                            title="Przelosuj tylko ten posiłek — reszta zostaje"
                            onclick={() => solve(run.id)}
                          >
                            <NavIcon path={REROLL} class="size-4" />
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/each}

                  {#if off}
                    <p class="pt-1 text-xs text-(--color-ink-muted)">
                      Dziś pomijamy — kalorie tego posiłku rozchodzą się na pozostałe.
                    </p>
                  {:else if filed.length > 0 && slotRuns.length === 0}
                    <!-- A category holding anything is left alone by default; this is how more
                         is asked for (decision 446). -->
                    <button
                      type="button"
                      class="emw-press emw-btn-link pt-1 text-xs font-medium"
                      onclick={() => topUp(day.date, slot.id)}
                    >
                      Dołóż tu coś
                    </button>
                  {:else if slotRuns.length === 0}
                    <p class="pt-1 text-xs text-(--color-ink-muted)">
                      Brak pasującego przepisu.
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
            {/if}
          </li>
        {/each}
      </ul>

      <!-- Only worth saying over a range where a longer cook could have fitted: on one day
           every batched slot is „shortened", which is noise rather than news. -->
      {#if weekMode && proposal !== null && proposal.shortenedSlotIds.length > 0}
        <p class="pt-3 text-xs text-(--color-ink-muted)">
          Skrócone gotowanie na zapas: {proposal.shortenedSlotIds.map(slotLabel).join(', ')} —
          nie zmieściło się w zaplanowanym zakresie.
        </p>
      {/if}
    {/if}

    {#if skippedLabel(skipped) !== ''}
      <p class="pt-3 text-xs text-(--color-ink-muted)">{skippedLabel(skipped)}</p>
    {/if}

    {#if error !== ''}
      <p class="pt-3 text-sm text-(--color-danger)">{error}</p>
    {/if}

    {#if note !== ''}
      <p class="pt-3 text-sm text-(--color-ink-muted)" role="status" aria-live="polite">{note}</p>
    {/if}

    <div class="flex flex-wrap justify-end gap-2 pt-4">
      <button
        type="button"
        class="emw-press emw-btn emw-btn-secondary"
        disabled={proposal === null}
        onclick={() => solve()}
      >
        Losuj ponownie
      </button>
      <button
        type="button"
        class="emw-press emw-btn emw-btn-primary px-4 disabled:opacity-40"
        disabled={proposal === null || applying || solveDates.length === 0}
        onclick={() => void apply()}
      >
        {applying ? 'Zapisywanie…' : missed ? 'Zastosuj mimo różnicy' : 'Zastosuj'}
      </button>
    </div>
  {/if}
</BottomSheet>
