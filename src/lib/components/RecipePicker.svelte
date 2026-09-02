<script lang="ts">
  import type { Macros, Tag } from '../types';
  import type { BudgetEntry, RecipeListEntry } from '../recipes';
  import { budgetFit, fitToBudget, searchRecipes } from '../recipes';
  import { dayBudget, remainingGoals } from '../calendar';
  import { todayDate } from '../dates';
  import { repository } from '../repository';
  import BottomSheet from './BottomSheet.svelte';

  /**
   * The add-meal sheet of PLAN.md task 3: search over the names, tag chips that narrow the
   * list, and the same ordering the library uses — most recent activity first, frequency as
   * the tie-break (STATE.md decisions 46 and 47). „Nowy przepis" sits at the bottom.
   *
   * The library is read when the sheet opens, so a recipe written a moment ago is offered
   * without a reload.
   *
   * The header also answers the question that actually gets asked at supper time: how much
   * of the day is left, and which recipes still fit it (STATE.md decision 64). The filter is
   * off until it is asked for — the picker's job is to show the library, not to hide it.
   *
   * Phase 9 adds the other half of that question (decision 148). The header now states what is
   * left of **every** goal macro, as a readout and nothing more: the list keeps its decision
   * 46 order and the app never claims to know which recipe closes a protein gap. And a recipe
   * that does not fit whole but fits at half a portion is offered as exactly that — half is
   * the only fraction, because a rule with one fraction cannot be misread.
   */

  let {
    open = false,
    totals,
    goals,
    onpick,
    onclose
  }: {
    open?: boolean;
    /** The day's totals so far. */
    totals: Macros;
    /** The day's goals — its `goalSnapshot` when it has one. */
    goals: Macros;
    onpick: (recipeId: string) => void;
    onclose: () => void;
  } = $props();

  let entries = $state<RecipeListEntry[]>([]);
  let tags = $state<Tag[]>([]);
  let macros = $state(new Map<string, Macros>());
  let loading = $state(false);

  let query = $state('');
  let selected = $state<string[]>([]);
  let budgetOnly = $state(false);

  const budget = $derived(dayBudget(totals, goals));
  const left = $derived(remainingGoals(totals, goals));
  /** The filter can only be *on* while it is offered, so an emptied budget re-opens the list. */
  const filtering = $derived(budgetOnly && budget.canFilter);
  const pool = $derived(
    filtering ? fitToBudget(entries, macros, budget.remaining).map((row) => row.entry) : entries
  );
  const visible = $derived(searchRecipes(pool, query, selected));

  /**
   * Whether each visible recipe needs half a portion to fit. Computed over the *visible*
   * list rather than folded into the filter, so the badge is there whether or not the filter
   * is on — and so the filter stays a filter and never reorders anything.
   */
  const fits = $derived(
    new Map<string, BudgetEntry['fit'] | undefined>(
      budget.canFilter
        ? visible.map((entry) => [
            entry.recipe.id,
            budgetFit(macros.get(entry.recipe.id), budget.remaining)
          ])
        : []
    )
  );
  const chips = $derived(
    tags.filter((tag) => entries.some((entry) => entry.recipe.tags.includes(tag.key)))
  );

  async function load(): Promise<void> {
    loading = true;
    const [library, allTags] = await Promise.all([
      repository.recipeLibrary(todayDate()),
      repository.allTags()
    ]);
    entries = library;
    tags = allTags;
    macros = await repository.recipeMacros(library.map((entry) => entry.recipe));
    loading = false;
  }

  $effect(() => {
    if (!open) return;
    query = '';
    selected = [];
    budgetOnly = false;
    void load();
  });

  function toggle(key: string): void {
    selected = selected.includes(key)
      ? selected.filter((value) => value !== key)
      : [...selected, key];
  }

  function labelFor(key: string): string {
    return tags.find((tag) => tag.key === key)?.label ?? key;
  }
</script>

