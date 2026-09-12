import type { Macros, PlannedMeal, Recipe, RecipeItem } from './types';
import { itemMacros, sumMacros, type IngredientLookup } from './macros';
import { formatMeasureAmount } from './text';

/**
 * Per-meal changes to a recipe (PLAN.md Phase 14), pure. No database, no clock, no ids.
 *
 * A recipe says what the dish is; a planned meal says what was actually eaten, and the two
 * are not always the same dish — the salad reduced to its cucumbers, the bread home-baked one
 * week and shop-bought the next. Neither is a new recipe, so neither earns a card in the
 * library (STATE.md decisions 301-303).
 *
 * A meal therefore carries **a layer of its own changes over the recipe it came from**. The
 * layer never travels back into the library: the recipe stays exactly as it was typed, and
 * the recipe screen never learns that any of this happened.
 *
 * Everything that reads `recipe.items` for a *planned meal* — the macro snapshot, the meal
 * screen's ingredient list, the shopping list — reads `effectiveItems` instead. That one
 * seam is the whole feature.
 */

/**
 * One change made to a single planned meal. Never written back to the recipe.
 *
 * `replaces` names a recipe row BY INGREDIENT, not by position, so the layer survives an edit
 * to the recipe underneath it (decision 304). `item` is what is eaten instead — absent means
 * nothing is:
 *
 *   { replaces: 'usda:1' }                          — skip that row
 *   { replaces: 'usda:1', item: {…same id, 50 g} }  — eat a different amount of it
 *   { replaces: 'usda:1', item: {…other id} }       — swap it for something else
 *   { item: {…} }                                   — add something the recipe has not got
 */
export interface MealAdjustment {
  replaces?: string;
  item?: RecipeItem;
}

/** How a row of the meal's ingredient list came to be what it is. */
export type AdjustedRowKind = 'plain' | 'amount' | 'swap' | 'added' | 'skipped';

/**
 * One row as the meal screen shows it. Skipped rows are part of the list — a list that
 * silently loses rows is a list nobody trusts — which is why this, and not `effectiveItems`,
 * is what the screen renders.
 */
export interface AdjustedRow {
  /** What is eaten. For a skipped row, what would have been. */
  item: RecipeItem;
  kind: AdjustedRowKind;
  /** The recipe row this came from; absent on an added row. */
  original?: RecipeItem;
  /** How a change to this row is addressed — see `adjustmentKey`. */
  key: string;
}

/** Key spaces. A recipe row and an addition can name the same ingredient and stay distinct. */
const RECIPE_ROW = 'r:';
const ADDED_ROW = 'a:';

/**
 * The key one change is filed under. Two changes sharing a key are the same change made
 * twice, and the builders below collapse them rather than stacking them.
 */
export function adjustmentKey(adjustment: MealAdjustment): string {
  return adjustment.replaces !== undefined
    ? `${RECIPE_ROW}${adjustment.replaces}`
    : `${ADDED_ROW}${adjustment.item?.ingredientId ?? ''}`;
}

/** The ingredient a recipe-row key names, or `undefined` for an addition's key. */
function replacedIngredient(key: string): string | undefined {
  return key.startsWith(RECIPE_ROW) ? key.slice(RECIPE_ROW.length) : undefined;
}

/**
 * Drop what is not a change. `{}` — neither field — says nothing and is never stored; every
 * write goes through here, so a meal can only ever hold changes that mean something.
 */
export function normalizeAdjustments(
  adjustments: readonly MealAdjustment[] | undefined
): MealAdjustment[] {
  return [...(adjustments ?? [])].filter(
    (adjustment) => adjustment.replaces !== undefined || adjustment.item !== undefined
  );
}

function cloneItem(item: RecipeItem): RecipeItem {
  const copy: RecipeItem = { ingredientId: item.ingredientId, amount: item.amount, unit: item.unit };
  if (item.gramsPerUnit !== undefined) copy.gramsPerUnit = item.gramsPerUnit;
  if (item.macroOverride !== undefined) copy.macroOverride = { ...item.macroOverride };
  return copy;
}

/**
 * Deep copy of one change, field by field. Named fields rather than a spread, for the same
 * reason `clonePlannedMeal` enumerates: a copy that shares a `macroOverride` object with its
 * source is a copy only until one of them is edited.
 */
