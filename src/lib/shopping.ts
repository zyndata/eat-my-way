import type { Department, Ingredient, MeasureName, PlannedMeal, Recipe, Unit } from './types';
import type { IngredientLookup } from './macros';
import { displayedAmount, displayedGrams, isRecipeItemComplete } from './macros';
import { DEPARTMENT_LABELS, departmentIndex, departmentOf } from './departments';
import { formatMeasureAmount } from './text';
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
 *
 * **Phase 17 reverses one stated intent of this file.** The order used to be the order the
 * ingredients were first met, „so a list reads like the recipes it came from". A list is read
 * in a shop, though, where flour between two vegetables costs a walk back across the building,
 * so lines are now grouped by department in the order a shop is walked (STATE.md decision 329).
 * Within a department the old order is kept exactly, so a department still reads the way the
 * whole list used to.
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
  /**
   * The household measure this line prints itself in — „2 ząbki" rather than „2 szt.".
   *
   * Kept only while every row that merged into the line agrees (STATE.md decision 351). Rows
   * are summed by `ingredientId + unit`, so a recipe counting cloves and one counting plain
   * pieces land together; printing either label would be a claim about the other recipe's row,
   * so the line falls back to „szt." instead, which is what it said before measures existed
   * and is true of both. The same holds of the units merged afterwards (`mergeUnits`): a
   * weighed row carries no label, but it says nothing about the label either, so it does not
   * drop one the counted rows agree on.
   */
  measureName?: MeasureName;
  /**
   * Which part of the shop this line is bought in — the ingredient's, or `inne` when it has
   * none and when the ingredient is gone from the database altogether. Always set, because a
   * line has to print under some heading; „not chosen" is a fact about an ingredient, not
   * about a list (STATE.md decision 330).
   */
  department: Department;
}

