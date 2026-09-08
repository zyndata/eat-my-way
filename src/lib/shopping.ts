import type { Ingredient, PlannedMeal, Recipe, Unit } from './types';
import type { IngredientLookup } from './macros';
import { displayedAmount, displayedGrams } from './macros';
import { formatAmountWithUnit } from './text';
import { effectiveItems } from './adjustments';

/**
 * Shopping lists (PLAN.md Phase 9 task 7).
 *
 * The list is what has to be *bought and cooked*, so every amount goes through
 * `cookingScale` and none of them through `portionsEaten`: cooking a double batch and eating
 * half of it still means buying the double batch. That is the whole reason the two numbers
 * are separate fields (STATE.md decision 62 and PLAN.md's macro invariants).
 *
 * Nothing here touches the network. The list leaves through `navigator.share()` or the
 * clipboard, neither of which is governed by `connect-src`, so the feature costs no CSP
 * change at all (STATE.md decisions 144 and 158).
 */

/** One line of a shopping list: an ingredient, in one unit, summed over the scope. */
export interface ShoppingLine {
  ingredientId: string;
  /** Polish display name, or a placeholder when the ingredient is gone from the database. */
  name: string;
  unit: Unit;
  /** Amount in `unit`, summed. */
  amount: number;
  /** The same amount in grams, so a `szt` line can still be weighed. */
  grams: number;
}

/** A planned meal paired with the recipe it came from, which is what a list is built out of. */
export interface ShoppingMeal {
  meal: PlannedMeal;
  /** `undefined` when the recipe was deleted — such a meal contributes no ingredients. */
  recipe: Recipe | undefined;
  /**
   * The day the meal is planned on. Optional because a single-meal list has nothing to
   * compare against; without it, `cookedScales` counts every meal as its own cook, which is
   * exactly what this module did before batches existed.
   */
  date?: string;
}

/**
 * How much of each meal actually has to be *cooked*, and therefore bought.
 *
 * `cookingScale` alone over-counts a pot eaten over several days: „Gotuję na 2 dni" writes
 * scale 2 on the cooking day and a `cookingScale: 1` copy on the next, so a list covering both
 * days bought three portions for a two-day cook. The planner writes batches the same way
 * (STATE.md decisions 265 and 275), so a generated week would over-buy on every run.
 *
 * A ledger rather than a flag, because nothing in `PlannedMeal` says „this one is leftovers"
 * and nothing should: walk each recipe's meals in scope order and keep what has been cooked
 * and not yet eaten. A meal **on a later day** that comes out of that pot buys nothing.
 *
 * The „later day" is what keeps this narrow. Two servings of one recipe on the *same* day are
 * two plates off one cook and the list has always counted both scales — that is the rule
 * „follows the batch, not the plate" (Phase 9). Leftovers are a next-day thing, and only that
 * case is suppressed here.
 */
const POT_EPSILON = 1e-9;

/** What is cooked and not yet eaten of one recipe, and the last day it was cooked on. */
interface Pot {
  cookedOn: string;
  left: number;
}

export function cookedScales(meals: readonly ShoppingMeal[]): number[] {
  const pots = new Map<string, Pot>();

  return meals.map(({ meal, date }) => {
    const pot = pots.get(meal.recipeId);
    // `left > 0` matters: a meal that eats nothing at all is still a pot that has to be bought.
    if (
      pot !== undefined &&
      date !== undefined &&
      pot.cookedOn < date &&
      pot.left > POT_EPSILON &&
      pot.left + POT_EPSILON >= meal.portionsEaten
    ) {
      pot.left -= meal.portionsEaten;
      return 0;
    }

    pots.set(meal.recipeId, {
      cookedOn: date ?? '',
      left: Math.max(0, (pot?.left ?? 0) + meal.cookingScale - meal.portionsEaten)
    });
    return meal.cookingScale;
  });
}

/** Grams a line prints only when they say something the amount does not. */
function showGrams(line: ShoppingLine): boolean {
  return line.unit !== 'g' && line.grams > 0;
}

/**
 * Sum the ingredients of every meal in the scope.
 *
 * Lines are keyed by ingredient **and unit**: 2 szt and 100 g of the same thing cannot be
 * added, and pretending otherwise would print a number nobody can shop by. The order is the
 * order the ingredients were first met, so a list reads like the recipes it came from.
 *
 * A meal whose recipe was deleted contributes nothing. Its macros still count towards the
 * day (STATE.md decisions 51 and 73) — but there is no ingredient list left to buy.
 *
 * Neither does a day eating yesterday's pot — see `cookedScales`.
 */
export function shoppingLines(
  meals: readonly ShoppingMeal[],
  lookup: IngredientLookup
): ShoppingLine[] {
  const lines = new Map<string, ShoppingLine>();
  const scales = cookedScales(meals);

  for (const [index, { meal, recipe }] of meals.entries()) {
    if (recipe === undefined) continue;
    const scale = scales[index] ?? meal.cookingScale;
    if (scale === 0) continue;

    for (const item of effectiveItems(recipe, meal.adjustments)) {
      if (item.ingredientId === '') continue;

      const key = `${item.ingredientId} ${item.unit}`;
      const existing = lines.get(key);
      const amount = displayedAmount(item, scale);
      const grams = displayedGrams(item, scale);

      if (existing === undefined) {
        const ingredient: Ingredient | undefined = lookup(item.ingredientId);
        lines.set(key, {
          ingredientId: item.ingredientId,
          name: ingredient?.name ?? 'Nieznany składnik',
          unit: item.unit,
          amount,
          grams
        });
        continue;
      }

      existing.amount += amount;
      existing.grams += grams;
    }
  }

  return [...lines.values()];
}

/** One line as the share sheet will show it: „Pierś z kurczaka — 400 g". */
export function formatShoppingLine(line: ShoppingLine): string {
  const amount = formatAmountWithUnit(line.amount, line.unit);
  return showGrams(line)
    ? `${line.name} — ${amount} (${Math.round(line.grams)} g)`
    : `${line.name} — ${amount}`;
}

/**
 * The whole list as plain text. Plain text on purpose: it is what a share target accepts,
 * what a clipboard paste produces everywhere, and what a person can still read when the app
 * it was shared into turns out not to parse anything.
 */
export function formatShoppingList(title: string, lines: readonly ShoppingLine[]): string {
  const body =
    lines.length === 0
      ? 'Brak składników do kupienia.'
      : lines.map((line) => `• ${formatShoppingLine(line)}`).join('\n');
  return `${title}\n\n${body}\n`;
}
