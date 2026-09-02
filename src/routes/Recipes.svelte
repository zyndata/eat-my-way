<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import type { Macros, Tag } from '../lib/types';
  import type { RecipeListEntry } from '../lib/recipes';
  import { searchRecipes } from '../lib/recipes';
  import { pluralPl } from '../lib/text';
  import { todayDate } from '../lib/dates';
  import { repository } from '../lib/repository';

  /**
   * Recipe library: search over the names, tag chips that narrow the list, and the default
   * order from STATE.md decision 46 — most recently edited or planned first.
   *
   * Everything is read from IndexedDB once when the screen mounts; filtering and ranking
   * then happen in memory, so typing never waits on a database round trip.
   */

  let entries = $state<RecipeListEntry[]>([]);
  let tags = $state<Tag[]>([]);
  let macros = $state(new Map<string, Macros>());
  let loading = $state(true);

  let query = $state('');
  let selected = $state<string[]>([]);

  const visible = $derived(searchRecipes(entries, query, selected));
  /** Only tags that some recipe actually carries are worth offering as a chip. */
  const chips = $derived(tags.filter((tag) => entries.some((entry) => entry.recipe.tags.includes(tag.key))));

  async function load(): Promise<void> {
    loading = true;
    const [library, allTags] = await Promise.all([
      repository.recipeLibrary(todayDate()),
      repository.allTags()
    ]);
    entries = library;
    tags = allTags;
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

  void load();
</script>

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
  {:else}
    <ul class="flex flex-col gap-2 pt-4">
      {#each visible as entry (entry.recipe.id)}
        {@const portion = macros.get(entry.recipe.id)}
        <li>
          <a
            class="block rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3"
            href="#/recipes/{entry.recipe.id}/edit"
          >
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
        </li>
      {/each}
    </ul>
  {/if}
</Screen>
