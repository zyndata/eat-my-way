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

/** Share of the daily energy taken by each macronutrient. A conventional, editable split. */
export const DEFAULT_SPLIT = { protein: 0.25, carbs: 0.45, fat: 0.3 } as const;

/** Kilocalories per gram. */
const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

export function activityFactor(key: ActivityKey): number {
  return ACTIVITY_LEVELS.find((level) => level.key === key)?.factor ?? 1.2;
}

/** Basal metabolic rate, Mifflin-St Jeor. */
export function basalRate(input: CalculatorInput): number {
  const base = 10 * input.weight + 6.25 * input.height - 5 * input.age;
  return input.sex === 'male' ? base + 5 : base - 161;
}

/** Daily energy, and a macro split of it. All four numbers are rounded to whole units. */
export function calculateGoals(input: CalculatorInput): Macros {
  const kcal = Math.round(basalRate(input) * activityFactor(input.activity));
  return {
    kcal,
    protein: Math.round((kcal * DEFAULT_SPLIT.protein) / KCAL_PER_GRAM.protein),
    carbs: Math.round((kcal * DEFAULT_SPLIT.carbs) / KCAL_PER_GRAM.carbs),
    fat: Math.round((kcal * DEFAULT_SPLIT.fat) / KCAL_PER_GRAM.fat)
  };
}

/** True when every goal is a finite, non-negative number — what the form may save. */
export function areGoalsUsable(goals: Macros): boolean {
  return (['kcal', 'protein', 'carbs', 'fat'] as const).every(
    (key) => Number.isFinite(goals[key]) && goals[key] >= 0
  );
}
