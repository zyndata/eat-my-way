<script lang="ts">
  import Screen from '../lib/components/Screen.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import CustomIngredientForm from '../lib/components/CustomIngredientForm.svelte';
  import IngredientAutocomplete from '../lib/components/IngredientAutocomplete.svelte';
  import type { Ingredient } from '../lib/types';
  import type { IngredientReferences, IngredientSearchEntry } from '../lib/repository';
  import { repository } from '../lib/repository';
  import { rankCandidates } from '../lib/search';
  import {
    IngredientInUseError,
    draftForCopy,
    draftFromIngredient,
    macrosDiffer,
    type IngredientDraft
  } from '../lib/custom-ingredients';
  import { ingredientIndex } from '../lib/ingredients';
  import { scanPackage } from '../lib/gemini/scan-run';
  import { scheduleSync, syncState } from '../lib/sync/state.svelte';
  import { todayDate } from '../lib/dates';
  import { pluralPl } from '../lib/text';
  import { nutritionStatus } from '../lib/nutrition/status.svelte';

  /**
   * „Składniki" — the user's own ingredients, at last visible (PLAN.md Phase 10).
   *
   * Custom rows have existed since Phase 3, but could only ever be *created*, blind, from an
   * empty autocomplete inside the recipe editor. A name typed wrong was permanent and polluted
   * every later search; a wrong value could only be worked around with a `macroOverride`
   * repeated in every recipe using it; `aliases` had no way of ever being filled.
   *
   * Three rules run through everything here:
   *
   * - **Editing is for `custom:*` rows.** The bundled base is shown read-only behind a toggle,
   *   with „Kopiuj i edytuj" as its one action. An edited `usda:*` row would be overwritten by
   *   the next data refresh and would never reach another device (STATE.md decision 176).
   * - **No operation changes a number without saying so.** A planned meal holds a frozen
   *   `macroSnapshot`, so anything that moves a recipe's per-portion macros raises the same
   *   „zaktualizować przyszłe dni?" question a recipe edit raises (decision 179).
   * - **Deleting is either free or a replacement.** An item pointing at a missing id falls
   *   back to `ZERO_MACROS`, so a silent delete would drop a recipe's numbers (decision 180).
   *
   * The list, the counts and the ranking all come from `ingredientSearchIndex()` and
   * `rankCandidates` — the very data and the very order the autocomplete uses, so the two
   * screens can never disagree about what exists or how much it is used.
   */

  /** The bundled base is ~1300 rows; a phone renders a page of them, not all of them. */
  const BUNDLED_LIMIT = 50;

  let entries = $state<IngredientSearchEntry[]>([]);
  let loading = $state(true);
  let query = $state('');
  let showBundled = $state(false);
  let busy = $state(false);

  /** The open editing sheet. `null` when nothing is being created or edited. */
  let sheet = $state<{
    title: string;
    submitLabel: string;
    draft: IngredientDraft;
    /** Set when editing an existing row; absent when creating or copying. */
    editingId?: string;
    /** The values before the edit, so „did the macros move?" can be answered. */
    before?: Ingredient;
  } | null>(null);

  /** The ingredient „Usuń" was pressed on, together with what stands in the way. */
  let removing = $state<{ ingredient: Ingredient; references: IngredientReferences } | null>(null);
  let replacement = $state<Ingredient | null>(null);
  let replaceError = $state('');

  /**
   * The „update future days?" question. The recipe ids are a plain array and not `$state`:
   * nothing renders them, and every value that reaches the repository is better off not being
   * a state proxy (STATE.md decision 56).
   */
  let pendingRecipes: string[] = [];
  let pendingFuture = $state(0);

  const ranked = $derived(rankCandidates(query, entries, -1));
  const mine = $derived(ranked.filter((match) => match.item.ingredient.source === 'custom'));
  const bundled = $derived(
    showBundled ? ranked.filter((match) => match.item.ingredient.source !== 'custom') : []
  );
  const customCount = $derived(
    entries.filter((entry) => entry.ingredient.source === 'custom').length
  );

  async function load(): Promise<void> {
    loading = true;
    entries = await repository.ingredientSearchIndex();
    loading = false;
  }

  /** Every write invalidates the autocomplete's in-memory snapshot — STATE.md decision 39. */
  async function afterWrite(): Promise<void> {
    ingredientIndex.invalidate();
    scheduleSync();
    await load();
  }

  function openNew(): void {
    sheet = {
      title: 'Nowy składnik',
      submitLabel: 'Zapisz składnik',
      draft: { name: query.trim(), state: 'raw', aliases: '', kcal: null, protein: null, carbs: null, fat: null }
    };
  }

  function openEdit(ingredient: Ingredient): void {
    sheet = {
      title: 'Edytuj składnik',
      submitLabel: 'Zapisz zmiany',
      draft: draftFromIngredient(ingredient),
      editingId: ingredient.id,
      before: ingredient
    };
  }

  /** „Kopiuj i edytuj" on a bundled row: a new `custom:*` id, and no aliases (decision 177). */
  function openCopy(ingredient: Ingredient): void {
    sheet = {
      title: 'Kopiuj składnik z bazy',
      submitLabel: 'Zapisz jako własny',
      draft: draftForCopy(ingredient)
    };
  }

  async function saveIngredient(ingredient: Ingredient): Promise<void> {
    const before = sheet?.before;
    sheet = null;
    busy = true;
    try {
      await repository.saveCustomIngredient(ingredient);
      await afterWrite();
      // Only a change to the four values can move a recipe's macros. A new name, a different
      // `state` or an added alias moves nothing and asks nothing.
      if (before !== undefined && macrosDiffer(before.per100g, ingredient.per100g)) {
        await askAboutFuture(ingredient.id);
      }
    } finally {
      busy = false;
    }
  }

  /** Offer „update future days" for every recipe that uses this ingredient. */
  async function askAboutFuture(ingredientId: string): Promise<void> {
    const references = await repository.ingredientReferences(ingredientId, todayDate());
    if (references.future === 0) return;
    pendingRecipes = references.recipes.map((recipe) => recipe.id);
    pendingFuture = references.future;
  }

  /**
   * Both answers leave the ingredient saved; only „Tak" carries the new macros into days from
   * today onwards. Days before today are never read for writing — `refreshFutureSnapshots`
   * starts at `fromDate`, so history cannot move either way.
   */
  async function answer(updateFuture: boolean): Promise<void> {
    const recipes = pendingRecipes;
    pendingRecipes = [];
    pendingFuture = 0;
    if (!updateFuture || recipes.length === 0) return;

    busy = true;
    try {
      const today = todayDate();
      for (const recipeId of recipes) await repository.refreshFutureSnapshots(recipeId, today);
      scheduleSync();
    } finally {
      busy = false;
    }
  }

  async function startRemove(ingredient: Ingredient): Promise<void> {
    replacement = null;
    replaceError = '';
    const references = await repository.ingredientReferences(ingredient.id, todayDate());
    removing = { ingredient, references };
  }

  /** Nothing uses it: one confirmation and it is gone, corrections included. */
  async function confirmRemove(): Promise<void> {
    const target = removing;
    removing = null;
    if (target === null) return;

    busy = true;
    try {
      await repository.deleteIngredient(target.ingredient.id);
      await afterWrite();
    } catch (cause) {
      // The repository refuses a delete the UI thought was free — a recipe gained a use of it
      // in another tab. Re-open the dialog on what is true now rather than reporting nothing.
      if (cause instanceof IngredientInUseError) await startRemove(target.ingredient);
      else throw cause;
    } finally {
      busy = false;
    }
  }

  /**
   * „Zastąp innym składnikiem": one transaction rewrites every item, repoints every correction
   * and deletes the old row. The affected recipes are the ones that used the *old* ingredient,
   * which is exactly what was counted before the swap — so the question that follows is asked
   * about those, and not about recipes that already used the replacement.
   */
  async function confirmReplace(): Promise<void> {
    const target = removing;
    const into = replacement;
    if (target === null || into === null) return;

    const affected = target.references.recipes.map((recipe) => recipe.id);
    const future = target.references.future;
    removing = null;
    replacement = null;

    busy = true;
    try {
      await repository.replaceIngredient(target.ingredient.id, into.id);
      await afterWrite();
      if (future > 0) {
        pendingRecipes = affected;
        pendingFuture = future;
      }
    } finally {
      busy = false;
    }
  }

  function chooseReplacement(ingredient: Ingredient): void {
    if (removing !== null && ingredient.id === removing.ingredient.id) {
      replaceError = 'Wybierz inny składnik niż ten, który usuwasz.';
      return;
    }
    replaceError = '';
    replacement = ingredient;
  }

  /**
   * Read once, and again when the first-run import lands. Opening this screen while the
   * bundled base is still being written would otherwise show it as empty until the user
   * navigated away and back — the one moment a new user is most likely to be looking.
   */
  $effect(() => {
    syncState.dataVersion;
    if (nutritionStatus.phase === 'importing') return;
    void load();
  });
