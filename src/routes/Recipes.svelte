<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import type { Macros, Tag } from '../lib/types';
  import type { RecipeListEntry, RecipeSort } from '../lib/recipes';
  import { groupByTag, isRecipeSort, searchRecipes } from '../lib/recipes';
  import { pluralPl } from '../lib/text';
  import { todayDate } from '../lib/dates';
  import { repository } from '../lib/repository';
  import { scheduleSync, syncState } from '../lib/sync/state.svelte';

  /**
   * Recipe library: search over the names, tag chips that narrow the list, and the default
   * order from STATE.md decision 46 — most recently edited or planned first.
   *
   * Everything is read from IndexedDB once when the screen mounts; filtering and ranking
   * then happen in memory, so typing never waits on a database round trip.
   *
   * Phase 9 adds three things on top of that list: a choice of order (task 4), a view grouped
   * by tag (task 1) and „Powiel" (task 3). The first two are remembered in the meta table,
   * which never travels to Drive — how a list is drawn belongs to the screen in front of you,
   * not to the account.
   */

  const SORT_LABELS: ReadonlyArray<{ value: RecipeSort; label: string }> = [
    { value: 'activity', label: 'Ostatnio używane' },
    { value: 'name', label: 'Nazwa A–Z' },
    { value: 'kcal', label: 'Kalorie na porcję' }
  ];

  let entries = $state<RecipeListEntry[]>([]);
  let tags = $state<Tag[]>([]);
  let macros = $state(new Map<string, Macros>());
  let loading = $state(true);
  let duplicating = $state<string | null>(null);

  let query = $state('');
  let selected = $state<string[]>([]);
  let sort = $state<RecipeSort>('activity');
  let grouped = $state(false);

  const visible = $derived(searchRecipes(entries, query, selected, { sort, portionMacros: macros }));
  /**
   * The sections. `tags` is already most-used first, which is the order decision 157 chose,
   * and „Bez tagu" is appended last by `groupByTag`. A recipe with three tags appears three
   * times, so the counts deliberately sum to more than the library holds.
   */
  const groups = $derived(groupByTag(visible, tags));
  /** Only tags that some recipe actually carries are worth offering as a chip. */
  const chips = $derived(tags.filter((tag) => entries.some((entry) => entry.recipe.tags.includes(tag.key))));

  async function load(): Promise<void> {
    loading = true;
    const [library, allTags, storedSort, storedGrouped] = await Promise.all([
      repository.recipeLibrary(todayDate()),
      repository.allTags(),
      repository.getMeta('recipeSort'),
      repository.getMeta('recipeGrouped')
    ]);
    entries = library;
    tags = allTags;
    if (isRecipeSort(storedSort)) sort = storedSort;
    grouped = storedGrouped === true;
    macros = await repository.recipeMacros(library.map((entry) => entry.recipe));
    // A tag can disappear while a chip for it is still selected.
    selected = selected.filter((key) => allTags.some((tag) => tag.key === key));
    loading = false;
  }

  function toggle(key: string): void {
    selected = selected.includes(key)
      ? selected.filter((selectedKey) => selectedKey !== key)
      : [...selected, key];
  }

  function labelFor(key: string): string {
    return tags.find((tag) => tag.key === key)?.label ?? key;
  }

  async function chooseSort(next: RecipeSort): Promise<void> {
    sort = next;
    await repository.setMeta('recipeSort', next);
  }

  async function toggleGrouped(): Promise<void> {
    grouped = !grouped;
    await repository.setMeta('recipeGrouped', grouped);
  }

  /**
   * „Powiel": an independent copy, which is what makes the variant workflow possible without
   * retyping a recipe (STATE.md decision 66). The list is re-read so the copy — and every
   * tag count it just moved — is on screen immediately.
   */
  async function duplicate(id: string): Promise<void> {
    duplicating = id;
    try {
      await repository.duplicateRecipe(id);
      scheduleSync();
      await load();
    } finally {
      duplicating = null;
    }
  }

  /**
   * Read once, and again whenever a sync writes something: a recipe made on the other device
   * lands under this list while it is open, and the list is read only when it mounts
   * (STATE.md decision 228).
   */
  $effect(() => {
    syncState.dataVersion;
    void load();
  });
</script>

