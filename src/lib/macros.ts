import type { Day, Ingredient, Macros, PlannedMeal, Recipe, RecipeItem } from './types';

/**
 * Macro arithmetic. Every function here is pure: no database, no clock, no randomness.
 *
 * The three invariants from PLAN.md that the rest of the app relies on:
 *
 *   displayed amount = item.amount x cookingScale     (cookingScale NEVER touches macros)
 *   meal macros      = macroSnapshot x portionsEaten
 *   day total        = sum of meal macros
 *
 * Results keep full float precision. Rounding is a display concern — see `roundMacros`.
 */

export const ZERO_MACROS: Macros = Object.freeze({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

/** Resolves an ingredient id to the ingredient, or `undefined` if it is unknown. */
export type IngredientLookup = (ingredientId: string) => Ingredient | undefined;

/** Build a lookup from a plain list — the usual way to call the recipe-level functions. */
export function ingredientLookup(ingredients: readonly Ingredient[]): IngredientLookup {
  const byId = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  return (id) => byId.get(id);
}

export function scaleMacros(macros: Macros, factor: number): Macros {
  return {
    kcal: macros.kcal * factor,
    protein: macros.protein * factor,
    carbs: macros.carbs * factor,
    fat: macros.fat * factor
  };
}

export function addMacros(a: Macros, b: Macros): Macros {
  return {
    kcal: a.kcal + b.kcal,
    protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs,
    fat: a.fat + b.fat
  };
}

export function sumMacros(all: readonly Macros[]): Macros {
  return all.reduce<Macros>(addMacros, ZERO_MACROS);
}

/** Display rounding: whole kilocalories, one decimal on the grams. Never used in maths. */
export function roundMacros(macros: Macros): Macros {
  return {
    kcal: Math.round(macros.kcal),
    protein: Math.round(macros.protein * 10) / 10,
    carbs: Math.round(macros.carbs * 10) / 10,
    fat: Math.round(macros.fat * 10) / 10
  };
}

/**
 * Grams in one unit of `item`:
 *   `g`   — 1 g per unit.
 *   `ml`  — `gramsPerUnit` is the density; water-like 1 g/ml when not given.
 *   `szt` — `gramsPerUnit` is mandatory (1 egg = 58 g). Missing means "not filled in yet",
 *           which weighs 0 so a half-typed recipe still renders. `isRecipeItemComplete`
 *           is what the editor uses to flag the row.
 */
export function gramsPerUnit(item: RecipeItem): number {
  switch (item.unit) {
    case 'g':
      return 1;
    case 'ml':
      return item.gramsPerUnit ?? 1;
    case 'szt':
      return item.gramsPerUnit ?? 0;
  }
}

/** True once the item has everything it needs to contribute macros. */
export function isRecipeItemComplete(item: RecipeItem): boolean {
  if (!Number.isFinite(item.amount) || item.amount < 0) return false;
  return item.unit !== 'szt' || (item.gramsPerUnit ?? 0) > 0;
}

/** Weight of the item, for exactly one portion, before any `cookingScale`. */
export function itemGrams(item: RecipeItem): number {
  return item.amount * gramsPerUnit(item);
}

/**
 * The per-100 g values that apply at this point of use. A `macroOverride` on the item wins
 * over the ingredient's own `per100g`; an unknown ingredient with no override is zero.
 */
export function itemPer100g(item: RecipeItem, ingredient: Ingredient | undefined): Macros {
  return item.macroOverride ?? ingredient?.per100g ?? ZERO_MACROS;
}

/** Macros this item contributes to one portion. */
export function itemMacros(item: RecipeItem, ingredient: Ingredient | undefined): Macros {
  return scaleMacros(itemPer100g(item, ingredient), itemGrams(item) / 100);
}

/**
 * Macros of one portion of the recipe — `Recipe.items` are already per portion, so this is
 * a plain sum. This is the value frozen into `PlannedMeal.macroSnapshot`.
 */
export function recipePortionMacros(recipe: Recipe, lookup: IngredientLookup): Macros {
  return sumMacros(recipe.items.map((item) => itemMacros(item, lookup(item.ingredientId))));
}

/**
 * Amount to show the user for an item when cooking at `cookingScale`. This is the ONLY
 * thing `cookingScale` affects — cooking a double batch does not double what you ate.
 */
export function displayedAmount(item: RecipeItem, cookingScale: number): number {
  return item.amount * cookingScale;
}

/** Grams of the item as actually cooked, i.e. after `cookingScale`. */
export function displayedGrams(item: RecipeItem, cookingScale: number): number {
  return itemGrams(item) * cookingScale;
}

/** What the meal contributed to the day: the frozen snapshot times the portions eaten. */
export function mealMacros(meal: PlannedMeal): Macros {
  return scaleMacros(meal.macroSnapshot, meal.portionsEaten);
}

/** The day's totals — the sum over its meals, in array order. */
export function dayTotals(day: Day): Macros {
  return sumMacros(day.meals.map(mealMacros));
}

/** Per-macro remainder against a goal. Negative means the goal was exceeded. */
export function remainingMacros(goal: Macros, eaten: Macros): Macros {
  return addMacros(goal, scaleMacros(eaten, -1));
}
