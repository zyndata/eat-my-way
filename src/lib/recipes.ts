import type { Ingredient, Macros, Recipe, RecipeItem, Unit } from './types';
import { itemMacros, sumMacros, type IngredientLookup } from './macros';
import { rankCandidates } from './search';
import { toTagKeys } from './tags';
import { normalizeKey } from './text';

/**
 * Recipe library and recipe-editor rules, pure. The screens in `routes/` render what these
 * functions decide; the repository persists what they produce.
 */

/** How much a recipe is actually used, gathered from the days table (decision 48). */
export interface RecipeUsage {
  /** Planned meals referring to this recipe, across every day. */
  plannedCount: number;
  /** The latest day it is planned on, `YYYY-MM-DD`, or `undefined` if never planned. */
  lastPlannedDate?: string;
}

export const NO_USAGE: RecipeUsage = Object.freeze({ plannedCount: 0 });

/** One row of the library list. */
export interface RecipeListEntry {
  recipe: Recipe;
  usage: RecipeUsage;
}

/**
 * The date the library sorts on: the later of "last edited" and "last planned", so a recipe
 * just written and a staple planned for tomorrow both rise to the top (decision 46).
 * `updatedAt` is an ISO timestamp; its first ten characters are the same calendar-date
 * format the days table uses, which is exactly the precision the comparison needs.
 */
export function activityDate(entry: RecipeListEntry): string {
  const edited = entry.recipe.updatedAt.slice(0, 10);
  const planned = entry.usage.lastPlannedDate ?? '';
  return edited > planned ? edited : planned;
}

/** Default library order: recent activity, then frequency, then the Polish alphabet. */
export function sortRecipes(entries: readonly RecipeListEntry[]): RecipeListEntry[] {
  return [...entries].sort(
    (a, b) =>
      activityDate(b).localeCompare(activityDate(a)) ||
      b.usage.plannedCount - a.usage.plannedCount ||
      a.recipe.name.localeCompare(b.recipe.name, 'pl')
  );
}

/** Recipes carrying *every* selected tag key. No selection keeps everything (decision 47). */
export function filterByTags(
  entries: readonly RecipeListEntry[],
  selected: readonly string[]
): RecipeListEntry[] {
  if (selected.length === 0) return [...entries];
  return entries.filter((entry) => selected.every((key) => entry.recipe.tags.includes(key)));
}

/**
 * The library list for a query and a tag selection. A blank query keeps the default order;
 * anything typed hands over to the Phase 3 ranker, with the plan count standing in for
 * `useCount` so a frequently cooked recipe wins a tie. Diacritics are not required.
 */
export function searchRecipes(
  entries: readonly RecipeListEntry[],
  query: string,
  selectedTags: readonly string[] = []
): RecipeListEntry[] {
  const filtered = filterByTags(entries, selectedTags);
  if (normalizeKey(query) === '') return sortRecipes(filtered);

  const candidates = filtered.map((entry) => ({
    entry,
    nameKey: normalizeKey(entry.recipe.name),
    aliasKeys: [] as string[],
    useCount: entry.usage.plannedCount
  }));

  // -1: the library shows every match, unlike the autocomplete's short list.
  return rankCandidates(query, candidates, -1).map((match) => match.item.entry);
}

/**
 * Recipes whose *single portion* fits within `remaining` kilocalories — the picker's
 * „Zmieści się w limicie" filter. One portion, because `portionsEaten` is only chosen after
 * the pick (STATE.md decision 64).
 *
 * A recipe whose per-portion macros are not in the map is kept rather than hidden: an
 * unknown value is not evidence that it does not fit, and silently dropping a recipe from
 * the picker is the one failure mode this filter must not have.
 */
export function filterByBudget(
  entries: readonly RecipeListEntry[],
  portionMacros: ReadonlyMap<string, Macros>,
  remaining: number
): RecipeListEntry[] {
  return entries.filter((entry) => {
    const macros = portionMacros.get(entry.recipe.id);
    return macros === undefined || macros.kcal <= remaining;
  });
}

// ---- editor drafts ----------------------------------------------------------------------

/**
 * One ingredient row while it is being edited. `null` is what an emptied number input reads
 * back as, and it is kept as-is so the field does not fight the user mid-typing
 * (decision 54). `key` is a local row identity for the `{#each}` block and is never stored.
 */
export interface DraftItem {
  key: string;
  ingredientId: string;
  amount: number | null;
  unit: Unit;
  gramsPerUnit: number | null;
  /** Per-100 g values typed by hand at this point of use; `null` means "use the database". */
  macroOverride: Macros | null;
}

