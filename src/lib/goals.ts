import type { Macros } from './types';

/**
 * The Mifflin-St Jeor calculator PLAN.md asks for in settings and in the wizard.
 *
 * It produces a starting point, nothing more: every number it returns is written into an
 * editable field, and the user's own value always wins. Kept pure and separate from the form
 * so the arithmetic can be checked without a browser.
 */

export type Sex = 'female' | 'male';

/** Activity multipliers, as the formula is normally published. */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', factor: 1.2, label: 'Siedzący tryb życia' },
  { key: 'light', factor: 1.375, label: 'Lekka aktywność (1–3 dni w tygodniu)' },
  { key: 'moderate', factor: 1.55, label: 'Umiarkowana aktywność (3–5 dni)' },
  { key: 'active', factor: 1.725, label: 'Duża aktywność (6–7 dni)' },
  { key: 'very-active', factor: 1.9, label: 'Bardzo duża aktywność (praca fizyczna)' }
] as const;

export type ActivityKey = (typeof ACTIVITY_LEVELS)[number]['key'];

export interface CalculatorInput {
  sex: Sex;
  /** Years. */
  age: number;
  /** Centimetres. */
  height: number;
  /** Kilograms. */
  weight: number;
  activity: ActivityKey;
}

/**
 * Share of the daily energy taken by each macronutrient, in **whole percent** summing to 100.
 *
 * Percent rather than a fraction because that is what the three fields in the form hold and
 * what „the sum is 100" is a statement about: a fraction would make the rule a float
 * comparison, and a float comparison is a rule that is sometimes wrong (Phase 19).
 */
export interface MacroSplit {
  protein: number;
  carbs: number;
  fat: number;
}

/**
 * What the profile remembers between two openings of the calculator (Phase 19, decision 336).
 *
 * The split rides along with the body data because it evaporates for the same reason and is an
 * input to the same one calculation — one optional profile field, one reader, one validator.
 * Absent `split` means `DEFAULT_SPLIT`, which is what every profile written before this phase
 * says.
 */
export interface BodyData extends CalculatorInput {
  split?: MacroSplit;
}

/** A conventional, editable split. Unchanged for anyone who never opens the three fields. */
export const DEFAULT_SPLIT: MacroSplit = { protein: 25, carbs: 45, fat: 30 };

/** What the calculator offers before the user has ever told it anything. */
export const DEFAULT_BODY: BodyData = {
  sex: 'female',
  age: 30,
  height: 170,
  weight: 70,
  activity: 'light'
};

/** Kilocalories per gram. */
const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

export function activityFactor(key: ActivityKey): number {
  return ACTIVITY_LEVELS.find((level) => level.key === key)?.factor ?? 1.2;
}

/** The label shown for an activity level, falling back to the sedentary one. */
export function activityLabel(key: ActivityKey): string {
  return ACTIVITY_LEVELS.find((level) => level.key === key)?.label ?? ACTIVITY_LEVELS[0].label;
}

/** Basal metabolic rate, Mifflin-St Jeor. */
export function basalRate(input: CalculatorInput): number {
  const base = 10 * input.weight + 6.25 * input.height - 5 * input.age;
  return input.sex === 'male' ? base + 5 : base - 161;
}

/** True when the three percentages are whole, non-negative and add up to 100. */
export function isSplitUsable(split: MacroSplit): boolean {
  const values = [split.protein, split.carbs, split.fat];
  if (!values.every((value) => Number.isInteger(value) && value >= 0)) return false;
  return values.reduce((sum, value) => sum + value, 0) === 100;
}

/** True when the body data can be put through the formula: three positive, finite numbers. */
export function isBodyUsable(body: CalculatorInput): boolean {
  return [body.age, body.height, body.weight].every(
    (value) => Number.isFinite(value) && value > 0
  );
}

/** The split a stored body carries, or the default one. */
export function splitOf(body: BodyData | undefined): MacroSplit {
  const split = body?.split;
  return split !== undefined && isSplitUsable(split) ? split : DEFAULT_SPLIT;
}

/**
 * Every step of the calculation, so the form can show where the number came from (Phase 19
 * task 3). `goals` is exactly what `calculateGoals` returns for the same input — one code
 * path, so the shown derivation cannot drift from the filled fields.
 */
export interface GoalDerivation {
  /** Basal metabolic rate, unrounded. */
  bmr: number;
  factor: number;
  split: MacroSplit;
  goals: Macros;
}

export function deriveGoals(input: CalculatorInput, split: MacroSplit = DEFAULT_SPLIT): GoalDerivation {
  const usable = isSplitUsable(split) ? split : DEFAULT_SPLIT;
  const bmr = basalRate(input);
  const factor = activityFactor(input.activity);
  const kcal = Math.round(bmr * factor);
  return {
    bmr,
    factor,
    split: usable,
    goals: {
      kcal,
      protein: gramsFor(kcal, usable.protein, KCAL_PER_GRAM.protein),
      carbs: gramsFor(kcal, usable.carbs, KCAL_PER_GRAM.carbs),
      fat: gramsFor(kcal, usable.fat, KCAL_PER_GRAM.fat)
    }
  };
}

/** Daily energy, and a macro split of it. All four numbers are rounded to whole units. */
export function calculateGoals(input: CalculatorInput, split?: MacroSplit): Macros {
  return deriveGoals(input, split).goals;
}

function gramsFor(kcal: number, percent: number, kcalPerGram: number): number {
  return Math.round((kcal * percent) / 100 / kcalPerGram);
}

/** True when every goal is a finite, non-negative number — what the form may save. */
export function areGoalsUsable(goals: Macros): boolean {
  return (['kcal', 'protein', 'carbs', 'fat'] as const).every(
    (key) => Number.isFinite(goals[key]) && goals[key] >= 0
  );
}

/**
 * Body data as it arrives from Drive or a backup file, validated field by field.
 *
 * Forgiving in one direction only, like every other reader in `sync/documents.ts`: anything
 * malformed degrades to `undefined` — „the calculator has not been told anything" — rather
 * than to a half-filled body that would quietly produce a wrong goal.
 */
export function readBodyData(value: unknown): BodyData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const doc = value as Partial<BodyData>;
  if (doc.sex !== 'female' && doc.sex !== 'male') return undefined;
  if (!ACTIVITY_LEVELS.some((level) => level.key === doc.activity)) return undefined;

  const body: CalculatorInput = {
    sex: doc.sex,
    age: doc.age as number,
    height: doc.height as number,
    weight: doc.weight as number,
    activity: doc.activity as ActivityKey
  };
  if (!isBodyUsable(body)) return undefined;

  const split = doc.split;
  return typeof split === 'object' && split !== null && isSplitUsable(split)
    ? { ...body, split: { protein: split.protein, carbs: split.carbs, fat: split.fat } }
    : body;
}