export function cloneAdjustment(adjustment: MealAdjustment): MealAdjustment {
  const copy: MealAdjustment = {};
  if (adjustment.replaces !== undefined) copy.replaces = adjustment.replaces;
  if (adjustment.item !== undefined) copy.item = cloneItem(adjustment.item);
  return copy;
}

/** Deep copy of a whole layer, `{}` entries dropped. */
export function cloneAdjustments(
  adjustments: readonly MealAdjustment[] | undefined
): MealAdjustment[] {
  return normalizeAdjustments(adjustments).map(cloneAdjustment);
}

/** Same ingredient means the amount moved; a different one means it was swapped out. */
function changeKind(original: RecipeItem, item: RecipeItem): AdjustedRowKind {
  return original.ingredientId === item.ingredientId ? 'amount' : 'swap';
}

/**
 * The recipe's rows with the layer applied, skipped ones included and marked.
 *
 * The rules, each of them a test:
 *
 * - Changes apply **in array order**, each to the list as the ones before it left it.
 *   Additions land at the end.
 * - `replaces` matches **every** row carrying that ingredient. A recipe that lists oil twice
 *   has one oil as far as a person skipping it is concerned (decision 304).
 * - A change naming a row the recipe no longer has goes **inert, not deleted**: it applies to
 *   nothing while the row is absent, and applies again if a later recipe edit brings the row
 *   back. An addition applies always.
 */
export function adjustedRows(
  recipe: Recipe,
  adjustments: readonly MealAdjustment[] | undefined
): AdjustedRow[] {
  const rows: AdjustedRow[] = recipe.items.map((item) => ({
    item,
    kind: 'plain',
    key: `${RECIPE_ROW}${item.ingredientId}`
  }));

  for (const adjustment of normalizeAdjustments(adjustments)) {
    const key = adjustmentKey(adjustment);
    const replaces = replacedIngredient(key);

    if (replaces === undefined) {
      // An addition; `normalizeAdjustments` guarantees the item is there.
      if (adjustment.item !== undefined) rows.push({ item: adjustment.item, kind: 'added', key });
      continue;
    }

    for (const [index, row] of rows.entries()) {
      if (row.item.ingredientId !== replaces) continue;
      const original = row.original ?? row.item;
      rows[index] =
        adjustment.item === undefined
          ? { item: row.item, kind: 'skipped', original, key }
          : { item: adjustment.item, kind: changeKind(original, adjustment.item), original, key };
    }
  }

  return rows;
}

/**
 * What the meal is actually made of: the recipe's rows with the layer applied and the skipped
 * ones gone. This is the one function the snapshot, the meal screen and the shopping list all
 * read instead of `recipe.items`.
 */
export function effectiveItems(
  recipe: Recipe,
  adjustments: readonly MealAdjustment[] | undefined
): RecipeItem[] {
  return adjustedRows(recipe, adjustments)
    .filter((row) => row.kind !== 'skipped')
    .map((row) => row.item);
}

/** True when this meal is not the plain recipe. */
export function isAdjusted(meal: Pick<PlannedMeal, 'adjustments'>): boolean {
  return normalizeAdjustments(meal.adjustments).length > 0;
}

/**
 * Macros of one portion **as the meal is actually made** — `recipePortionMacros` over
 * `effectiveItems`. This is the value frozen into `macroSnapshot` by `adjustMeal` and by
 * „zaktualizuj przyszłe dni"; with no layer it is exactly `recipePortionMacros`.
 */
export function adjustedPortionMacros(
  recipe: Recipe,
  adjustments: readonly MealAdjustment[] | undefined,
  lookup: IngredientLookup
): Macros {
  return sumMacros(
    effectiveItems(recipe, adjustments).map((item) => itemMacros(item, lookup(item.ingredientId)))
  );
}

/**
 * The changes in Polish, one phrase each, for the „Zmieniony wobec przepisu: …" line.
 *
 * Signs and an arrow rather than prose: Polish declines a noun after „bez" and „zamiast", and
 * an ingredient name pulled from the database is a nominative that cannot be declined by
 * code. „− Ser żółty, Chleb domowy → Chleb sklepowy" is grammatical for every name there is
 * (STATE.md decision 313).
 */
