<script lang="ts">
  import { untrack } from 'svelte';
  import type { Ingredient, RecipeItem } from '../types';
  import { ingredientLookup } from '../macros';
  import { formatRecipeShare, type SharedRecipe } from '../recipe-share';
  import { portionWord } from '../text';
  import { repository } from '../repository';
  import { shareText, type ShareOutcome } from '../share';
  import BottomSheet from './BottomSheet.svelte';
  import NavIcon from './NavIcon.svelte';

  /**
   * „Udostępnij przepis" (PLAN.md Phase 22): one recipe as text, at a number of portions
   * chosen here, out of the app through the share sheet or the clipboard.
   *
   * `MenuSheet`'s twin — the same sheet, the same two ways out, the same fallback of leaving the
   * text on screen when neither works, which is why the text itself is shown and selectable.
   *
   * The caller hands in the rows: the editor passes the stored `recipe.items`, a planned meal
   * passes `effectiveItems` (STATE.md decisions 409 and 410). The names are loaded here, so
   * neither caller has to hold them.
   *
   * The count is this sheet's own and is **never written anywhere** — not back into the meal's
   * „Ile gotuję", and not remembered for the next opening (decisions 410 and 415).
   *
   * Neither route is a network request, so the CSP is untouched (decision 144).
   */

  let {
    open = false,
    recipe,
    items,
    initialPortions,
    onclose
  }: {
    open?: boolean;
    recipe: SharedRecipe;
    /** The rows being cooked, in the order they are printed. */
    items: readonly RecipeItem[];
    /** Where the count starts on every opening: 1 in the editor, the cooking scale on a meal. */
    initialPortions: number;
    onclose: () => void;
  } = $props();

  const MINUS = 'M5 12h14';
  const PLUS = 'M12 5v14M5 12h14';

  let portions = $state(1);
  let loading = $state(false);
  let ingredients = $state<Ingredient[]>([]);
  let outcome = $state<ShareOutcome | null>(null);
  /** Guards against an older load landing after a newer one. */
  let loadToken = 0;

  const lookup = $derived(ingredientLookup(ingredients));
  const text = $derived(formatRecipeShare(recipe, items, portions, lookup));
  const hasInstructions = $derived(recipe.instructions.trim() !== '');

  // Every opening starts over. Untracked, so a reload of the screen behind the sheet — a sync
  // landing on the meal screen — does not snap the count back while it is being chosen.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      portions = initialPortions;
      outcome = null;
    });
  });

  $effect(() => {
    if (!open) return;
    void load(items.map((item) => item.ingredientId).filter((id) => id !== ''));
  });

  async function load(ids: string[]): Promise<void> {
    const token = ++loadToken;
    loading = true;
    const found = await repository.ingredientsByIds(ids);
    if (token !== loadToken) return;
    ingredients = found;
    loading = false;
  }

  /** Any positive number, 1,5 included; anything else leaves the count where it was. */
  function setPortions(value: number): void {
    if (Number.isFinite(value) && value > 0) portions = Math.round(value * 100) / 100;
    // An outcome line describes the text it was about, and that text has just changed.
    outcome = null;
  }

  async function share(): Promise<void> {
    outcome = await shareText(recipe.name, text);
  }
</script>

<BottomSheet {open} title="Udostępnij przepis" {onclose}>
  <p class="text-sm text-(--color-ink-muted)">{recipe.name}</p>
  <p class="pt-1 text-xs text-(--color-ink-muted)">
    Składniki i przygotowanie jako zwykły tekst — bez kalorii i bez linku do źródła.
  </p>

  <div class="flex items-center gap-2 pt-4">
    <button
      type="button"
      class="emw-press emw-btn-icon border border-(--color-border) disabled:opacity-50"
      aria-label="Mniej porcji w przepisie"
      disabled={portions <= 1}
      onclick={() => setPortions(Math.max(1, portions - 1))}
    >
      <NavIcon path={MINUS} class="size-4" />
    </button>
    <label class="text-sm">
      <span class="sr-only">Porcje w przepisie</span>
      <input
        class="w-20 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-center text-base tabular-nums outline-none focus:border-(--color-accent)"
        type="number"
        inputmode="decimal"
        min="0.1"
        step="any"
        value={portions}
        onchange={(event) => {
          setPortions(event.currentTarget.valueAsNumber);
          event.currentTarget.value = String(portions);
        }}
      />
    </label>
    <button
      type="button"
      class="emw-press emw-btn-icon border border-(--color-border)"
      aria-label="Więcej porcji w przepisie"
      onclick={() => setPortions(portions + 1)}
    >
      <NavIcon path={PLUS} class="size-4" />
    </button>
    <span class="text-sm text-(--color-ink-muted)">{portionWord(portions)}</span>
  </div>

  {#if portions !== 1 && hasInstructions}
    <!-- In the sheet and never in the text: the recipient has no use for a note about how the
         app works, the sender does (STATE.md decision 413). -->
    <p class="pt-2 text-xs text-(--color-warn)">
      Ilości składników są przeliczone. Liczby w opisie przygotowania zostają takie, jak je
      zapisano.
    </p>
  {/if}

  {#if loading}
    <p class="pt-4 text-sm text-(--color-ink-muted)">Wczytywanie…</p>
  {:else}
    <p
      class="mt-4 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-2 text-sm whitespace-pre-line select-text"
      data-testid="recipe-share-text"
    >{text}</p>

    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button
        type="button"
        class="emw-press emw-btn emw-btn-primary px-4"
        onclick={() => void share()}
      >
        Udostępnij przepis
      </button>
      {#if outcome === 'copied'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Skopiowano do schowka.</span>
      {:else if outcome === 'shared'}
        <span class="text-sm text-(--color-ink-muted)" role="status">Udostępniono.</span>
      {:else if outcome === 'failed'}
        <span class="text-sm text-(--color-warn)" role="status">
          Nie udało się udostępnić ani skopiować — zaznacz przepis powyżej i skopiuj ręcznie.
        </span>
      {/if}
    </div>
  {/if}
</BottomSheet>