/** One heading of a shopping list, and the lines under it. Never empty — see `groupByDepartment`. */
export interface ShoppingGroup {
  department: Department;
  /** The Polish heading, so a caller prints it without reaching for the label table. */
  label: string;
  lines: ShoppingLine[];
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
 * Collapse the lines of one ingredient that differ only in the unit they were typed in.
 *
 * Reported from a real week's list: „Cebula — 100 g" directly above „Cebula — 1 szt. (80 g)",
 * because one recipe counted the onion and another weighed it. Keying by `ingredientId + unit`
 * is right for *adding* — 2 szt and 100 g cannot be summed as they stand — but it is the wrong
 * thing to *print*: a shopping list is read in a shop, where two lines for one onion are two
 * things to look for and one of them gets bought twice (STATE.md decision 432).
 *
 * Grams are the common denominator and every row already carries them, so the lines are summed
 * in grams and the result is printed in the unit the ingredient is actually bought in:
 *
 *   - the `szt` line wins, because that is how a shop sells onions, eggs and lemons. The pieces
 *     come back out of the grams at the weight that line itself used, so the total still weighs
 *     exactly what the recipes asked for — and its household measure survives untouched, since
 *     a weighed row makes no claim about the label (decision 351 was already applied when the
 *     `szt` rows were summed into that one line);
 *   - with no `szt` line — millilitres against grams — the line falls back to grams. Note that
 *     an `ml` row with no density weighs 1 g/ml (`gramsPerUnit` in `macros.ts`), the same
 *     water-like default the macros and the „(500 g)" already printed after „500 ml" rest on,
 *     so „500 ml" of density-less milk plus „50 g" reads „550 g".
 *
 * Two things hold a group apart. An ingredient with a **half-typed row** — `szt` and no weight,
 * which the editor flags but still saves — is `unfinished`: its grams are unknown, not zero, and
 * folding them into a total would quietly delete them, so its lines are left exactly as they
 * were. And a group has to have two rows that **say something**: „250 ml" beside a stray „0 g"
 * is one fact, not two to reconcile, and stays as typed.
 */
function mergeUnits(
  lines: readonly ShoppingLine[],
  unfinished: ReadonlySet<string>
): ShoppingLine[] {
  const byIngredient = new Map<string, ShoppingLine[]>();
  for (const line of lines) {
    const group = byIngredient.get(line.ingredientId);
    if (group === undefined) byIngredient.set(line.ingredientId, [line]);
    else group.push(line);
  }

  // A `Map` keeps insertion order, so each group comes out where its first line was met and
  // the walk order never moves.
  const merged: ShoppingLine[] = [];
  for (const [ingredientId, group] of byIngredient) {
    const spoken = group.filter((row) => row.amount > 0).length;
    if (spoken < 2 || unfinished.has(ingredientId)) {
      merged.push(...group);
      continue;
    }

    const { name, department } = group[0] as ShoppingLine;
    const grams = group.reduce((sum, row) => sum + row.grams, 0);
    // At most one, because the lines were summed by `ingredientId + unit`.
    const counted = group.find((row) => row.unit === 'szt');

    if (counted !== undefined && counted.amount > 0 && counted.grams > 0) {
      merged.push({
        ingredientId,
        name,
        department,
        unit: 'szt',
        amount: (grams * counted.amount) / counted.grams,
        grams,
        ...(counted.measureName === undefined ? {} : { measureName: counted.measureName })
      });
      continue;
    }

    merged.push({ ingredientId, name, department, unit: 'g', amount: grams, grams });
  }
  return merged;
}

/**
 * Sum the ingredients of every meal in the scope.
 *
 * Rows are summed by ingredient **and unit**: 2 szt and 100 g of the same thing cannot be
 * added as they stand. They do not stay two lines, though — `mergeUnits` puts one ingredient
 * back on one line through the grams both rows carry (decision 432).
 *
 * The order is the shop's: by department first, and within a department by the order the
 * ingredients were first met (decision 329). The sort is stable, which is what makes the second
 * half of that sentence true without the first half having to know anything about it.
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
  // Ingredients with a row that weighs nothing because nobody has said what a piece weighs.
  // Judged here, on the `RecipeItem`, because once rows are summed a half-typed „2 szt" hides
  // behind another recipe's „1 szt (5 g)" and the line as a whole looks weighed.
  const unfinished = new Set<string>();
  const scales = cookedScales(meals);

  for (const [index, { meal, recipe }] of meals.entries()) {
    if (recipe === undefined) continue;
    const scale = scales[index] ?? meal.cookingScale;
    if (scale === 0) continue;

    for (const item of effectiveItems(recipe, meal.adjustments)) {
      if (item.ingredientId === '') continue;
      if (!isRecipeItemComplete(item)) unfinished.add(item.ingredientId);

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
          grams,
          ...(item.measureName === undefined ? {} : { measureName: item.measureName }),
          department: departmentOf(ingredient)
        });
        continue;
      }

      existing.amount += amount;
      existing.grams += grams;
      // Disagreement drops the label for good — see `ShoppingLine.measureName`.
      if (existing.measureName !== item.measureName) delete existing.measureName;
    }
  }

  return mergeUnits([...lines.values()], unfinished).sort(
    (a, b) => departmentIndex(a.department) - departmentIndex(b.department)
  );
}

/**
 * The lines under their headings, in walk order, **with empty departments left out**.
 *
 * One function for both readers of a list — the sheet on screen and the shared text — so the
 * two can never disagree about what is grouped where or which headings exist.
 */
export function groupByDepartment(lines: readonly ShoppingLine[]): ShoppingGroup[] {
  const groups = new Map<Department, ShoppingGroup>();
  for (const line of lines) {
    const group = groups.get(line.department);
    if (group === undefined) {
      groups.set(line.department, {
        department: line.department,
        label: DEPARTMENT_LABELS[line.department],
        lines: [line]
      });
      continue;
    }
    group.lines.push(line);
  }
  return [...groups.values()].sort(
    (a, b) => departmentIndex(a.department) - departmentIndex(b.department)
  );
}

/** One line as the share sheet will show it: „Pierś z kurczaka — 400 g", „Czosnek — 2 ząbki (10 g)". */
export function formatShoppingLine(line: ShoppingLine): string {
  const amount = formatMeasureAmount(line.amount, line.unit, line.measureName);
  return showGrams(line)
    ? `${line.name} — ${amount} (${Math.round(line.grams)} g)`
    : `${line.name} — ${amount}`;
}

/**
 * The whole list as plain text. Plain text on purpose: it is what a share target accepts,
 * what a clipboard paste produces everywhere, and what a person can still read when the app
 * it was shared into turns out not to parse anything.
 *
 * Headings included, for the same reason they are on screen: this is the copy that is actually
 * carried around a shop, in whatever messenger it was pasted into.
 */
export function formatShoppingList(title: string, lines: readonly ShoppingLine[]): string {
  const body =
    lines.length === 0
      ? 'Brak składników do kupienia.'
      : groupByDepartment(lines)
          .map(
            (group) =>
              `${group.label}\n` +
              group.lines.map((line) => `• ${formatShoppingLine(line)}`).join('\n')
          )
          .join('\n\n');
  return `${title}\n\n${body}\n`;
}
