import type { Day, Macros, PlannedMeal, Recipe } from './types';
import type { IdFactory } from './ids';
import { newId } from './ids';
import { recipePortionMacros, type IngredientLookup } from './macros';

/**
 * Day and meal operations, pure. Nothing here touches the database or generates ids on its
 * own unless handed an `IdFactory`, so every rule below is testable in isolation.
 *
 * Copy semantics (PLAN.md): every copy is a deep copy with a new id that carries the source
 * `macroSnapshot` over verbatim. Snapshots are never recomputed, which is what makes a copy
 * independent of later edits to the recipe it came from.
 */

/** What to do when copying meals onto a day that already has some. */
export type CopyMode = 'append' | 'replace';

/** Construct a `Day` without ever writing an explicit `undefined` goalSnapshot. */
function makeDay(date: string, meals: PlannedMeal[], goalSnapshot: Macros | undefined): Day {
  return goalSnapshot === undefined ? { date, meals } : { date, meals, goalSnapshot };
}

export function emptyDay(date: string): Day {
  return { date, meals: [] };
}

export function findMeal(day: Day, mealId: string): PlannedMeal | undefined {
  return day.meals.find((meal) => meal.id === mealId);
}

/**
 * `goalSnapshot` is captured the moment a day gains its first meal, and only then — later
 * goal changes must not rewrite history. A day emptied of all meals drops the snapshot
 * again, so re-planning it captures the goals in force at that time.
 */
export function withGoals(day: Day, goals: Macros | undefined): Day {
  if (day.meals.length === 0) return emptyDay(day.date);
  if (day.goalSnapshot !== undefined || goals === undefined) return day;
  return { ...day, goalSnapshot: { ...goals } };
}

/** Freeze a recipe into a plannable meal: one portion's macros, captured now. */
export function planMeal(
  recipe: Recipe,
  lookup: IngredientLookup,
  options: { id?: string; cookingScale?: number; portionsEaten?: number } = {}
): PlannedMeal {
  return {
    id: options.id ?? newId(),
    recipeId: recipe.id,
    cookingScale: options.cookingScale ?? 1,
    portionsEaten: options.portionsEaten ?? 1,
    macroSnapshot: recipePortionMacros(recipe, lookup)
  };
}

/**
 * Deep copy of a meal under a new id. `macroSnapshot` is copied value-for-value into a fresh
 * object: identical numbers, no shared reference back to the original.
 */
export function clonePlannedMeal(meal: PlannedMeal, id: string): PlannedMeal {
  return {
    id,
    recipeId: meal.recipeId,
    cookingScale: meal.cookingScale,
    portionsEaten: meal.portionsEaten,
    macroSnapshot: { ...meal.macroSnapshot }
  };
}

/** Deep copies of a whole list, each under a fresh id, order preserved. */
export function clonePlannedMeals(
  meals: readonly PlannedMeal[],
  nextId: IdFactory = newId
): PlannedMeal[] {
  return meals.map((meal) => clonePlannedMeal(meal, nextId()));
}

/** Append meals to the end of the day, capturing goals if this is the day's first meal. */
export function addMeals(
  day: Day,
  meals: readonly PlannedMeal[],
  goals?: Macros
): Day {
  if (meals.length === 0) return day;
  return withGoals(makeDay(day.date, [...day.meals, ...meals], day.goalSnapshot), goals);
}

/** Remove one meal. Removing the last one resets the day to empty. */
export function removeMeal(day: Day, mealId: string): Day {
  const meals = day.meals.filter((meal) => meal.id !== mealId);
  if (meals.length === day.meals.length) return day;
  if (meals.length === 0) return emptyDay(day.date);
  return makeDay(day.date, meals, day.goalSnapshot);
}

/** "Wyczyść dzień" — the day goes back to having never been planned. */
export function clearDay(day: Day): Day {
  return emptyDay(day.date);
}

/** Move a meal within the day. Array order is the display order. */
export function reorderMeals(day: Day, from: number, to: number): Day {
  const meals = [...day.meals];
  const [moved] = meals.splice(from, 1);
  if (moved === undefined) return day;
  meals.splice(to, 0, moved);
  return makeDay(day.date, meals, day.goalSnapshot);
}

