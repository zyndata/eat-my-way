import type {
  Department,
  Ingredient,
  IngredientState,
  Macros,
  Measure,
  MeasureName,
  RecipeItem
} from './types';
import { COPY_SUFFIX } from './recipes';
import { newCustomIngredientId, newId, type IdFactory } from './ids';
import { MEASURE_NAMES, formatAmount } from './text';

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
 *   recipe using it and nothing ever said so (decision 178). A household measure's weight is
 *   held to the same rule from Phase 16 on: a measure weighing nothing is not a measure.
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
  /** Household measures this ingredient offers (Phase 16). Empty is a complete ingredient. */
  measures: MeasureDraft[];
  /**
   * Which part of the shop it is bought in (Phase 17). `''` is „not chosen", which is a
   * complete ingredient too: it shops under „Inne" and nothing ever blocks a save on it
   * (decision 330). The `<select>` binds to this directly, which is why it is `''` and not
   * `undefined` — an empty `<option>` value reads back as the empty string.
   */
  department: Department | '';
}

/**
 * One measure row while it is being edited. `grams` is `number | null` for the same reason
 * the macros are: `null` is „not typed yet" and an emptied number input reads back as exactly
 * that, so the field must not fight the user mid-typing (decision 54).
 */
export interface MeasureDraft {
  /** Local row identity for the `{#each}` block. Never stored. */
  id: string;
  name: MeasureName;
  grams: number | null;
}

/** The first measure a fresh row offers — the one nearly every ingredient can be counted in. */
export const DEFAULT_MEASURE_NAME: MeasureName = MEASURE_NAMES[0];

export function emptyIngredientDraft(name = ''): IngredientDraft {
  return {
    name,
    state: 'raw',
    aliases: '',
    kcal: null,
    protein: null,
    carbs: null,
    fat: null,
    measures: [],
    department: ''
  };
}

/** A measure row to append: the first name nothing on the draft already uses. */
export function emptyMeasureDraft(draft: IngredientDraft, id: string): MeasureDraft {
  const used = new Set(draft.measures.map((measure) => measure.name));
  return {
    id,
    name: MEASURE_NAMES.find((name) => !used.has(name)) ?? DEFAULT_MEASURE_NAME,
    grams: null
  };
}

export function draftFromIngredient(
  ingredient: Ingredient,
  nextId: IdFactory = newId
): IngredientDraft {
  return {
    name: ingredient.name,
    state: ingredient.state,
    aliases: ingredient.aliases.join(', '),
    kcal: ingredient.per100g.kcal,
    protein: ingredient.per100g.protein,
    carbs: ingredient.per100g.carbs,
    fat: ingredient.per100g.fat,
    measures: (ingredient.measures ?? []).map((measure) => ({
      id: nextId(),
      name: measure.name,
      grams: measure.grams
    })),
    department: ingredient.department ?? ''
  };
}

/**
 * „Kopiuj i edytuj" on a bundled row: the source's values and `state`, the recipe library's
 * own copy suffix, and deliberately **no aliases** — two rows answering to the same alias
 * would put both into one autocomplete and into Gemini's candidate list, which is the
 * ambiguity this screen exists to reduce (STATE.md decision 177).
 */
export function draftForCopy(
  ingredient: Ingredient,
  nextId: IdFactory = newId
): IngredientDraft {
  return {
    // Measures come along with the macros: they describe the food, and „Kopiuj i edytuj" on a
    // bundled row exists precisely so the copy starts as that food. Only the aliases are
    // dropped, for decision 177's reason — two rows answering to one alias.
    ...draftFromIngredient(ingredient, nextId),
    name: `${ingredient.name}${COPY_SUFFIX}`,
    aliases: ''
  };
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

/** One of the four per-100 g values. */
export type MacroField = (typeof MACRO_FIELDS)[number];

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
  if (draft.measures.some((measure) => !entered(measure.grams) || measure.grams <= 0)) {
    return 'Miara domowa musi ważyć więcej niż 0 g. Usuń wiersz albo podaj wagę.';
  }
  const names = draft.measures.map((measure) => measure.name);
  if (new Set(names).size !== names.length) {
    return 'Każdą miarę domową można podać tylko raz.';
  }
  return null;
}

export function canSaveDraft(draft: IngredientDraft): boolean {
  return draftProblem(draft) === null;
}

// ---- are these numbers even possible? (PLAN.md Phase 18 task A) --------------------------

/**
 * `draftProblem` asks whether the four values are *there*. These ask whether they are
 * *possible* — and they never block (STATE.md decision 331). Fibre, alcohol and polyols miss
 * Atwater honestly, so a form that refused a package would be wrong more often than the
 * package is. `draftProblem` keeps owning the disabled button; this owns a sentence under
 * the fields.
 *
 * It matters most where the numbers are not typed at all: the reading Gemini takes off a
 * photographed label, where a decimal point in the wrong place is silent. So the sentence
 * names the scanned fields it implicates, because those are the ones worth looking at twice.
 */

/** kcal per gram — the Atwater factors the energy rule is checked against. */
const ATWATER: Readonly<Record<Exclude<MacroField, 'kcal'>, number>> = { protein: 4, carbs: 4, fat: 9 };

/** More than this many grams of macronutrient in 100 g of food is arithmetic, not nutrition. */
export const MAX_MACRO_GRAMS = 100;