<BottomSheet {open} title="Dodaj posiłek" {onclose}>
  {#if budget.exhausted}
    <p class="pb-3 text-sm text-amber-700">
      Limit dzienny już wykorzystany — {Math.round(-budget.remaining)} kcal ponad cel. Poniżej
      cała biblioteka.
    </p>
  {:else if budget.hasGoal}
    <div class="flex flex-wrap items-center justify-between gap-2 pb-3">
      <p class="text-sm">
        Zostało
        {#each left as goal, index (goal.key)}
          {#if index > 0}<span class="text-(--color-ink-muted)"> · </span>{/if}<span
            class="font-semibold tabular-nums {goal.remaining < 0 ? 'text-amber-700' : ''}"
            >{Math.round(goal.remaining)} {goal.label}</span
          >
        {/each}
      </p>
      <label class="flex items-center gap-2 text-sm">
        <input
          class="size-4 accent-(--color-accent)"
          type="checkbox"
          bind:checked={budgetOnly}
        />
        Zmieści się w limicie
      </label>
    </div>
  {/if}

  <label class="block text-sm font-medium">
    <span class="sr-only">Szukaj przepisu</span>
    <input
      class="w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
      type="search"
      placeholder="Szukaj przepisu…"
      bind:value={query}
    />
  </label>

  {#if chips.length > 0}
    <ul class="flex flex-wrap gap-2 pt-3" aria-label="Filtruj po tagach">
      {#each chips as tag (tag.key)}
        {@const on = selected.includes(tag.key)}
        <li>
          <button
            type="button"
            class="rounded-full border px-3 py-1 text-sm {on
              ? 'border-(--color-accent) bg-(--color-accent) text-(--color-accent-ink)'
              : 'border-(--color-border) text-(--color-ink-muted)'}"
            aria-pressed={on}
            onclick={() => toggle(tag.key)}
          >
            {tag.label}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if loading}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if entries.length === 0}
    <p class="pt-4 text-sm text-(--color-ink-muted)">
      Nie masz jeszcze żadnego przepisu. Zacznij od „Nowy przepis” na dole.
    </p>
  {:else if visible.length === 0 && filtering}
    <p class="pt-4 text-sm text-(--color-ink-muted)">
      Żaden przepis nie mieści się w {Math.round(budget.remaining)} kcal.
      <button type="button" class="text-(--color-accent) underline" onclick={() => (budgetOnly = false)}>
        Pokaż wszystkie
      </button>
    </p>
  {:else if visible.length === 0}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Nic nie pasuje do tych kryteriów.</p>
  {:else}
    <ul class="flex flex-col gap-2 pt-4">
      {#each visible as entry (entry.recipe.id)}
        {@const portion = macros.get(entry.recipe.id)}
        <li>
          <button
            type="button"
            class="block w-full rounded-xl border border-(--color-border) p-3 text-left"
            onclick={() => onpick(entry.recipe.id)}
          >
            <span class="flex items-baseline justify-between gap-3">
              <span class="min-w-0 truncate font-medium">{entry.recipe.name}</span>
              {#if portion}
                <span class="shrink-0 text-sm text-(--color-ink-muted)">
                  {Math.round(portion.kcal)} kcal / porcja
                </span>
              {/if}
            </span>
            {#if fits.get(entry.recipe.id) === 'half'}
              <span class="block pt-1 text-xs text-amber-700">
                Zmieści się przy pół porcji
              </span>
            {/if}
            {#if entry.recipe.tags.length > 0}
              <span class="flex flex-wrap gap-1 pt-2">
                {#each entry.recipe.tags as key (key)}
                  <span
                    class="rounded-full border border-(--color-border) px-2 py-0.5 text-xs text-(--color-ink-muted)"
                  >
                    {labelFor(key)}
                  </span>
                {/each}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <a
    class="mt-4 block rounded-lg border border-(--color-border) px-3 py-2 text-center text-sm font-medium"
    href="#/recipes/new/edit"
  >
    Nowy przepis
  </a>
</BottomSheet>
