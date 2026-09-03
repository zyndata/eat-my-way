import type { Ingredient, IngredientState, Macros, RecipeItem } from './types';
import { COPY_SUFFIX } from './recipes';
import { newCustomIngredientId, type IdFactory } from './ids';

/**
 * The rules behind „Składniki" (PLAN.md Phase 10). Pure: no IndexedDB, no clock, no Svelte —
 * the repository writes what these produce and the screen renders it.
 *
 * Two of them are the whole point of the phase:
 *
 * - **Only `custom:*` rows may be written.** A bundled row edited in place would be
 *   overwritten by the next `importBundledNutrition` and would never reach another device,
 *   because `syncSnapshot` uploads custom rows only (STATE.md decision 176).
 * - **Every macro must be entered, and `0` counts as entered.** The old form mapped an
 *   untouched field to `0`, so an ingredient saved „to finish later" read as 0 kcal in every
 *   recipe using it and nothing ever said so (decision 178).
 */

/** True for an ingredient this app is allowed to edit or delete. */
export function isCustom(ingredient: Ingredient): boolean {
  return ingredient.source === 'custom';
}

/**
 * The form's working copy. The four macros are `number | null` rather than `number`: `null`
 * is „not entered yet" and `0` is a value the user chose, and the difference is exactly what
 * decision 178 is about.
 */
export interface IngredientDraft {
  name: string;
  state: IngredientState;
  /** As typed — one line, comma-separated. Split only on the way to an `Ingredient`. */
  aliases: string;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export function emptyIngredientDraft(name = ''): IngredientDraft {
  return { name, state: 'raw', aliases: '', kcal: null, protein: null, carbs: null, fat: null };
}

export function draftFromIngredient(ingredient: Ingredient): IngredientDraft {
  return {
    name: ingredient.name,
    state: ingredient.state,
    aliases: ingredient.aliases.join(', '),
    kcal: ingredient.per100g.kcal,
    protein: ingredient.per100g.protein,
    carbs: ingredient.per100g.carbs,
    fat: ingredient.per100g.fat
  };
}

/**
 * „Kopiuj i edytuj" on a bundled row: the source's values and `state`, the recipe library's
 * own copy suffix, and deliberately **no aliases** — two rows answering to the same alias
 * would put both into one autocomplete and into Gemini's candidate list, which is the
 * ambiguity this screen exists to reduce (STATE.md decision 177).
 */
export function draftForCopy(ingredient: Ingredient): IngredientDraft {
  return { ...draftFromIngredient(ingredient), name: `${ingredient.name}${COPY_SUFFIX}`, aliases: '' };
}

/** One alias per comma, trimmed, without blanks or duplicates. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const alias of text.split(',')) {
    const trimmed = alias.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    aliases.push(trimmed);
  }
  return aliases;
}

const MACRO_FIELDS = ['kcal', 'protein', 'carbs', 'fat'] as const;

/** A field counts as entered when it holds a finite number — `0` included. */
function entered(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * Why this draft cannot be saved yet, as the sentence the form prints, or `null` when it can.
 * A reason is always shown next to a disabled button: „the button is grey" is not an answer.
 */
export function draftProblem(draft: IngredientDraft): string | null {
  if (draft.name.trim() === '') return 'Składnik musi mieć nazwę.';
  const missing = MACRO_FIELDS.filter((field) => !entered(draft[field]));
  if (missing.length > 0) {
    return 'Podaj wszystkie wartości na 100 g. Jeśli składnik czegoś nie zawiera, wpisz 0.';
  }
  if (MACRO_FIELDS.some((field) => (draft[field] as number) < 0)) {
    return 'Wartości na 100 g nie mogą być ujemne.';
  }
  return null;
}

export function canSaveDraft(draft: IngredientDraft): boolean {
  return draftProblem(draft) === null;
}

/** The four values, once `draftProblem` has confirmed there are four. */
export function draftMacros(draft: IngredientDraft): Macros {
  return {
    kcal: draft.kcal ?? 0,
    protein: draft.protein ?? 0,
    carbs: draft.carbs ?? 0,
    fat: draft.fat ?? 0
  };
}

/**
 * The ingredient this draft describes. `id` is kept when editing and minted when creating,
 * and `source` is always `custom` — there is no path here that writes a bundled row.
 */
export function draftToIngredient(
  draft: IngredientDraft,
  options: { id?: string; nextId?: IdFactory } = {}
): Ingredient {
  return {
    id: options.id ?? newCustomIngredientId(options.nextId),
    name: draft.name.trim(),
    aliases: parseAliases(draft.aliases),
    state: draft.state,
    per100g: draftMacros(draft),
    source: 'custom'
  };
}

/** True when the two sets of per-100 g values differ in any field. */
export function macrosDiffer(before: Macros, after: Macros): boolean {
  return MACRO_FIELDS.some((field) => before[field] !== after[field]);
}

/**
 * Point every item at `to` instead of `from`, leaving the rest of each item exactly as it
 * was: the amount, the unit, `gramsPerUnit` and any manual `macroOverride` are the user's
 * measurements of *their* recipe and mean the same thing after the swap. Only identity moves
 * (STATE.md decision 180).
 *
 * Returns the same array when nothing referred to `from`, so a caller can skip the write.
 */
export function replaceIngredientInItems(
  items: readonly RecipeItem[],
  from: string,
  to: string
): RecipeItem[] {
  if (!items.some((item) => item.ingredientId === from)) return items as RecipeItem[];
  return items.map((item) => (item.ingredientId === from ? { ...item, ingredientId: to } : item));
}

/**
 * Refusing to delete an ingredient a recipe still refers to. Thrown by the repository rather
 * than only checked in the screen: an item pointing at a missing id falls back to
 * `ZERO_MACROS`, so an unguarded delete would drop a recipe's numbers without a word.
 */
export class IngredientInUseError extends Error {
  constructor(
    readonly ingredientId: string,
    readonly recipeNames: readonly string[]
  ) {
    super(`Ingredient ${ingredientId} is used by ${recipeNames.length} recipe(s)`);
    this.name = 'IngredientInUseError';
  }
}

/** Refusing to write a bundled row. Same reasoning, one level up: it would not survive. */
export class NotCustomIngredientError extends Error {
  constructor(readonly ingredientId: string) {
    super(`Ingredient ${ingredientId} is not a custom row`);
    this.name = 'NotCustomIngredientError';
  }
}
