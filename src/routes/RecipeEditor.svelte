<script lang="ts">
  import { push } from 'svelte-spa-router';
  import Screen from '../lib/components/Screen.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import CustomIngredientForm from '../lib/components/CustomIngredientForm.svelte';
  import RecipeImportSheet from '../lib/components/RecipeImportSheet.svelte';
  import RecipeItemRow from '../lib/components/RecipeItemRow.svelte';
  import TagInput from '../lib/components/TagInput.svelte';
  import type { Ingredient, Recipe, Tag } from '../lib/types';
  import type { RecipeDraft } from '../lib/recipes';
  import {
    canSaveDraft,
    draftFromRecipe,
    draftMacros,
    draftToRecipe,
    emptyDraft,
    emptyDraftItem,
    incompleteDrafts
  } from '../lib/recipes';
  import type { RecipeReferences } from '../lib/repository';
  import { repository } from '../lib/repository';
  import { scheduleSync } from '../lib/sync/state.svelte';
  import { ingredientIndex } from '../lib/ingredients';
  import { newId } from '../lib/ids';
  import { todayDate } from '../lib/dates';
  import { nutritionStatus } from '../lib/nutrition/status.svelte';
  import { rememberCorrection, type ImportedRecipe } from '../lib/gemini/import';

  /**
   * Recipe editor. Items are always the amounts for exactly one portion (PLAN.md task 3).
   *
   * Saving a recipe that future days already plan asks whether those days' frozen
   * `macroSnapshot`s should follow the edit; days in the past are never offered and never
   * written (STATE.md decisions 49-50).
   */

  /** Sentinel route segment for "this recipe does not exist yet" — STATE.md decision 45. */
  const NEW = 'new';

  let { params }: { params?: Record<string, string | undefined> } = $props();
  const routeId = $derived(params?.id ?? NEW);

  let loading = $state(true);
  let notFound = $state(false);
  let saving = $state(false);
  /** The stored recipe being edited; `undefined` while creating a new one. */
  let existing = $state<Recipe | undefined>(undefined);
  let draft = $state<RecipeDraft>(emptyDraft());
  let tags = $state<Tag[]>([]);
  let ingredientsById = $state<Record<string, Ingredient>>({});
  let references = $state<RecipeReferences>({ past: 0, future: 0, total: 0 });

  /** Row waiting for a hand-written ingredient, and the name the user had typed. */
  let customRowKey = $state<string | null>(null);
  let customName = $state('');

  /**
   * The recipe waiting on the "update future days?" answer. Deliberately a plain variable
   * and NOT `$state`: a Svelte state proxy cannot be structured-cloned, so a recipe that
   * had passed through one would fail `IDBObjectStore.put` with `DataCloneError`. Only the
   * meal count the dialog displays needs to be reactive.
   */
  let pendingRecipe: Recipe | null = null;
  let pendingFuture = $state(0);
  let deleteOpen = $state(false);

  let importOpen = $state(false);
  /** Set once an import has landed, so the editor can explain what it did. */
  let imported = $state(false);
  let importedUnmatched = $state(0);
  let importedPortions = $state(1);

  let rowCounter = 0;
  const nextKey = (): string => `row-${++rowCounter}`;

  const lookup = (id: string): Ingredient | undefined => ingredientsById[id];
  const sum = $derived(draftMacros(draft.items, lookup));
  const incomplete = $derived(incompleteDrafts(draft.items));
  const canSave = $derived(canSaveDraft(draft) && !saving);

  async function load(id: string): Promise<void> {
    loading = true;
    notFound = false;

    const allTags = await repository.allTags();
    tags = allTags;

    if (id === NEW) {
      existing = undefined;
      draft = emptyDraft();
      ingredientsById = {};
      references = { past: 0, future: 0, total: 0 };
      loading = false;
      return;
    }

    const recipe = await repository.getRecipe(id);
    if (recipe === undefined) {
      notFound = true;
      loading = false;
      return;
    }

    existing = recipe;
    // Tags are stored as keys; the editor shows the label the user first typed.
    const labels = recipe.tags.map((key) => allTags.find((tag) => tag.key === key)?.label ?? key);
    draft = draftFromRecipe(recipe, labels, nextKey);

    const used = await repository.ingredientsByIds(recipe.items.map((item) => item.ingredientId));
    ingredientsById = Object.fromEntries(used.map((ingredient) => [ingredient.id, ingredient]));
    references = await repository.recipeReferences(recipe.id, todayDate());
    loading = false;
  }

  $effect(() => {
    void load(routeId);
  });

  function addRow(): void {
    draft.items = [...draft.items, emptyDraftItem(nextKey())];
  }

  function removeRow(key: string): void {
    draft.items = draft.items.filter((item) => item.key !== key);
    if (customRowKey === key) customRowKey = null;
  }

  function pick(key: string, ingredient: Ingredient): void {
    ingredientsById[ingredient.id] = ingredient;
    const row = draft.items.find((item) => item.key === key);
    if (row === undefined) return;
    row.ingredientId = ingredient.id;
    // A fresh pick starts from the database values, never from a previous row's override.
    row.macroOverride = null;

    // A row that came from an import carries the name the model produced. Picking on it — to
    // fix a wrong match or to fill one it could not make — is the user saying what that name
    // means, so it is stored and the next import matches it by lookup (STATE.md decision 116).
    if (row.sourceName !== null) {
      void rememberCorrection(row.sourceName, ingredient.id).then(() => scheduleSync());
    }
  }

  /**
   * Land an import in the open editor. Rows are appended rather than replacing what is there:
   * importing into a half-typed recipe must never throw work away. The name and the
   * instructions only fill blanks, for the same reason.
   */
  function applyImport(result: ImportedRecipe): void {
    importOpen = false;
    ingredientsById = { ...ingredientsById, ...result.ingredientsById };
    draft.items = [...draft.items, ...result.items];
    if (draft.name.trim() === '' && result.name !== '') draft.name = result.name;
    if (draft.instructions.trim() === '') draft.instructions = result.instructions;
    importedUnmatched = result.unmatched;
    importedPortions = result.sourcePortions;
    imported = true;
  }

  async function saveCustomIngredient(key: string, ingredient: Ingredient): Promise<void> {
    await repository.putIngredient(ingredient);
    scheduleSync();
    // The autocomplete keeps an in-memory snapshot — see STATE.md decision 39.
    ingredientIndex.invalidate();
    pick(key, ingredient);
    customRowKey = null;
  }

  /** Write the recipe, optionally carrying the new macros into days from today onwards. */
  async function commit(recipe: Recipe, updateFuture: boolean): Promise<void> {
    saving = true;
    try {
      await repository.saveRecipe(recipe, draft.tagLabels);
      if (updateFuture) await repository.refreshFutureSnapshots(recipe.id, todayDate());
      // `useCount` in the ingredient autocomplete is derived from the recipes.
      ingredientIndex.invalidate();
      scheduleSync();
      push('#/recipes');
    } finally {
      saving = false;
    }
  }

  async function save(): Promise<void> {
    if (!canSave) return;

    const id = existing?.id ?? newId();
    const recipe = draftToRecipe(draft, {
      id,
      createdAt: existing?.createdAt,
      now: new Date().toISOString()
    });

    // Only ask when there is something the answer could change (STATE.md decision 50).
    const counts =
      existing === undefined
        ? { past: 0, future: 0, total: 0 }
        : await repository.recipeReferences(id, todayDate());

    if (counts.future > 0) {
      pendingRecipe = recipe;
      pendingFuture = counts.future;
      return;
    }
    await commit(recipe, false);
  }

  /** Both answers save; only "yes" carries the new macros into days from today onwards. */
  function answer(updateFuture: boolean): void {
    const recipe = pendingRecipe;
    pendingRecipe = null;
    pendingFuture = 0;
    if (recipe !== null) void commit(recipe, updateFuture);
  }

  async function confirmDelete(): Promise<void> {
    deleteOpen = false;
    if (existing === undefined) return;
    await repository.deleteRecipe(existing.id);
    ingredientIndex.invalidate();
    scheduleSync();
    push('#/recipes');
  }
