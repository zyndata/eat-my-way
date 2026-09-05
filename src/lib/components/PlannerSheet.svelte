<script lang="ts">
  import type { Day, Macros, MealPlanTemplate, PlannedMeal, Recipe } from '../types';
  import type { PlanDay, PlanProposal, PlanRun, SkippedRecipes } from '../planner';
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
    runsForDates,
    skippedLabel,
    templateOf,
    weekBalance
  } from '../planner';
  import { goalRatio, isOverGoal, weekDates } from '../calendar';
  import { formatDayLong, formatDayMonth, relativeDayLabel } from '../dates';
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
   */

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
  /** Days that will actually be written. Unticking one shortens the cook that covered it. */
  let picked = $state<string[]>([]);
  /** „Zastąp" — the day is cleared first, so the plan is solved as if it were empty. */
  let replace = $state(false);
  /** Existing meals moved to another slot before generating (day mode only). */
  let slotOverrides = $state<Record<string, string>>({});

  const candidatesRef: { list: ReturnType<typeof planCandidates>['candidates'] } = { list: [] };

  const busyDates = $derived(
    dayRows.filter((row) => row.meals.length > 0 && dates.includes(row.date)).map((row) => row.date)
  );

  const title = $derived(
    weekMode
      ? `Zaplanuj tydzień ${formatDayMonth(dates[0] ?? today)} – ${formatDayMonth(dates[dates.length - 1] ?? today)}`
      : busyDates.length > 0
        ? `Uzupełnij ${relativeDayLabel(dates[0] ?? today, today).toLowerCase()}`
        : `Zaplanuj ${relativeDayLabel(dates[0] ?? today, today).toLowerCase()}`
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

  async function load(): Promise<void> {
    loading = true;
    error = '';
    proposal = null;
    locks = [];
    runLengths = {};
    slotOverrides = {};
    replace = false;
    picked = [...dates];

    const profile = await repository.getProfile();
    goals = profile.goals;
    template = templateOf(profile.mealPlan);

    // The whole week around the range, because the balance is measured over a week even when
    // only one day is being planned.
    const span = [...new Set([...dates, ...weekDates(dates[0] ?? today)])].sort();
    dayRows = await repository.getDays(span[0] ?? today, span[span.length - 1] ?? today);

    const [recipes, usage] = await Promise.all([
      repository.allRecipes(),
      repository.recipeUsage(today)
    ]);
    const lookup = ingredientLookup(
      await repository.ingredientsByIds(
        recipes.flatMap((recipe: Recipe) => recipe.items.map((item) => item.ingredientId))
      )
    );

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
  function solve(only?: string): void {
    error = '';
    note = '';
    const rows = replace ? dayRows.filter((row) => !dates.includes(row.date)) : dayRows;
    balance = weekBalance(dates, dayRows, goals);

    const kept =
      only === undefined
        ? (proposal?.runs ?? []).filter((run) => locks.includes(run.id))
        : (proposal?.runs ?? []).filter((run) => run.id !== only);

    const rerolled = only === undefined ? undefined : proposal?.runs.find((run) => run.id === only);

    const request = {
      days: planDayInputs(dates, rows, goals, template, balance, slotOverrides),
      template,
      candidates: candidatesRef.list,
      locked: kept,
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

  function setRunLength(run: PlanRun, length: number): void {
    runLengths = { ...runLengths, [run.id]: length };
    // Re-solving the days a run touches means re-solving the range; every lock is honoured.
    solve();
  }

  function togglePicked(date: string): void {
    picked = picked.includes(date) ? picked.filter((other) => other !== date) : [...picked, date];
  }

  function setReplace(value: boolean): void {
    replace = value;
    locks = [];
    solve();
  }

  function moveMeal(mealId: string, slotId: string): void {
    slotOverrides = { ...slotOverrides, [mealId]: slotId };
    locks = [];
    solve();
  }

  async function apply(): Promise<void> {
    if (proposal === null || picked.length === 0) return;
    applying = true;
    try {
      const runs = runsForDates(proposal.runs, picked);
      await repository.applyPlan(planWrites(runs, picked), replace ? 'replace' : 'append');
      onapplied();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Nie udało się zapisać planu.';
    } finally {
      applying = false;
    }
  }

  $effect(() => {
    if (!open) return;
    void load();
  });

  /** kcal of the day against the goal it is judged by — what the bar under a card draws. */
  function barRatio(day: PlanDay): number {
    return goalRatio(day.totals.kcal, day.goals.kcal);
  }
</script>

<BottomSheet {open} {title} {onclose}>
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

    {#if proposal !== null}
      {#if busyDates.length > 0}
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span class="text-(--color-ink-muted)">
            {busyDates.length === 1 ? 'Ten dzień ma już posiłki:' : 'Część dni ma już posiłki:'}
          </span>
          <button
            type="button"
            class="rounded-lg border px-2 py-1 font-medium {replace
              ? 'border-(--color-border)'
              : 'border-(--color-accent) text-(--color-accent)'}"
            onclick={() => setReplace(false)}
          >
            Dopisz
          </button>
          <button
            type="button"
            class="rounded-lg border px-2 py-1 font-medium {replace
              ? 'border-(--color-accent) text-(--color-accent)'
              : 'border-(--color-border)'}"
            onclick={() => setReplace(true)}
          >
            Zastąp
          </button>
        </div>
      {/if}

      <ul class="pt-3">
        {#each proposal.days as day (day.date)}
          {@const runs = runsByDate.get(day.date) ?? []}
          <li class="mt-3 rounded-xl border border-(--color-border) p-3 first:mt-0">
            <div class="flex items-baseline justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                {#if weekMode}
                  <input
                    id="plan-day-{day.date}"
                    type="checkbox"
                    class="size-4 accent-(--color-accent)"
                    checked={picked.includes(day.date)}
                    onchange={() => togglePicked(day.date)}
                  />
                {/if}
                <label class="truncate text-sm font-medium first-letter:uppercase" for="plan-day-{day.date}">
                  {weekMode ? formatDayLong(day.date) : relativeDayLabel(day.date, today)}
                </label>
              </div>
              <p class="shrink-0 text-right text-sm tabular-nums">
                <span class={isOverGoal(day.totals.kcal, day.goals.kcal) ? 'text-(--color-warn)' : ''}>
                  {Math.round(day.totals.kcal)}
                </span>
                <span class="text-xs text-(--color-ink-muted)">/ {Math.round(day.goals.kcal)} kcal</span>
              </p>
            </div>

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

            {#if mealsOn(day.date).length > 0}
              <ul class="pt-2">
                {#each mealsOn(day.date) as meal, index (meal.id)}
                  <li class="flex items-center justify-between gap-2 py-1 text-sm">
                    <span class="min-w-0 truncate text-(--color-ink-muted)">
                      {recipeNames.get(meal.recipeId) ?? 'Usunięty przepis'}
                      <span class="text-xs">· już zaplanowane</span>
                    </span>
                    {#if !weekMode}
                      <select
                        class="shrink-0 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1 text-xs"
                        aria-label="Posiłek dnia dla „{recipeNames.get(meal.recipeId) ?? ''}"
                        value={slotOverrides[meal.id] ?? template.slots[index]?.id ?? ''}
                        onchange={(event) => moveMeal(meal.id, event.currentTarget.value)}
                      >
                        {#each template.slots as slot (slot.id)}
                          <option value={slot.id}>{slot.label}</option>
                        {/each}
                      </select>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}

            <ul class="pt-1">
              {#each runs as run (run.id)}
                {@const cooking = run.dates[0] === day.date}
                <li class="flex items-start justify-between gap-2 border-t border-(--color-border) py-2 first:border-t-0">
                  <div class="min-w-0">
                    <p class="text-xs text-(--color-ink-muted)">{slotLabel(run.slotId)}</p>
                    <p class="truncate text-sm font-medium">{run.recipeName}</p>
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
                      <!-- A cook never overruns the range, so on a single day it can only ever
                           last one — the control would be a button that does nothing. -->
                      {#if weekMode}
                        <div class="flex overflow-hidden rounded-lg border border-(--color-border)">
                          {#each [1, 2, MAX_BATCH_DAYS] as length (length)}
                            <button
                              type="button"
                              class="px-2 py-1 text-xs tabular-nums {run.dates.length === length
                                ? 'bg-(--color-accent) text-(--color-accent-ink)'
                                : ''}"
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
                        class="rounded-lg border border-(--color-border) p-1.5 {locks.includes(run.id)
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
                        class="rounded-lg border border-(--color-border) p-1.5 text-(--color-ink-muted)"
                        aria-label="Przelosuj {slotLabel(run.slotId)}"
                        title="Przelosuj tylko ten posiłek — reszta zostaje"
                        onclick={() => solve(run.id)}
                      >
                        <NavIcon path={REROLL} class="size-4" />
                      </button>
                    </div>
                  {/if}
                </li>
              {/each}

              {#each day.unfilledSlotIds as slotId (slotId)}
                <li class="border-t border-(--color-border) py-2 text-xs text-(--color-ink-muted)">
                  {slotLabel(slotId)} — brak pasującego przepisu.
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>

      <!-- Only worth saying over a range where a longer cook could have fitted: on one day
           every batched slot is „shortened", which is noise rather than news. -->
      {#if weekMode && proposal.shortenedSlotIds.length > 0}
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
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        disabled={proposal === null}
        onclick={() => solve()}
      >
        Losuj ponownie
      </button>
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-40"
        disabled={proposal === null || applying || picked.length === 0}
        onclick={() => void apply()}
      >
        {applying ? 'Zapisywanie…' : missed ? 'Zastosuj mimo różnicy' : 'Zastosuj'}
      </button>
    </div>
  {/if}
</BottomSheet>