/** The whole editor form. `tagLabels` are as typed — normalization happens on save. */
export interface RecipeDraft {
  name: string;
  instructions: string;
  tagLabels: string[];
  items: DraftItem[];
}

export function emptyDraftItem(key: string): DraftItem {
  return { key, ingredientId: '', amount: null, unit: 'g', gramsPerUnit: null, macroOverride: null };
}

export function emptyDraft(): RecipeDraft {
  return { name: '', instructions: '', tagLabels: [], items: [] };
}

/** `null` and non-finite values count as zero once the draft leaves the editor. */
function toNumber(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : 0;
}

export function draftFromRecipeItem(item: RecipeItem, key: string): DraftItem {
  return {
    key,
    ingredientId: item.ingredientId,
    amount: item.amount,
    unit: item.unit,
    gramsPerUnit: item.gramsPerUnit ?? null,
    macroOverride: item.macroOverride === undefined ? null : { ...item.macroOverride }
  };
}

/** Load a stored recipe into the editor. `labels` are the tag labels for its keys. */
export function draftFromRecipe(
  recipe: Recipe,
  labels: readonly string[],
  nextKey: () => string
): RecipeDraft {
  return {
    name: recipe.name,
    instructions: recipe.instructions,
    tagLabels: [...labels],
    items: recipe.items.map((item) => draftFromRecipeItem(item, nextKey()))
  };
}

/**
 * Draft row -> wire shape. The single place a draft becomes storable: optional fields are
 * *omitted* rather than written as zeros, so the Drive JSON in Phase 6 stays minimal, and
 * `gramsPerUnit` never appears on a `g` row where it would mean nothing.
 */
export function toRecipeItem(draft: DraftItem): RecipeItem {
  const item: RecipeItem = {
    ingredientId: draft.ingredientId,
    amount: toNumber(draft.amount),
    unit: draft.unit
  };
  const grams = toNumber(draft.gramsPerUnit);
  if (draft.unit !== 'g' && grams > 0) item.gramsPerUnit = grams;
  if (draft.macroOverride !== null) item.macroOverride = { ...draft.macroOverride };
  return item;
}

/** Rows that never got an ingredient are dropped — they are empty slots, not data. */
export function toRecipeItems(drafts: readonly DraftItem[]): RecipeItem[] {
  return drafts.filter((draft) => draft.ingredientId !== '').map(toRecipeItem);
}

/** Live per-portion sum while editing. `Recipe.items` are per portion, so this is a sum. */
export function draftMacros(drafts: readonly DraftItem[], lookup: IngredientLookup): Macros {
  return sumMacros(
    toRecipeItems(drafts).map((item) => itemMacros(item, lookup(item.ingredientId)))
  );
}

/** True once the row can contribute macros: `szt` needs a weight per piece (decision 26). */
export function isDraftComplete(draft: DraftItem): boolean {
  if (draft.ingredientId === '') return false;
  return draft.unit !== 'szt' || toNumber(draft.gramsPerUnit) > 0;
}

/** Rows that will silently weigh nothing. The editor flags them but still saves (decision 52). */
export function incompleteDrafts(drafts: readonly DraftItem[]): DraftItem[] {
  return drafts.filter((draft) => draft.ingredientId !== '' && !isDraftComplete(draft));
}

/** Only a blank name blocks saving. */
export function canSaveDraft(draft: RecipeDraft): boolean {
  return draft.name.trim() !== '';
}

/**
 * Draft -> `Recipe`. `createdAt` is carried over for an existing recipe and set to `now` for
 * a new one; `updatedAt` is always `now`, which is what the library sorts on. Tag *keys* are
 * derived here so the object is coherent on its own — the repository still receives the raw
 * labels, so a tag typed for the first time keeps that spelling.
 */
export function draftToRecipe(
  draft: RecipeDraft,
  options: { id: string; createdAt?: string | undefined; now: string }
): Recipe {
  return {
    id: options.id,
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    items: toRecipeItems(draft.items),
    tags: toTagKeys(draft.tagLabels),
    createdAt: options.createdAt ?? options.now,
    updatedAt: options.now
  };
}

/** Per-100 g values a row starts an override from: the ingredient's own, or zeros. */
export function overrideSeed(ingredient: Ingredient | undefined): Macros {
  return ingredient === undefined
    ? { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    : { ...ingredient.per100g };
}
