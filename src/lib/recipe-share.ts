import type { Recipe, RecipeItem } from './types';
import type { IngredientLookup } from './macros';
import { displayedAmount, displayedGrams } from './macros';
import { formatMeasureAmount, formatPortions } from './text';

/**
 * A recipe as text for somebody else to cook (PLAN.md Phase 22) — `menu.ts` and `shopping.ts`'
 * twin: a recipe at a chosen number of portions becomes plain text, and `shareText` gets it out
 * of the app. No I/O and no clock here; the caller hands in the rows and the lookup.
 *
 * **The rows are passed separately from the recipe** so the caller decides what is being
 * cooked: the editor passes `recipe.items`, a planned meal passes `effectiveItems` — the seam
 * every other reader of a planned meal goes through (STATE.md decision 410).
 *
 * **In the recipe's own order, unmerged and ungrouped** (decision 411). The shopping list is
 * read in a shop and grouped by department; this is read at a stove, next to instructions that
 * follow the order the recipe was written in.
 *
 * **The instructions are verbatim and never scaled** (decision 413): they are free text, and a
 * number inside them is not an amount this app knows about. The sheet says so; the text does
 * not.
 *
 * **No macros, no source link, no footer** (decision 414). The recipient is cooking, not
 * counting, and a signature in someone else's message is an advert.
 *
 * Plain text, no WhatsApp `*bold*`, for `formatShoppingList`'s reason: the share sheet reaches
 * apps that print the asterisks literally.
 */

/** The part of a recipe the text is written from — the rows come separately. */
export type SharedRecipe = Pick<Recipe, 'name' | 'prepMinutes' | 'instructions'>;

/**
 * One ingredient line, without the bullet: „Czosnek — 2 ząbki (10 g)", „Ryż — 300 g".
 *
 * Grams in brackets after a `szt` row only (decision 412): „3 szt." and „2 ząbki" say nothing
 * about weight, „300 g (300 g)" repeats itself, and in a kitchen milk is poured, not weighed —
 * which is where this deliberately parts from the shopping list's `showGrams`. A `szt` row
 * with no weight to give prints no brackets rather than „(0 g)".
 */
export function formatRecipeIngredient(
  item: RecipeItem,
  portions: number,
  lookup: IngredientLookup
): string {
  // A row whose ingredient is gone is still on the recipe — the meal screen's words for it.
  const name = lookup(item.ingredientId)?.name ?? 'Nieznany składnik';
  const amount = formatMeasureAmount(displayedAmount(item, portions), item.unit, item.measureName);
  const grams = displayedGrams(item, portions);
  return item.unit === 'szt' && grams > 0
    ? `${name} — ${amount} (${Math.round(grams)} g)`
    : `${name} — ${amount}`;
}

/** „3 porcje · 40 min", or just „3 porcje" for a recipe nobody has timed. */
function portionsLine(recipe: SharedRecipe, portions: number): string {
  const time = recipe.prepMinutes === undefined ? '' : ` · ${recipe.prepMinutes} min`;
  return `${formatPortions(portions)}${time}`;
}

/** The whole recipe as plain text at `portions`, in the shape the other two exports have. */
export function formatRecipeShare(
  recipe: SharedRecipe,
  items: readonly RecipeItem[],
  portions: number,
  lookup: IngredientLookup
): string {
  // An empty `ingredientId` is a row that was never filled in — there is nothing to name.
  const rows = items.filter((item) => item.ingredientId !== '');
  const ingredients =
    rows.length === 0
      ? 'Brak składników.'
      : rows.map((item) => `• ${formatRecipeIngredient(item, portions, lookup)}`).join('\n');

  let text = `${recipe.name}\n${portionsLine(recipe, portions)}\n\nSkładniki:\n${ingredients}\n`;
  const instructions = recipe.instructions.trim();
  if (instructions !== '') text += `\nPrzygotowanie:\n${instructions}\n`;
  return text;
}
