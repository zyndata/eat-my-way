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
