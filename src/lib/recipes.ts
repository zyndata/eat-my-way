import type {
  Ingredient,
  Macros,
  Measure,
  MeasureName,
  Recipe,
  RecipeItem,
  Tag,
  Unit
} from './types';
import { addYears } from './dates';
import { itemMacros, sumMacros, type IngredientLookup } from './macros';
import { rankCandidates } from './search';
import { toTagKeys } from './tags';
import { normalizeKey } from './text';

/**
 * Recipe library and recipe-editor rules, pure. The screens in `routes/` render what these
 * functions decide; the repository persists what they produce.
 */

/**
 * How far back the library looks when it counts usage, in years (decision 147). Everything
 * from the future counts too — a staple planned for tomorrow is exactly what should rise.
 */
export const USAGE_WINDOW_YEARS = 1;

/** The first day usage is counted from: `today` minus the window. */
export function usageWindowStart(today: string): string {
  return addYears(today, -USAGE_WINDOW_YEARS);
}

/** How much a recipe is actually used, gathered from the days table (decision 48). */
export interface RecipeUsage {
  /**
   * Planned meals referring to this recipe, counted over the last `USAGE_WINDOW_YEARS`
   * and everything planned ahead — not over the whole history (decision 147). The library
   * says „w ostatnim roku" for exactly this reason.
   */
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

/**
 * How the library may be ordered (PLAN.md Phase 9 task 4). `activity` is the default from
 * decision 46; the chosen value is remembered in the meta table, per device.
 */
export type RecipeSort = 'activity' | 'name' | 'kcal';

export const RECIPE_SORTS: readonly RecipeSort[] = ['activity', 'name', 'kcal'];

/** True for a value read back out of storage that is still one of the known orders. */
export function isRecipeSort(value: unknown): value is RecipeSort {
  return typeof value === 'string' && RECIPE_SORTS.includes(value as RecipeSort);
}

/** Polish collation on the name — the final tie-break of every order. */
function byName(a: RecipeListEntry, b: RecipeListEntry): number {
  return a.recipe.name.localeCompare(b.recipe.name, 'pl');
}

/**
 * Library order. `activity` is decision 46 — most recently edited or planned first, frequency
 * as the tie-break. `name` is the Polish alphabet. `kcal` is per-portion energy, lightest
 * first, which is the direction a budget is read in; a recipe whose macros are unknown sorts
 * last rather than as zero, because "we do not know" is not "it is free".
 */
export function sortRecipes(
  entries: readonly RecipeListEntry[],
  sort: RecipeSort = 'activity',
  portionMacros?: ReadonlyMap<string, Macros>
): RecipeListEntry[] {
  const list = [...entries];

  if (sort === 'name') return list.sort(byName);

  if (sort === 'kcal') {
    const kcal = (entry: RecipeListEntry): number =>
      portionMacros?.get(entry.recipe.id)?.kcal ?? Number.POSITIVE_INFINITY;
    return list.sort((a, b) => kcal(a) - kcal(b) || byName(a, b));
  }

  return list.sort(
    (a, b) =>
      activityDate(b).localeCompare(activityDate(a)) ||
      b.usage.plannedCount - a.usage.plannedCount ||
      byName(a, b)
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

// ---- preparation time -------------------------------------------------------------------

/**
 * The limits the library's time filter offers, in minutes (PLAN.md Phase 20 task 3). Three
 * chips and no free number: „do 15 / 30 / 60 min" is how the question is actually asked on a
 * Wednesday at six, and a spinner asking for an exact ceiling would be a worse way to ask it.
 */
export const PREP_LIMITS: readonly number[] = [15, 30, 60];

/**
 * A stored preparation time, or `undefined` for anything that must not be stored: only a
 * positive whole number of minutes is a time. Zero is not „instant" and a negative is not a
 * time at all, so both are refused here rather than written and rendered later.
 */
export function readPrepMinutes(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** True while the editor's time field holds something savable — including nothing at all. */
export function isPrepMinutesValid(value: number | null): boolean {
  return value === null || readPrepMinutes(value) !== undefined;
}

/**
 * Recipes that can be cooked within `limit` minutes. No limit keeps everything, exactly as no
 * tag selection does.
 *
 * A recipe with no time is **hidden** while the filter is on. „do 30 min" is a claim about a
 * recipe and an untimed one makes no claim, so including it would answer the question with a
 * maybe; the library says out loud how many it is hiding instead (decision 382).
 */
export function filterByPrepMinutes(
  entries: readonly RecipeListEntry[],
  limit?: number
): RecipeListEntry[] {
  if (limit === undefined) return [...entries];
  return entries.filter((entry) => {
    const minutes = entry.recipe.prepMinutes;
    return minutes !== undefined && minutes <= limit;
  });
}

/** How many of these recipes carry no preparation time — what the time filter hides. */
export function countWithoutPrepMinutes(entries: readonly RecipeListEntry[]): number {
  return entries.filter((entry) => entry.recipe.prepMinutes === undefined).length;
}

/**
 * Every ingredient's search keys by id — its normalized name and its normalized aliases.
 *
 * Handed in rather than stored on the recipe: it comes out of the in-memory snapshot the
 * autocomplete already holds (STATE.md decisions 39 and 333), so a recipe carries no
 * denormalized copy of what its ingredients happen to be called this week.
 */
export type IngredientKeys = ReadonlyMap<string, readonly string[]>;

export interface SearchOptions {
  sort?: RecipeSort;
  /** Per-portion macros, needed only by the `kcal` order. */
  portionMacros?: ReadonlyMap<string, Macros>;
  /** Omitted, the search is by recipe name alone — exactly what it did before Phase 18. */
  ingredientKeys?: IngredientKeys;
  /** The time filter's ceiling in minutes; omitted, no recipe is hidden for its time. */
  maxPrepMinutes?: number;
}

/** The keys of everything one recipe contains, deduplicated, in item order. */
function recipeIngredientKeys(recipe: Recipe, keys: IngredientKeys | undefined): string[] {
  if (keys === undefined) return [];
  const seen = new Set<string>();
  for (const item of recipe.items) {
    for (const key of keys.get(item.ingredientId) ?? []) {
      if (key !== '') seen.add(key);
    }
  }
  return [...seen];
}

/**
 * The library list for a query and a tag selection. A blank query keeps the chosen order;
 * anything typed hands over to the Phase 3 ranker, with the plan count standing in for
 * `useCount` so a frequently cooked recipe wins a tie. Diacritics are not required.
 *
 * A typed query overrides the sort entirely, exactly as it has always overridden the default
 * order: match quality is the only ranking that makes sense once the user has said what they
 * are looking for.
 *
 * Phase 18 widens it from names to contents: given `ingredientKeys`, „soczewica" also finds
 * the recipes that merely contain lentils — underneath every recipe with lentils in its name,
 * never level with them.
 *
 * Phase 20 adds the time ceiling. It narrows like the tag chips do — before the query is
 * ranked, never after — so „do 30 min" and „obiad" and „soczewica" all hold at once.
 */
export function searchRecipes(
  entries: readonly RecipeListEntry[],
  query: string,
  selectedTags: readonly string[] = [],
  options: SearchOptions = {}
): RecipeListEntry[] {
  const filtered = filterByPrepMinutes(
    filterByTags(entries, selectedTags),
    options.maxPrepMinutes
  );
  if (normalizeKey(query) === '') {
    return sortRecipes(filtered, options.sort ?? 'activity', options.portionMacros);
  }

  const candidates = filtered.map((entry) => ({
    entry,
    nameKey: normalizeKey(entry.recipe.name),
    // A recipe has no aliases of its own. What it *contains* ranks below every name match,
    // which is the whole point of `MatchTier.Contained` (STATE.md decision 333).
    aliasKeys: [] as string[],
    containedKeys: recipeIngredientKeys(entry.recipe, options.ingredientKeys),
    useCount: entry.usage.plannedCount
  }));

  // -1: the library shows every match, unlike the autocomplete's short list.
  return rankCandidates(query, candidates, -1).map((match) => match.item.entry);
}

// ---- grouping by tag --------------------------------------------------------------------

/** The key of the section holding recipes with no tags at all. Never a real `Tag.key`. */
export const UNTAGGED_KEY = '';

/** One section of the grouped library view (PLAN.md Phase 9 task 1). */
export interface RecipeGroup {
  key: string;
  label: string;
  entries: RecipeListEntry[];
}

/**
 * Split an already-ordered list into one section per tag, plus „Bez tagu" last.
 *
 * A recipe carrying three tags appears in all three sections, so the header counts
 * deliberately sum to more than the number of recipes. Order inside a section is the order
 * the list arrived in, which is whatever `searchRecipes` decided; the sections themselves
 * follow `tags`, which the repository already returns most-used first (STATE.md decision
 * 157). Tags nobody in `entries` carries produce no section at all.
 */
export function groupByTag(
  entries: readonly RecipeListEntry[],
  tags: readonly Tag[]
): RecipeGroup[] {
  const groups: RecipeGroup[] = [];

  for (const tag of tags) {
    const members = entries.filter((entry) => entry.recipe.tags.includes(tag.key));
    if (members.length > 0) groups.push({ key: tag.key, label: tag.label, entries: members });
  }

  const untagged = entries.filter((entry) => entry.recipe.tags.length === 0);
  if (untagged.length > 0) {
    groups.push({ key: UNTAGGED_KEY, label: 'Bez tagu', entries: untagged });
  }

  return groups;
}

// ---- fitting into the day's budget ------------------------------------------------------

/**
 * How a recipe fits what is left of the day: whole, or only at half a portion. Half is the
 * only fraction offered — a rule with one fraction cannot be misread, and half a portion is
 * something a person actually puts on a plate (STATE.md decision 148).
 */
export type BudgetFit = 'full' | 'half';

export interface BudgetEntry {
  entry: RecipeListEntry;
  fit: BudgetFit;
}

/** Portion of a recipe the „pół porcji" suggestion offers. */
export const HALF_PORTION = 0.5;

/**
 * Recipes that fit `remaining` kilocalories, each marked with how. A whole portion is
 * preferred; a recipe that only fits at half is kept and marked, and one that does not fit
 * even at half is dropped. Input order is preserved exactly — this filters, it never ranks
 * (decision 148), which is what lets the picker keep its decision 46 order.
 *
 * A recipe whose per-portion macros are not in the map is kept as `full` rather than hidden:
 * an unknown value is not evidence that it does not fit, and silently dropping a recipe from
 * the picker is the one failure mode this must not have.
 */
export function fitToBudget(
  entries: readonly RecipeListEntry[],
  portionMacros: ReadonlyMap<string, Macros>,
  remaining: number
): BudgetEntry[] {
  const fitted: BudgetEntry[] = [];

  for (const entry of entries) {
    const macros = portionMacros.get(entry.recipe.id);
    if (macros === undefined || macros.kcal <= remaining) fitted.push({ entry, fit: 'full' });
    else if (macros.kcal * HALF_PORTION <= remaining) fitted.push({ entry, fit: 'half' });
  }

  return fitted;
}

/**
 * How a single recipe stands against the remaining budget, for a list that is not being
 * filtered — the badge on a card the user can see anyway. `undefined` means it fits whole,
 * or there is nothing to compare against.
 */
export function budgetFit(
  macros: Macros | undefined,
  remaining: number
): BudgetFit | undefined {
  if (macros === undefined) return undefined;
  if (macros.kcal <= remaining) return 'full';
  return macros.kcal * HALF_PORTION <= remaining ? 'half' : undefined;
}

// ---- editor drafts ----------------------------------------------------------------------

/**
 * One ingredient row while it is being edited. `null` is what an emptied number input reads
 * back as, and it is kept as-is so the field does not fight the user mid-typing
 * (decision 54).
 */
export interface DraftItem {
  /**
   * Local row identity for the `{#each}` block and for the drag library, which reads a
   * field literally named `id` and can only be told otherwise globally — the day's meal list
   * uses the default, so this one follows it (STATE.md decision 163). Never stored.
   */
  id: string;
  ingredientId: string;
  amount: number | null;
  unit: Unit;
  gramsPerUnit: number | null;
  /**
   * The household measure this row is counted in, or `null` for a plain „szt." row. Only ever
   * a label: tapping a measure chip writes `unit`, `gramsPerUnit` and this together, and from
   * then on the three move independently — re-weighing a clove keeps it a clove.
   */
  measureName: MeasureName | null;
  /** Per-100 g values typed by hand at this point of use; `null` means "use the database". */
  macroOverride: Macros | null;
  /**
   * The Polish name an import produced for this row, or `null` on a hand-written one. Editor
   * state only — it is never written to a `Recipe` and never travels to Drive. It exists so
   * that changing an imported row's ingredient can be stored as a correction, which is what
   * makes the next import of the same name match by lookup (STATE.md decision 116).
   */
  sourceName: string | null;
}

/** The whole editor form. `tagLabels` are as typed — normalization happens on save. */
export interface RecipeDraft {
  name: string;
  instructions: string;
  tagLabels: string[];
  items: DraftItem[];
  /** The page this recipe came from, or `''`. Cleaned before it ever reaches the draft. */
  sourceUrl: string;
  /**
   * Preparation time in minutes, `null` while the field is empty — which is what an emptied
   * number input reads back as, and it is kept as-is so the field does not fight the user
   * mid-typing, exactly like `DraftItem.amount` (decision 54).
   */
  prepMinutes: number | null;
}

export function emptyDraftItem(id: string): DraftItem {
  return {
    id,
    ingredientId: '',
    amount: null,
    unit: 'g',
    gramsPerUnit: null,
    measureName: null,
    macroOverride: null,
    sourceName: null
  };
}

export function emptyDraft(): RecipeDraft {
  return {
    name: '',
    instructions: '',
    tagLabels: [],
    items: [],
    sourceUrl: '',
    prepMinutes: null
  };
}

/** `null` and non-finite values count as zero once the draft leaves the editor. */
function toNumber(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : 0;
}

export function draftFromRecipeItem(item: RecipeItem, id: string): DraftItem {
  return {
    id,
    ingredientId: item.ingredientId,
    amount: item.amount,
    unit: item.unit,
    gramsPerUnit: item.gramsPerUnit ?? null,
    measureName: item.measureName ?? null,
    macroOverride: item.macroOverride === undefined ? null : { ...item.macroOverride },
    sourceName: null
  };
}

/** Load a stored recipe into the editor. `labels` are the tag labels for its keys. */
export function draftFromRecipe(
  recipe: Recipe,
  labels: readonly string[],
  nextId: () => string
): RecipeDraft {
  return {
    name: recipe.name,
    instructions: recipe.instructions,
    tagLabels: [...labels],
    items: recipe.items.map((item) => draftFromRecipeItem(item, nextId())),
    sourceUrl: recipe.sourceUrl ?? '',
    prepMinutes: recipe.prepMinutes ?? null
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
  // A measure only ever labels a `szt` row (decision 323), so switching the unit to `g` or
  // `ml` drops the label rather than storing one that nothing would ever print.
  if (draft.unit === 'szt' && draft.measureName !== null) item.measureName = draft.measureName;
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

/**
 * A blank name blocks saving, and so does a preparation time that is not a time: zero,
 * a negative and „12,5 min" are refused rather than quietly dropped, because silently not
 * storing something the user typed is the one outcome they cannot see (PLAN.md Phase 20).
 */
export function canSaveDraft(draft: RecipeDraft): boolean {
  return draft.name.trim() !== '' && isPrepMinutesValid(draft.prepMinutes);
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
  const source = draft.sourceUrl.trim();
  const prepMinutes = readPrepMinutes(draft.prepMinutes);
  return {
    id: options.id,
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    items: toRecipeItems(draft.items),
    tags: toTagKeys(draft.tagLabels),
    createdAt: options.createdAt ?? options.now,
    updatedAt: options.now,
    // Omitted rather than written as `''`, like every other optional field here: an absent
    // source and an empty one must not be two different things in the Drive JSON.
    ...(source === '' ? {} : { sourceUrl: source }),
    // Same rule, and here it carries a meaning: a missing time is „nobody timed this", which
    // is not the same claim as any number, least of all zero.
    ...(prepMinutes === undefined ? {} : { prepMinutes })
  };
}

/**
 * Apply a household measure to an editor row: the unit, the label and the weight in one act.
 *
 * The weight is the ingredient's default for that measure and is a *starting point* — the
 * grams field stays editable, and editing it does not take the label away, because a clove
 * re-weighed at 7 g is still a clove (PLAN.md Phase 16 task 4).
 */
export function applyMeasure(draft: DraftItem, measure: Measure): void {
  draft.unit = 'szt';
  draft.measureName = measure.name;
  draft.gramsPerUnit = measure.grams;
}

/**
 * The measures a row can offer: the ingredient's own, plus the one the row already carries
 * when the library has since dropped it.
 *
 * That second half is what keeps a recipe from changing because the library did — the chip
 * stays on screen, selected, with the row's own weight, rather than vanishing and leaving
 * „2 ząbki" unexplained.
 */
export function measureChoices(
  draft: DraftItem,
  ingredient: Ingredient | undefined
): Measure[] {
  const offered = ingredient?.measures ?? [];
  const current = draft.measureName;
  if (current === null || offered.some((measure) => measure.name === current)) {
    return [...offered];
  }
  return [...offered, { name: current, grams: toNumber(draft.gramsPerUnit) }];
}

/** Per-100 g values a row starts an override from: the ingredient's own, or zeros. */
export function overrideSeed(ingredient: Ingredient | undefined): Macros {
  return ingredient === undefined
    ? { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    : { ...ingredient.per100g };
}

// ---- duplicating a recipe ---------------------------------------------------------------

/** Appended to the name of a copy. */
export const COPY_SUFFIX = ' (kopia)';

/**
 * A deep, independent copy of a recipe (PLAN.md Phase 9 task 3, STATE.md decision 66).
 *
 * Everything the original owns is copied by value — items, their per-item overrides, the tag
 * keys — so editing the copy can never reach back into the original, and no `macroSnapshot`
 * anywhere refers to it. The tags come along deliberately: a variant of „obiad" is still
 * „obiad", and the repository bumps each tag's `useCount` because a second recipe now carries
 * it (open question 8).
 *
 * `photoFileId` is the one field NOT copied. It names a separate Drive file, and two recipes
 * pointing at one file would mean deleting either takes the other's photo with it.
 */
export function duplicateRecipe(
  recipe: Recipe,
  options: { id: string; now: string }
): Recipe {
  return {
    id: options.id,
    name: `${recipe.name}${COPY_SUFFIX}`,
    instructions: recipe.instructions,
    items: recipe.items.map((item) => ({
      ...item,
      ...(item.macroOverride === undefined ? {} : { macroOverride: { ...item.macroOverride } })
    })),
    tags: [...recipe.tags],
    createdAt: options.now,
    updatedAt: options.now,
    // A variant of a recipe still came from the page the original came from, and the row can
    // be cleared on the copy if the variant has drifted too far to claim it.
    ...(recipe.sourceUrl === undefined ? {} : { sourceUrl: recipe.sourceUrl }),
    // A copy cooks like its original until it is edited, so it inherits the time too.
    ...(recipe.prepMinutes === undefined ? {} : { prepMinutes: recipe.prepMinutes })
  };
}