</script>

{#snippet macroLine(ingredient: Ingredient, useCount: number)}
  <span class="block pt-1 text-xs text-(--color-ink-muted)">
    {Math.round(ingredient.per100g.kcal)} kcal / 100 g ·
    B {ingredient.per100g.protein.toFixed(1)} · W {ingredient.per100g.carbs.toFixed(1)} · T
    {ingredient.per100g.fat.toFixed(1)} ·
    {ingredient.state === 'cooked' ? 'po ugotowaniu' : 'surowy'}
    {#if useCount > 0}
      · używany w {useCount}
      {pluralPl(useCount, { one: 'przepisie', few: 'przepisach', many: 'przepisach' })}
    {:else}
      · nieużywany
    {/if}
  </span>
{/snippet}

<Screen
  title="Składniki"
  lead="Twoje własne składniki: wartości na 100 g, nazwy zapasowe i to, ile przepisów ich używa."
>
  <div class="flex flex-wrap items-center gap-2">
    <label class="min-w-0 flex-1 text-sm font-medium">
      <span class="sr-only">Szukaj składnika</span>
      <input
        class="w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
        type="search"
        placeholder="Szukaj składnika…"
        bind:value={query}
      />
    </label>
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink)"
      onclick={openNew}
    >
      Nowy składnik
    </button>
  </div>

  {#if loading}
    <p class="pt-6 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else}
    <section class="pt-4">
      <h2 class="text-sm font-semibold text-(--color-ink-muted)">
        Moje składniki ({customCount})
      </h2>

      {#if customCount === 0}
        <div class="mt-2 rounded-xl border border-dashed border-(--color-border) p-6 text-center">
          <p class="text-sm">Nie masz jeszcze własnych składników.</p>
          <p class="pt-2 text-sm text-(--color-ink-muted)">
            Dodajesz je, gdy w bazie czegoś brakuje albo gdy Twój produkt ma inne wartości niż
            ten z bazy. Możesz też skopiować pozycję z bazy i poprawić jej wartości.
          </p>
        </div>
      {:else if mine.length === 0}
        <p class="pt-2 text-sm text-(--color-ink-muted)">Nic nie pasuje do „{query}".</p>
      {:else}
        <ul class="flex flex-col gap-2 pt-2">
          {#each mine as match (match.item.ingredient.id)}
            {@const ingredient = match.item.ingredient}
            <li class="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
              <span class="font-medium">{ingredient.name}</span>
              {@render macroLine(ingredient, match.item.useCount)}
              {#if ingredient.aliases.length > 0}
                <span class="block pt-1 text-xs text-(--color-ink-muted)">
                  Inne nazwy: {ingredient.aliases.join(', ')}
                </span>
              {/if}
              <div class="flex flex-wrap justify-end gap-3 pt-2">
                <button
                  type="button"
                  class="text-xs font-medium text-(--color-accent) disabled:opacity-50"
                  disabled={busy}
                  onclick={() => openEdit(ingredient)}
                >
                  Edytuj
                </button>
                <button
                  type="button"
                  class="text-xs font-medium text-(--color-danger) disabled:opacity-50"
                  disabled={busy}
                  onclick={() => void startRemove(ingredient)}
                >
                  Usuń
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="pt-6">
      <button
        type="button"
        class="rounded-full border px-3 py-1 text-sm {showBundled
          ? 'border-(--color-accent) bg-(--color-accent) text-(--color-accent-ink)'
          : 'border-(--color-border) text-(--color-ink-muted)'}"
        aria-pressed={showBundled}
        onclick={() => (showBundled = !showBundled)}
      >
        Pokaż składniki z bazy
      </button>

      {#if showBundled}
        <p class="pt-2 text-xs text-(--color-ink-muted)">
          Wbudowanej bazy nie da się zmienić: przy każdej aktualizacji aplikacji wczytujemy ją od
          nowa, więc poprawka i tak by zniknęła, a na innych urządzeniach nigdy by się nie
          pojawiła. Jeśli Twój produkt ma inne wartości — skopiuj pozycję i popraw kopię.
        </p>

        {#if bundled.length === 0}
          <p class="pt-3 text-sm text-(--color-ink-muted)">Nic nie pasuje do „{query}".</p>
        {:else}
          <ul class="flex flex-col gap-2 pt-3">
            {#each bundled.slice(0, BUNDLED_LIMIT) as match (match.item.ingredient.id)}
              {@const ingredient = match.item.ingredient}
              <li class="rounded-xl border border-(--color-border) bg-(--color-surface) p-3">
                <span class="font-medium">{ingredient.name}</span>
                {@render macroLine(ingredient, match.item.useCount)}
                <div class="flex justify-end pt-2">
                  <button
                    type="button"
                    class="text-xs font-medium text-(--color-accent) disabled:opacity-50"
                    disabled={busy}
                    onclick={() => openCopy(ingredient)}
                  >
                    Kopiuj i edytuj
                  </button>
                </div>
              </li>
            {/each}
          </ul>
          {#if bundled.length > BUNDLED_LIMIT}
            <p class="pt-3 text-sm text-(--color-ink-muted)">
              Pokazujemy pierwsze {BUNDLED_LIMIT} z {bundled.length} pasujących pozycji. Wpisz
              więcej liter, żeby zawęzić listę.
            </p>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}
</Screen>

<!-- Editing one ingredient is a short form with nothing to deep-link to, so it lives in a
     sheet over the list rather than in a route of its own (STATE.md decision 183). -->
<BottomSheet open={sheet !== null} title={sheet?.title ?? ''} onclose={() => (sheet = null)}>
  {#if sheet !== null}
    <CustomIngredientForm
      initial={sheet.draft}
      {...sheet.editingId === undefined ? {} : { editingId: sheet.editingId }}
      heading=""
      framed={false}
      submitLabel={sheet.submitLabel}
      onscan={scanPackage}
      onsave={(ingredient) => void saveIngredient(ingredient)}
      oncancel={() => (sheet = null)}
    />
  {/if}
</BottomSheet>

<!-- Nothing uses it: one confirmation. -->
<ConfirmDialog
  open={removing !== null && removing.references.recipes.length === 0}
  title="Usunąć składnik?"
  confirmLabel="Usuń"
  danger
  onconfirm={() => void confirmRemove()}
  oncancel={() => (removing = null)}
>
  {#if removing !== null}
    „{removing.ingredient.name}" nie jest używany w żadnym przepisie. Usuniemy też zapamiętane
    dopasowania nazw, które na niego wskazywały.
  {/if}
</ConfirmDialog>

<!-- Something uses it: the only way out is a replacement, and every recipe is named. -->
<BottomSheet
  open={removing !== null && removing.references.recipes.length > 0}
  title="Ten składnik jest używany"
  onclose={() => (removing = null)}
>
  {#if removing !== null}
    {@const references = removing.references}
    <p class="text-sm">
      „{removing.ingredient.name}" jest używany w {references.recipes.length}
      {pluralPl(references.recipes.length, {
        one: 'przepisie',
        few: 'przepisach',
        many: 'przepisach'
      })}. Samo usunięcie wyzerowałoby ich wartości odżywcze bez słowa, więc najpierw wskaż, czym
      go zastąpić.
    </p>

    <ul class="flex flex-col gap-1 pt-3">
      {#each references.recipes as recipe (recipe.id)}
        <li>
          <a class="text-sm font-medium text-(--color-accent) underline" href="#/recipes/{recipe.id}/edit">
            {recipe.name}
          </a>
        </li>
      {/each}
    </ul>

    <div class="pt-4">
      <IngredientAutocomplete
        id="replacement-ingredient"
        label="Zastąp składnikiem"
        flow
        onselect={chooseReplacement}
      />
    </div>

    {#if replaceError !== ''}
      <p class="pt-2 text-sm text-(--color-danger)" role="alert">{replaceError}</p>
    {/if}

    {#if replacement !== null}
      <p class="pt-2 text-sm text-(--color-ink-muted)">
        Wybrano: <span class="font-medium text-(--color-ink)">{replacement.name}</span>. Ilości,
        jednostki i ręczne poprawki w przepisach zostaną bez zmian — zmieni się tylko sam
        składnik.
      </p>
    {/if}

    <div class="flex flex-wrap gap-2 pt-4">
      <button
        type="button"
        class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
        disabled={replacement === null || busy}
        onclick={() => void confirmReplace()}
      >
        Zastąp i usuń
      </button>
      <button
        type="button"
        class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
        onclick={() => (removing = null)}
      >
        Anuluj
      </button>
    </div>
  {/if}
</BottomSheet>

<ConfirmDialog
  open={pendingFuture > 0}
  title="Zaktualizować zaplanowane dni?"
  confirmLabel="Tak, zaktualizuj"
  cancelLabel="Nie, zostaw bez zmian"
  onconfirm={() => void answer(true)}
  oncancel={() => void answer(false)}
>
  Zmiana wartości tego składnika zmienia makroskładniki przepisów, które go używają. Te przepisy
  są zaplanowane na {pendingFuture}
  {pluralPl(pendingFuture, { one: 'posiłek', few: 'posiłki', many: 'posiłków' })} od dzisiaj w
  przód. Dni z przeszłości pozostaną nietknięte niezależnie od wyboru.
</ConfirmDialog>