/**
 * Reorder the day to match `mealIds` exactly. The drag library hands back its own array of
 * items, but those objects came out of `$state` and are proxies that IndexedDB refuses to
 * clone (STATE.md decisions 56 and 77) — so the new order travels as plain ids and the meals
 * themselves are taken from the day we already hold.
 *
 * Ids that name no meal on this day are ignored, and meals the list forgot keep their
 * relative order at the end, so a stale list can never silently drop a meal.
 */
export function orderMeals(day: Day, mealIds: readonly string[]): Day {
  const remaining = new Map(day.meals.map((meal) => [meal.id, meal]));
  const meals: PlannedMeal[] = [];

  for (const id of mealIds) {
    const meal = remaining.get(id);
    if (meal === undefined) continue;
    remaining.delete(id);
    meals.push(meal);
  }
  meals.push(...remaining.values());

  return makeDay(day.date, meals, day.goalSnapshot);
}

/** The fields of a planned meal the meal view is allowed to change. */
export type MealChanges = Partial<Pick<PlannedMeal, 'cookingScale' | 'portionsEaten'>>;

/**
 * Patch one meal's `cookingScale` or `portionsEaten`. `macroSnapshot` is deliberately not
 * patchable here — the only thing allowed to rewrite it is `resnapshotMeals`.
 */
export function updateMeal(day: Day, mealId: string, changes: MealChanges): Day {
  if (!day.meals.some((meal) => meal.id === mealId)) return day;

  const meals = day.meals.map((meal) =>
    meal.id === mealId
      ? {
          ...meal,
          cookingScale: changes.cookingScale ?? meal.cookingScale,
          portionsEaten: changes.portionsEaten ?? meal.portionsEaten,
          macroSnapshot: { ...meal.macroSnapshot }
        }
      : meal
  );
  return makeDay(day.date, meals, day.goalSnapshot);
}

/**
 * `duplicateMeal` — a copy of one meal, inserted directly after the original so the
 * duplicate appears next to what it was copied from.
 */
export function duplicateMealInDay(day: Day, mealId: string, id: string): Day {
  const index = day.meals.findIndex((meal) => meal.id === mealId);
  const source = day.meals[index];
  if (source === undefined) return day;

  const meals = [...day.meals];
  meals.splice(index + 1, 0, clonePlannedMeal(source, id));
  return makeDay(day.date, meals, day.goalSnapshot);
}

/**
 * Land copies of `meals` on `day`. `append` keeps what is already there (the default
 * everywhere in the UI); `replace` discards it. The incoming meals are cloned here, so the
 * caller can hand over the source day's meals directly.
 *
 * `replace` is "clear the day, then add", so it also drops the old `goalSnapshot` and
 * recaptures the current goals — same as clearing the day by hand and planning it again.
 */
export function copyMealsInto(
  day: Day,
  meals: readonly PlannedMeal[],
  mode: CopyMode,
  options: { nextId?: IdFactory; goals?: Macros } = {}
): Day {
  const copies = clonePlannedMeals(meals, options.nextId ?? newId);
  const base = mode === 'replace' ? emptyDay(day.date) : day;
  return addMeals(base, copies, options.goals);
}

/**
 * Rewrite the frozen snapshot of every meal on this day that came from `recipeId`.
 *
 * This is the one operation allowed to touch a `macroSnapshot` after the fact, and it
 * exists only for "update future days" on a recipe edit (PLAN.md; STATE.md decisions 49-50).
 * `cookingScale` and `portionsEaten` are the user's own numbers and are left alone. A day
 * with no meal from that recipe is returned unchanged, identity included, so a caller can
 * skip the write.
 */
export function resnapshotMeals(day: Day, recipeId: string, macros: Macros): Day {
  if (!day.meals.some((meal) => meal.recipeId === recipeId)) return day;

  const meals = day.meals.map((meal) =>
    meal.recipeId === recipeId ? { ...meal, macroSnapshot: { ...macros } } : meal
  );
  return makeDay(day.date, meals, day.goalSnapshot);
}

/** How many meals on this day came from `recipeId`. */
export function countMealsFromRecipe(day: Day, recipeId: string): number {
  return day.meals.filter((meal) => meal.recipeId === recipeId).length;
}
