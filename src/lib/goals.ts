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
  /** Absent means `'maintain'` — what every profile written before Phase 23 says. */
  goal?: WeightGoal;
  /** Kilograms a week, one of the goal's presets. Absent unless `goal` is not `'maintain'`. */
  rate?: number;
}

/**
 * Keep, lose or gain weight (Phase 23, decisions 416–418).
 *
 * The maintenance figure stays what the formula says; a goal and a weekly rate turn it into a
 * deficit or a surplus. Rates are presets rather than a free field — a free field invites two
 * kilograms a week, and a free kcal field is the guess decision 337 turned down.
 */
export type WeightGoal = 'maintain' | 'lose' | 'gain';

export interface WeightGoalOption {
  key: WeightGoal;
  label: string;
  /** Kilograms a week the goal offers, slowest first. Empty for maintain. */
  rates: readonly number[];
  defaultRate: number | undefined;
}

const MAINTAIN_OPTION: WeightGoalOption = {
  key: 'maintain',
  label: 'Utrzymanie wagi',
  rates: [],
  defaultRate: undefined
};

export const WEIGHT_GOALS: readonly WeightGoalOption[] = [
  MAINTAIN_OPTION,
  { key: 'lose', label: 'Redukcja', rates: [0.25, 0.5, 0.75, 1], defaultRate: 0.5 },
  // Stops at 0,5 kg: 7 700 kcal per kilogram is a rougher figure for gain (decision 418).
  { key: 'gain', label: 'Budowa masy', rates: [0.25, 0.5], defaultRate: 0.25 }
];

/** A goal and, unless it is maintain, the rate it is pursued at. */
export interface WeightTarget {
  goal: WeightGoal;
  rate?: number;
}

export const MAINTAIN: WeightTarget = { goal: 'maintain' };

/** Energy in a kilogram of body weight, as reduction calculators conventionally count it. */
export const KCAL_PER_KG = 7700;

/** Below this much protein per kilogram, a reduction or a gain gets a hint (decision 420). */
export const PROTEIN_HINT_G_PER_KG = 1.6;

/** Share of body weight a week above which a reduction is called fast (decision 419). */
const AGGRESSIVE_SHARE_PER_WEEK = 0.01;

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

/** The goal's presets, labels and default rate, falling back to maintain. */
export function goalOption(goal: WeightGoal): WeightGoalOption {
  return WEIGHT_GOALS.find((option) => option.key === goal) ?? MAINTAIN_OPTION;
}

/** True when the goal is known and — unless it is maintain — the rate is one of its presets. */
export function isTargetUsable(target: { goal?: unknown; rate?: unknown }): boolean {
  const option = WEIGHT_GOALS.find((candidate) => candidate.key === target.goal);
  if (option === undefined) return false;
  return option.key === 'maintain' || option.rates.includes(target.rate as number);
}

/** The goal a stored body carries, or maintain. The rate is dropped when maintaining. */
export function targetOf(body: BodyData | undefined): WeightTarget {
  if (body?.goal === undefined || !isTargetUsable(body)) return MAINTAIN;
  return body.goal === 'maintain' ? MAINTAIN : { goal: body.goal, rate: body.rate as number };
}

/**
 * The daily kcal the goal adds to the maintenance figure: negative for a reduction, positive for
 * a gain, zero for maintain. `round(rate × 7700 / 7)`, so the presets give 275, 550, 825, 1100.
 */
export function energyOffset(goal: WeightGoal, rate: number | undefined): number {
  if (goal === 'maintain' || rate === undefined) return 0;
  const magnitude = Math.round((rate * KCAL_PER_KG) / 7);
  return goal === 'lose' ? -magnitude : magnitude;
}

/** The least a reduction will propose (decision 419). */
export function minimumKcal(sex: Sex): number {
  return sex === 'male' ? 1500 : 1200;
}

/** True when a reduction asks for more than 1 % of body weight a week. Warns; never blocks. */
export function isRateAggressive(body: BodyData): boolean {
  const target = targetOf(body);
  return (
    target.goal === 'lose' &&
    target.rate !== undefined &&
    target.rate > body.weight * AGGRESSIVE_SHARE_PER_WEEK
  );
}

/** Grams of protein per kilogram of body weight, unrounded. */
export function proteinPerKg(goals: Macros, body: CalculatorInput): number {
  return goals.protein / body.weight;
}

/**
 * True when a reduction or a gain gets less protein than `PROTEIN_HINT_G_PER_KG`.
 *
 * Compared at the one decimal the form shows, so the screen never says „≈ 1,6 g/kg" next to a
 * hint to reach 1,6 g/kg.
 */
export function isProteinLow(goals: Macros, body: BodyData): boolean {
  if (targetOf(body).goal === 'maintain') return false;
  return Math.round(proteinPerKg(goals, body) * 10) / 10 < PROTEIN_HINT_G_PER_KG;
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
  /** `round(bmr × factor)` — the energy that keeps the weight where it is. */
  maintenance: number;
  /** The goal actually used — maintain when the given one was unusable. */
  target: WeightTarget;
  /** Signed kcal a day the goal adds; see `energyOffset`. */
  offset: number;
  /** True when a reduction was raised to `minimumKcal` or to the maintenance figure. */
  floorApplied: boolean;
  split: MacroSplit;
  goals: Macros;
}

export function deriveGoals(
  input: CalculatorInput,
  split: MacroSplit = DEFAULT_SPLIT,
  target: WeightTarget = MAINTAIN
): GoalDerivation {
  const usable = isSplitUsable(split) ? split : DEFAULT_SPLIT;
  const usableTarget = targetOf({ ...input, ...target });
  const bmr = basalRate(input);
  const factor = activityFactor(input.activity);
  const maintenance = Math.round(bmr * factor);
  const offset = energyOffset(usableTarget.goal, usableTarget.rate);

  // The floor never exceeds maintenance, so it cannot turn a deficit into a surplus.
  const floor =
    usableTarget.goal === 'lose' ? Math.min(minimumKcal(input.sex), maintenance) : -Infinity;
  const floorApplied = maintenance + offset < floor;
  const kcal = floorApplied ? floor : maintenance + offset;
  return {
    bmr,
    factor,
    maintenance,
    target: usableTarget,
    offset,
    floorApplied,
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
export function calculateGoals(
  input: CalculatorInput,
  split?: MacroSplit,
  target?: WeightTarget
): Macros {
  return deriveGoals(input, split, target).goals;
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
  const withSplit: BodyData =
    typeof split === 'object' && split !== null && isSplitUsable(split)
      ? { ...body, split: { protein: split.protein, carbs: split.carbs, fat: split.fat } }
      : body;

  // Phase 23: an unknown goal or an off-list rate degrades to maintain — absent — and keeps the
  // body around it, the split's rule (decision 421).
  if (doc.goal === undefined || !isTargetUsable(doc)) return withSplit;
  return doc.goal === 'maintain'
    ? { ...withSplit, goal: 'maintain' }
    : { ...withSplit, goal: doc.goal, rate: doc.rate as number };
}