/** How far the stated energy may sit from what the macros imply: a share… */
export const ENERGY_TOLERANCE = 0.15;
/** …and never less than this, so a 15 kcal vegetable does not trip on rounding (decision 332). */
export const ENERGY_FLOOR_KCAL = 20;

/** What the three macronutrients weigh together, per 100 g. */
export function macroGrams(macros: Macros): number {
  return macros.protein + macros.carbs + macros.fat;
}

/** The energy those three imply, by Atwater. */
export function impliedKcal(macros: Macros): number {
  return macros.protein * ATWATER.protein + macros.carbs * ATWATER.carbs + macros.fat * ATWATER.fat;
}

/** Which rule a draft trips, if any. */
export type SanityRule =
  /** protein + carbs + fat over 100 g per 100 g. */
  | 'sum'
  /** The stated kcal too far from what those three imply. */
  | 'energy';

export interface DraftSanity {
  rule: SanityRule;
  /** The fields the rule is about — the ones a correction would touch. */
  fields: readonly MacroField[];
  /** The sentence the form prints under the fields. */
  message: string;
}

const FIELD_LABELS: Readonly<Record<MacroField, string>> = {
  kcal: 'kcal',
  protein: 'białko',
  carbs: 'węglowodany',
  fat: 'tłuszcz'
};

/**
 * The tail every warning ends with: what to look at, and permission to ignore it.
 *
 * A scanned field among the implicated ones is named, because „sprawdź wartości" is no help
 * when six fields were filled at once and one of them came back ten times too large.
 */
function advice(fields: readonly MacroField[], scanned: Partial<Record<MacroField, boolean>>): string {
  const fromPhoto = fields.filter((field) => scanned[field] === true);
  const where =
    fromPhoto.length === 0
      ? 'Sprawdź, czy nie ma literówki.'
      : `Sprawdź ${fromPhoto.length === 1 ? 'pole' : 'pola'} odczytane ze zdjęcia: ` +
        `${fromPhoto.map((field) => FIELD_LABELS[field]).join(', ')}.`;
  return `${where} Jeśli tak jest na etykiecie, zapisz mimo to.`;
}

/**
 * Why these numbers look impossible, or `null` when they do not.
 *
 * Silent while anything is still missing or negative: those are `draftProblem`'s to say, and
 * two sentences arguing about the same field help nobody. `scanned` is the form's own record
 * of which fields the last scan filled — an empty object is a form that was typed by hand.
 */
export function draftSanity(
  draft: IngredientDraft,
  scanned: Partial<Record<MacroField, boolean>> = {}
): DraftSanity | null {
  if (MACRO_FIELDS.some((field) => !entered(draft[field]) || (draft[field] as number) < 0)) {
    return null;
  }
  const macros = draftMacros(draft);

  const grams = macroGrams(macros);
  if (grams > MAX_MACRO_GRAMS) {
    const fields: MacroField[] = ['protein', 'carbs', 'fat'];
    return {
      rule: 'sum',
      fields,
      message:
        `Białko, węglowodany i tłuszcz dają razem ${formatAmount(grams)} g na 100 g — ` +
        `to więcej, niż waży sam produkt. ${advice(fields, scanned)}`
    };
  }

  const implied = impliedKcal(macros);
  const slack = Math.max(ENERGY_FLOOR_KCAL, implied * ENERGY_TOLERANCE);
  if (Math.abs(macros.kcal - implied) > slack) {
    const fields: MacroField[] = ['kcal', 'protein', 'carbs', 'fat'];
    return {
      rule: 'energy',
      fields,
      message:
        `Z makroskładników wychodzi ${formatAmount(Math.round(implied))} kcal, ` +
        `a w polu kcal jest ${formatAmount(macros.kcal)}. ${advice(fields, scanned)}`
    };
  }

  return null;
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
  const measures = draftMeasures(draft);
  return {
    id: options.id ?? newCustomIngredientId(options.nextId),
    name: draft.name.trim(),
    aliases: parseAliases(draft.aliases),
    state: draft.state,
    per100g: draftMacros(draft),
    source: 'custom',
    // Omitted rather than written as `[]`, like every other optional field: an ingredient
    // offering no measure must look exactly like one from before measures existed.
    ...(measures.length === 0 ? {} : { measures }),
    // Same rule: „not chosen" is an absent field, not the string „inne". The two mean the
    // same thing on a shopping list, and only the absence says the user never answered.
    ...(draft.department === '' ? {} : { department: draft.department })
  };
}

/**
 * The measures this draft describes, once `draftProblem` has confirmed each has a weight.
 * A row that somehow still has none is dropped rather than written as 0 g, which `Measure`
 * forbids — the form cannot reach this, and a caller skipping it must not corrupt the row.
 */
export function draftMeasures(draft: IngredientDraft): Measure[] {
  const measures: Measure[] = [];
  const seen = new Set<MeasureName>();
  for (const measure of draft.measures) {
    const grams = measure.grams;
    if (grams === null || !Number.isFinite(grams) || grams <= 0) continue;
    if (seen.has(measure.name)) continue;
    seen.add(measure.name);
    measures.push({ name: measure.name, grams });
  }
  return measures;
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
  return items.map((item) => {
    if (item.ingredientId !== from) return item;
    // The one field that does NOT survive: a measure name is not a measurement, it is a claim
    // about the ingredient, and „2 ząbki" of yoghurt is nonsense (STATE.md decision 354). The
    // weight stays, because that is what was actually put in.
    const { measureName: _measureName, ...rest } = item;
    return { ...rest, ingredientId: to };
  });
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
