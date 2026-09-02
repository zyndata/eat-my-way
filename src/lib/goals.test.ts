import { describe, expect, it } from 'vitest';
import { activityFactor, areGoalsUsable, basalRate, calculateGoals } from './goals';

describe('Mifflin-St Jeor', () => {
  const woman = { sex: 'female' as const, age: 30, height: 165, weight: 60, activity: 'light' as const };

  it('matches the published formula for a woman', () => {
    // 10*60 + 6.25*165 - 5*30 - 161 = 600 + 1031.25 - 150 - 161
    expect(basalRate(woman)).toBeCloseTo(1320.25, 2);
  });

  it('matches the published formula for a man', () => {
    expect(basalRate({ ...woman, sex: 'male' })).toBeCloseTo(1486.25, 2);
  });

  it('multiplies by the activity factor', () => {
    expect(calculateGoals(woman).kcal).toBe(Math.round(1320.25 * 1.375));
  });

  it('splits the energy into macros that add back up to it', () => {
    const goals = calculateGoals(woman);
    const fromMacros = goals.protein * 4 + goals.carbs * 4 + goals.fat * 9;
    // Rounding to whole grams costs a few kcal; anything more would be a bad split.
    expect(Math.abs(fromMacros - goals.kcal)).toBeLessThan(10);
  });

  /**
   * Reference cases computed from the published equation by hand, so a change to
   * `calculateGoals` cannot quietly redefine what the calculator means:
   *   BMR = 10·kg + 6.25·cm − 5·years + (5 for men, −161 for women)
   *   kcal = round(BMR × activity factor)
   */
  const REFERENCE = [
    // man, 80 kg, 180 cm, 40 y, sedentary: 800 + 1125 − 200 + 5 = 1730 × 1.2
    { input: { sex: 'male' as const, age: 40, height: 180, weight: 80, activity: 'sedentary' as const }, bmr: 1730, kcal: 2076 },
    // woman, 55 kg, 160 cm, 25 y, moderate: 550 + 1000 − 125 − 161 = 1264 × 1.55
    { input: { sex: 'female' as const, age: 25, height: 160, weight: 55, activity: 'moderate' as const }, bmr: 1264, kcal: 1959 },
    // man, 95 kg, 190 cm, 55 y, very active: 950 + 1187.5 − 275 + 5 = 1867.5 × 1.9
    { input: { sex: 'male' as const, age: 55, height: 190, weight: 95, activity: 'very-active' as const }, bmr: 1867.5, kcal: 3548 },
    // woman, 70 kg, 175 cm, 18 y, active: 700 + 1093.75 − 90 − 161 = 1542.75 × 1.725
    { input: { sex: 'female' as const, age: 18, height: 175, weight: 70, activity: 'active' as const }, bmr: 1542.75, kcal: 2661 }
  ];

  it.each(REFERENCE)('matches the reference value for $input.sex, $input.age', ({ input, bmr, kcal }) => {
    expect(basalRate(input)).toBeCloseTo(bmr, 2);
    expect(calculateGoals(input).kcal).toBe(kcal);
  });

  it('falls back to the sedentary factor for an unknown activity level', () => {
    expect(activityFactor('nonsense' as never)).toBe(1.2);
  });
});

describe('goal validation', () => {
  it('accepts zeroes — a goal of 0 kcal means "no goal set"', () => {
    expect(areGoalsUsable({ kcal: 0, protein: 0, carbs: 0, fat: 0 })).toBe(true);
  });

  it('rejects a negative or unparseable value', () => {
    expect(areGoalsUsable({ kcal: -1, protein: 0, carbs: 0, fat: 0 })).toBe(false);
    expect(areGoalsUsable({ kcal: Number.NaN, protein: 0, carbs: 0, fat: 0 })).toBe(false);
  });
});