export function adjustmentSummary(
  recipe: Recipe,
  adjustments: readonly MealAdjustment[] | undefined,
  lookup: IngredientLookup
): string[] {
  const name = (item: RecipeItem): string => lookup(item.ingredientId)?.name ?? 'Nieznany składnik';

  return adjustedRows(recipe, adjustments).flatMap((row): string[] => {
    switch (row.kind) {
      case 'plain':
        return [];
      case 'skipped':
        return [`− ${name(row.item)}`];
      case 'added':
        return [
          `+ ${name(row.item)} ${formatMeasureAmount(row.item.amount, row.item.unit, row.item.measureName)}`
        ];
      case 'swap':
        return [`${name(row.original ?? row.item)} → ${name(row.item)}`];
      case 'amount':
        return [
          `${name(row.item)} → ${formatMeasureAmount(row.item.amount, row.item.unit, row.item.measureName)}`
        ];
    }
  });
}

// ---- builders --------------------------------------------------------------------------
//
// Each returns a NEW array and each collapses a second change to the same row rather than
// stacking two, so the layer stays as short as the number of rows the user actually touched.
// Skip, "eat a different amount" and swap are one write between them — `changeRow` with an
// item, or without one — because `MealAdjustment` is one shape, not four tagged variants
// (STATE.md decisions 305 and 314).

/** Replace the change filed under `key`, in place, or append it. */
function put(
  adjustments: readonly MealAdjustment[] | undefined,
  adjustment: MealAdjustment
): MealAdjustment[] {
  const key = adjustmentKey(adjustment);
  const layer = normalizeAdjustments(adjustments);
  const index = layer.findIndex((existing) => adjustmentKey(existing) === key);
  if (index === -1) return [...layer, adjustment];

  const next = [...layer];
  next[index] = adjustment;
  return next;
}

/** „Przywróć" on one row: the change filed under `key` goes, and the recipe shows through. */
export function restoreRow(
  adjustments: readonly MealAdjustment[] | undefined,
  key: string
): MealAdjustment[] {
  return normalizeAdjustments(adjustments).filter(
    (adjustment) => adjustmentKey(adjustment) !== key
  );
}

/**
 * „Pomiń": the row stops being part of the meal. Skipping an *added* row is dropping the
 * addition — there is no recipe row underneath it to strike through.
 */
export function skipRow(
  adjustments: readonly MealAdjustment[] | undefined,
  key: string
): MealAdjustment[] {
  const replaces = replacedIngredient(key);
  if (replaces === undefined) return restoreRow(adjustments, key);
  return put(adjustments, { replaces });
}

/**
 * „Zmień" and the amount field: this row is eaten as `item` instead. Same ingredient means
 * an amount change, a different one means a swap — the stored shape is identical.
 */
export function changeRow(
  adjustments: readonly MealAdjustment[] | undefined,
  key: string,
  item: RecipeItem
): MealAdjustment[] {
  const replaces = replacedIngredient(key);
  if (replaces === undefined) {
    // An added row edited into a different ingredient changes its own key, so the old entry
    // has to go first or the meal would end up holding both.
    return put(restoreRow(adjustments, key), { item: cloneItem(item) });
  }
  return put(adjustments, { replaces, item: cloneItem(item) });
}

/** „Dodaj składnik": something the recipe has not got, at the end of the list. */
export function addRow(
  adjustments: readonly MealAdjustment[] | undefined,
  item: RecipeItem
): MealAdjustment[] {
  return put(adjustments, { item: cloneItem(item) });
}

/** „Przywróć oryginał": the meal is the recipe again. */
export function clearAdjustments(): MealAdjustment[] {
  return [];
}

/** Every ingredient the recipe names, once each, in the order it first names them. */
function recipeIngredientIds(recipe: Recipe): string[] {
  return [...new Set(recipe.items.map((item) => item.ingredientId))].filter((id) => id !== '');
}

/**
 * „Zostaw tylko ten składnik" — the cucumber case, one tap instead of five.
 *
 * Every other recipe row is skipped and every other change is dropped: the point of the
 * button is that only this one thing was eaten, so a swap made on some other row is no
 * longer about anything. A change already made to *this* row — a smaller amount, a
 * substitute — is kept, because that is still what was eaten.
 */
export function keepOnlyRow(
  recipe: Recipe,
  adjustments: readonly MealAdjustment[] | undefined,
  key: string
): MealAdjustment[] {
  const own = normalizeAdjustments(adjustments).filter(
    (adjustment) => adjustmentKey(adjustment) === key
  );
  const kept = replacedIngredient(key);
  const skips: MealAdjustment[] = recipeIngredientIds(recipe)
    .filter((id) => id !== kept)
    .map((id) => ({ replaces: id }));

  return [...own, ...skips];
}
