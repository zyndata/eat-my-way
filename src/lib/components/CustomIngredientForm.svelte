<script lang="ts">
  import type { Ingredient } from '../types';
  import type { IngredientDraft } from '../custom-ingredients';
  import { draftProblem, draftToIngredient, emptyIngredientDraft } from '../custom-ingredients';

  /**
   * The one form for a `custom:*` ingredient. Values are per 100 g, like every other
   * ingredient in the database (STATE.md decision 53). The form only *builds* the ingredient —
   * the caller persists it and invalidates the search index.
   *
   * It is used from two places and belongs to neither: the recipe editor opens it inline when
   * the autocomplete finds nothing, and „Składniki" opens it in a bottom sheet to create, to
   * edit, and to copy a bundled row. That is why the draft comes in as a prop rather than
   * being assembled here.
   *
   * Phase 10 changed one rule: **every macro must be entered, and `0` counts as entered.** The
   * old form mapped an untouched field to `0`, so an ingredient saved „to finish later" read
   * as 0 kcal in every recipe using it and nothing ever said so (decision 178). The reason is
   * always printed next to the disabled button — „the button is grey" is not an answer.
   */

  let {
    initialName = '',
    initial,
    editingId,
    heading = 'Nowy własny składnik',
    submitLabel = 'Zapisz składnik',
    framed = true,
    onsave,
    oncancel
  }: {
    /** Seed for a brand-new ingredient — the text the user had typed into the autocomplete. */
    initialName?: string;
    /** A whole draft to start from: an existing ingredient, or a copy of a bundled one. */
    initial?: IngredientDraft;
    /** Set when editing: the id the saved ingredient keeps. Absent means a fresh id. */
    editingId?: string;
    heading?: string;
    submitLabel?: string;
    /** The recipe editor renders the form as a card of its own; a sheet supplies its own. */
    framed?: boolean;
    onsave: (ingredient: Ingredient) => void;
    oncancel: () => void;
  } = $props();

  // The form is created fresh for each row and for each sheet, so seeding once is the point.
  // svelte-ignore state_referenced_locally
  let draft = $state<IngredientDraft>(initial ?? emptyIngredientDraft(initialName));

  const problem = $derived(draftProblem(draft));

  const fieldClass =
    'mt-1 w-full rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-base font-normal outline-none focus:border-(--color-accent)';

  function save(): void {
    if (problem !== null) return;
    onsave(draftToIngredient(draft, editingId === undefined ? {} : { id: editingId }));
  }
</script>

<div
  id="custom-ingredient-form"
  class={framed ? 'rounded-xl border border-(--color-border) bg-(--color-surface) p-3' : ''}
>
  {#if heading !== ''}
    <h3 class="text-sm font-semibold">{heading}</h3>
  {/if}
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Wartości podaj na 100 g. Składnik zapisujemy lokalnie i synchronizujemy z Dyskiem, więc
    będzie dostępny w innych przepisach i na innych urządzeniach.
  </p>

  <div class="grid gap-3 pt-3 sm:grid-cols-2">
    <label class="block text-sm font-medium">
      Nazwa
      <input class={fieldClass} type="text" bind:value={draft.name} />
    </label>

    <label class="block text-sm font-medium">
      Postać
      <select class={fieldClass} bind:value={draft.state}>
        <option value="raw">surowy</option>
        <option value="cooked">po ugotowaniu</option>
      </select>
    </label>
  </div>

  <div class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
    <label class="block text-sm font-medium">
      kcal
      <input
        class={fieldClass}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.kcal}
      />
    </label>
    <label class="block text-sm font-medium">
      Białko (g)
      <input
        class={fieldClass}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.protein}
      />
    </label>
    <label class="block text-sm font-medium">
      Węgl. (g)
      <input
        class={fieldClass}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.carbs}
      />
    </label>
    <label class="block text-sm font-medium">
      Tłuszcz (g)
      <input
        class={fieldClass}
        type="number"
        inputmode="decimal"
        min="0"
        step="any"
        bind:value={draft.fat}
      />
    </label>
  </div>

  <!-- Aliases were indexed from schema v2 on and until now had no way of ever being filled.
       They widen both the autocomplete and Gemini's ingredient matching. -->
  <label class="block pt-3 text-sm font-medium">
    Inne nazwy
    <input
      class={fieldClass}
      type="text"
      placeholder="np. twarożek, twarog chudy"
      bind:value={draft.aliases}
    />
  </label>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Oddziel przecinkami. Po tych nazwach też znajdziesz składnik w wyszukiwarce, a import
    przepisu łatwiej go dopasuje.
  </p>

  <div class="flex flex-wrap gap-2 pt-4">
    <button
      type="button"
      class="rounded-lg bg-(--color-accent) px-3 py-2 text-sm font-medium text-(--color-accent-ink) disabled:opacity-50"
      disabled={problem !== null}
      onclick={save}
    >
      {submitLabel}
    </button>
    <button
      type="button"
      class="rounded-lg border border-(--color-border) px-3 py-2 text-sm font-medium"
      onclick={oncancel}
    >
      Anuluj
    </button>
  </div>

  {#if problem !== null}
    <p class="pt-2 text-xs text-(--color-ink-muted)">{problem}</p>
  {/if}
</div>