{#snippet card(entry: RecipeListEntry)}
  {@const portion = macros.get(entry.recipe.id)}
  <li class="rounded-xl border border-(--color-border) bg-(--color-surface-raised)">
    <a class="block p-3" href="#/recipes/{entry.recipe.id}/edit">
      <span class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 truncate font-medium">{entry.recipe.name}</span>
        {#if portion}
          <span class="shrink-0 text-sm text-(--color-ink-muted)">
            {Math.round(portion.kcal)} kcal / porcja
          </span>
        {/if}
      </span>

      <span class="block pt-1 text-xs text-(--color-ink-muted)">
        {entry.recipe.items.length}
        {pluralPl(entry.recipe.items.length, {
          one: 'składnik',
          few: 'składniki',
          many: 'składników'
        })}
        {#if entry.usage.plannedCount > 0}
          <!-- „w ostatnim roku": the count is windowed, see STATE.md decision 147. -->
          · zaplanowany {entry.usage.plannedCount}
          {entry.usage.plannedCount === 1 ? 'raz' : 'razy'} w ostatnim roku
        {/if}
      </span>

      {#if entry.recipe.tags.length > 0}
        <span class="flex flex-wrap gap-1 pt-2">
          {#each entry.recipe.tags as key (key)}
            <span class="rounded-full border border-(--color-border) px-2 py-0.5 text-xs text-(--color-ink-muted)">
              {labelFor(key)}
            </span>
          {/each}
        </span>
      {/if}
    </a>
    <div class="flex justify-end border-t border-(--color-border) px-3 py-1.5">
      <button
        type="button"
        class="text-xs font-medium text-(--color-accent) disabled:opacity-50"
        disabled={duplicating !== null}
        onclick={() => void duplicate(entry.recipe.id)}
      >
        {duplicating === entry.recipe.id ? 'Powielanie…' : 'Powiel'}
      </button>
    </div>
  </li>
{/snippet}

<Screen title="Przepisy" lead="Twoja biblioteka przepisów. Składniki zawsze na 1 porcję.">
  <div class="flex flex-wrap items-center gap-2">
    <label class="min-w-0 flex-1 text-sm font-medium">
      <span class="sr-only">Szukaj przepisu</span>
      <input
        class="w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="search"
        placeholder="Szukaj przepisu…"
        bind:value={query}
      />
    </label>
    <a
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink)"
      href="#/recipes/new/edit"
    >
      Nowy przepis
    </a>
  </div>

  <div class="flex flex-wrap items-center gap-2 pt-3">
    <label class="text-sm text-(--color-ink-muted)">
      Sortuj
      <select
        class="ml-1 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-2 py-1 text-sm text-(--color-ink) outline-none focus:border-(--color-accent)"
        value={sort}
        onchange={(event) => void chooseSort(event.currentTarget.value as RecipeSort)}
      >
        {#each SORT_LABELS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <button
      type="button"
      class="rounded-full border px-3 py-1 text-sm {grouped
        ? 'border-(--color-accent) bg-(--color-accent) text-(--color-accent-ink)'
        : 'border-(--color-border) text-(--color-ink-muted)'}"
      aria-pressed={grouped}
      onclick={() => void toggleGrouped()}
    >
      Grupuj po tagach
    </button>
    {#if query.trim() !== ''}
      <span class="text-xs text-(--color-ink-muted)">Wyszukiwanie ustawia własną kolejność.</span>
    {/if}
  </div>

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
    {#if selected.length > 0}
      <button type="button" class="pt-2 text-sm text-(--color-accent) underline" onclick={() => (selected = [])}>
        Wyczyść filtry
      </button>
    {/if}
  {/if}

  {#if loading}
    <p class="pt-6 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if entries.length === 0}
    <!-- The library is yours to build, and a first-time user does not assume that (STATE.md
         decision 61). Both ways in are offered here, and the line drawn is „no recipe search,
         no guessed calories" — never „no recipes from the internet", which would talk the user
         out of the import that exists. -->
    <div class="mt-6 rounded-xl border border-dashed border-(--color-border) p-6 text-center">
      <p class="text-sm">Biblioteka jest pusta. To Twoje przepisy — zbierasz je sam.</p>
      <div class="flex flex-wrap justify-center gap-2 pt-4">
        <a
          class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink)"
          href="#/recipes/new/edit"
        >
          Nowy przepis
        </a>
        <a
          class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium"
          href="#/recipes/new/edit?import"
        >
          Wklej przepis z internetu
        </a>
      </div>
      <p class="pt-4 text-sm text-(--color-ink-muted)">
        Przepis z bloga wklejasz jako link albo jako tekst, a aplikacja rozkłada go na
        składniki. Nie szuka za Ciebie przepisów w sieci i nie zgaduje kalorii: wartości
        odżywcze bierze wyłącznie z lokalnej bazy USDA, żeby ten sam posiłek zawsze liczył się
        tak samo.
      </p>
    </div>
  {:else if visible.length === 0}
    <p class="pt-6 text-sm text-(--color-ink-muted)">Nic nie pasuje do tych kryteriów.</p>
  {:else if grouped}
    <!-- A recipe with several tags is listed under each of them, so the counts add up to more
         than the library holds. That is intended — PLAN.md Phase 9 task 1. -->
    <div class="flex flex-col gap-6 pt-4">
      {#each groups as group (group.key)}
        <section>
          <h2 class="pb-2 text-sm font-semibold text-(--color-ink-muted)">
            {group.label} ({group.entries.length})
          </h2>
          <ul class="flex flex-col gap-2">
            {#each group.entries as entry (entry.recipe.id)}
              {@render card(entry)}
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {:else}
    <ul class="flex flex-col gap-2 pt-4">
      {#each visible as entry (entry.recipe.id)}
        {@render card(entry)}
      {/each}
    </ul>
  {/if}
</Screen>