</script>

<Screen
  title={existing === undefined ? 'Nowy przepis' : 'Edytuj przepis'}
  lead="Składniki podajesz na 1 porcję. Ilość ugotowanego jedzenia ustawisz przy planowaniu dnia."
>
  {#if loading}
    <p class="text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else if notFound}
    <p class="text-sm text-(--color-ink-muted)">
      Nie znaleziono takiego przepisu.
      <a class="font-medium text-(--color-accent) underline" href="#/recipes">Wróć do biblioteki</a>.
    </p>
  {:else}
    <div class="flex flex-col gap-5">
      <label class="block text-sm font-medium">
        Nazwa
        <input
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
          type="text"
          placeholder="np. Owsianka z bananem"
          bind:value={draft.name}
        />
      </label>

      <TagInput bind:labels={draft.tagLabels} {tags} />

      <!-- Import creates a recipe; it does not edit one. On an existing recipe the button only
           appended rows to something already written, which duplicates ingredients and then
           offers to rewrite every future day's macros (STATE.md decision 132). -->
      {#if existing === undefined}
      <div>
        <button
          type="button"
          class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
          onclick={() => (importOpen = true)}
        >
          Wklej przepis z internetu
        </button>
        {#if imported}
          <p class="pt-1 text-xs text-(--color-ink-muted)">
            Przepis wczytany.
            {#if importedPortions > 1}
              Ilości podzielone z {importedPortions} porcji na jedną.
            {/if}
            {#if importedUnmatched > 0}
              {importedUnmatched}
              {importedUnmatched === 1 ? 'składnika nie udało się' : 'składników nie udało się'}
              dopasować do bazy — wybierz je ręcznie, a przy następnym imporcie dopasują się same.
            {/if}
            Sprawdź wszystko i dopiero wtedy zapisz.
          </p>
        {:else}
          <p class="pt-1 text-xs text-(--color-ink-muted)">
            Wklej link albo treść przepisu — Gemini rozpisze składniki, kalorie policzymy sami.
          </p>
        {/if}
      </div>
      {/if}

      <section>
        <h2 class="text-base font-semibold">Składniki na 1 porcję</h2>
        {#if nutritionStatus.phase === 'importing'}
          <p class="pt-1 text-sm text-(--color-ink-muted)">Trwa wczytywanie bazy składników…</p>
        {:else if nutritionStatus.phase === 'failed'}
          <p class="pt-1 text-sm text-(--color-ink-muted)">{nutritionStatus.message}</p>
        {/if}

        {#if draft.items.length === 0}
          <p class="pt-1 text-sm text-(--color-ink-muted)">
            Brak składników. Dodaj pierwszy — podpowiedzi pochodzą z lokalnej bazy i działają
            bez internetu.
          </p>
        {/if}

        <ul class="flex flex-col gap-3 pt-3">
          {#each draft.items as item, index (item.key)}
            {#if customRowKey === item.key}
              <li>
                <CustomIngredientForm
                  initialName={customName}
                  onsave={(ingredient) => void saveCustomIngredient(item.key, ingredient)}
                  oncancel={() => (customRowKey = null)}
                />
              </li>
            {:else}
              <RecipeItemRow
                {item}
                position={index + 1}
                ingredient={lookup(item.ingredientId)}
                onpick={(ingredient) => pick(item.key, ingredient)}
                onclear={() => (item.ingredientId = '')}
                onremove={() => removeRow(item.key)}
                oncreate={(query) => {
                  customName = query;
                  customRowKey = item.key;
                }}
              />
            {/if}
          {/each}
        </ul>

        <button
          type="button"
          class="mt-3 rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
          onclick={addRow}
        >
          Dodaj składnik
        </button>
      </section>

      <section class="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3">
        <h2 class="text-sm font-semibold">Makroskładniki 1 porcji</h2>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-sm sm:grid-cols-4">
          <dt class="text-(--color-ink-muted)">Kalorie</dt>
          <dd class="font-medium">{Math.round(sum.kcal)} kcal</dd>
          <dt class="text-(--color-ink-muted)">Białko</dt>
          <dd class="font-medium">{sum.protein.toFixed(1)} g</dd>
          <dt class="text-(--color-ink-muted)">Węglowodany</dt>
          <dd class="font-medium">{sum.carbs.toFixed(1)} g</dd>
          <dt class="text-(--color-ink-muted)">Tłuszcz</dt>
          <dd class="font-medium">{sum.fat.toFixed(1)} g</dd>
        </dl>
        {#if incomplete.length > 0}
          <p class="pt-2 text-xs text-red-700">
            {incomplete.length}
            {incomplete.length === 1 ? 'składnik nie ma' : 'składników nie ma'} podanej wagi 1 szt.
            — {incomplete.length === 1 ? 'nie wlicza się' : 'nie wliczają się'} do sumy.
          </p>
        {/if}
      </section>

      <label class="block text-sm font-medium">
        Instrukcje
        <textarea
          class="mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)"
          rows="6"
          placeholder="Jak to ugotować?"
          bind:value={draft.instructions}
        ></textarea>
      </label>

      {#if references.total > 0}
        <p class="text-sm text-(--color-ink-muted)">
          Ten przepis jest zaplanowany {references.total}
          {references.total === 1 ? 'raz' : 'razy'} — w tym {references.future}
          {references.future === 1 ? 'raz' : 'razy'} od dzisiaj. Dni z przeszłości nigdy się nie
          zmieniają.
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
          disabled={!canSave}
          onclick={() => void save()}
        >
          Zapisz przepis
        </button>
        <a class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium" href="#/recipes">
          Anuluj
        </a>
        {#if existing !== undefined}
          <button
            type="button"
            class="ml-auto rounded-lg border border-red-600 px-3 py-2 text-sm font-medium text-red-700"
            onclick={() => (deleteOpen = true)}
          >
            Usuń przepis
          </button>
        {/if}
      </div>

      {#if !canSaveDraft(draft)}
        <p class="text-xs text-(--color-ink-muted)">Przepis musi mieć nazwę.</p>
      {/if}
    </div>
  {/if}
</Screen>

<RecipeImportSheet
  open={importOpen && existing === undefined}
  onclose={() => (importOpen = false)}
  onimport={applyImport}
  {nextKey}
/>

<ConfirmDialog
  open={pendingFuture > 0}
  title="Zaktualizować zaplanowane dni?"
  confirmLabel="Tak, zaktualizuj"
  cancelLabel="Nie, zostaw bez zmian"
  onconfirm={() => answer(true)}
  oncancel={() => answer(false)}
>
  Ten przepis jest zaplanowany na {pendingFuture}
  {pendingFuture === 1 ? 'posiłek' : 'posiłków'} od dzisiaj w przód. Możemy przeliczyć ich
  makroskładniki według nowej wersji przepisu. Dni z przeszłości pozostaną nietknięte niezależnie
  od wyboru.
</ConfirmDialog>

<ConfirmDialog
  open={deleteOpen}
  title="Usunąć przepis?"
  confirmLabel="Usuń"
  danger
  onconfirm={() => void confirmDelete()}
  oncancel={() => (deleteOpen = false)}
>
  {#if references.total > 0}
    Przepis jest użyty w {references.total}
    {references.total === 1 ? 'zaplanowanym posiłku' : 'zaplanowanych posiłkach'}. Te posiłki
    pozostaną w kalendarzu wraz z zapisanymi makroskładnikami — usunięty zostanie tylko sam
    przepis.
  {:else}
    Tej operacji nie można cofnąć.
  {/if}
</ConfirmDialog>
