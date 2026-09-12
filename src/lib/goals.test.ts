import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT,
  activityFactor,
  areGoalsUsable,
  basalRate,
  calculateGoals,
  deriveGoals,
  isBodyUsable,
  isSplitUsable,
  readBodyData,
  splitOf
} from './goals';

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

describe('macro split (Phase 19)', () => {
  const woman = { sex: 'female' as const, age: 30, height: 165, weight: 60, activity: 'light' as const };

  it('keeps the documented default for anyone who never opens the three fields', () => {
    expect(DEFAULT_SPLIT).toEqual({ protein: 25, carbs: 45, fat: 30 });
    expect(calculateGoals(woman)).toEqual(calculateGoals(woman, DEFAULT_SPLIT));
  });

  it('accepts a split that adds up to 100 and rejects one that does not', () => {
    expect(isSplitUsable({ protein: 40, carbs: 30, fat: 30 })).toBe(true);
    expect(isSplitUsable({ protein: 40, carbs: 30, fat: 40 })).toBe(false);
    expect(isSplitUsable({ protein: 100, carbs: 0, fat: 0 })).toBe(true);
    expect(isSplitUsable({ protein: 40, carbs: 30, fat: Number.NaN })).toBe(false);
    expect(isSplitUsable({ protein: -10, carbs: 60, fat: 50 })).toBe(false);
    expect(isSplitUsable({ protein: 33.5, carbs: 33.5, fat: 33 })).toBe(false);
  });

  it('turns a 40/30/30 split into grams that add back up to the same kcal', () => {
    const split = { protein: 40, carbs: 30, fat: 30 };
    const goals = calculateGoals(woman, split);
    expect(goals.protein).toBe(Math.round((goals.kcal * 0.4) / 4));
    expect(goals.carbs).toBe(Math.round((goals.kcal * 0.3) / 4));
    expect(goals.fat).toBe(Math.round((goals.kcal * 0.3) / 9));
    const fromMacros = goals.protein * 4 + goals.carbs * 4 + goals.fat * 9;
    expect(Math.abs(fromMacros - goals.kcal)).toBeLessThan(10);
  });

  it('gives more protein and less fat than the default for a high-protein split', () => {
    const high = calculateGoals(woman, { protein: 40, carbs: 30, fat: 30 });
    const standard = calculateGoals(woman);
    expect(high.kcal).toBe(standard.kcal);
    expect(high.protein).toBeGreaterThan(standard.protein);
    expect(high.carbs).toBeLessThan(standard.carbs);
  });

  it('falls back to the default rather than calculating from an impossible split', () => {
    expect(calculateGoals(woman, { protein: 40, carbs: 30, fat: 40 })).toEqual(calculateGoals(woman));
  });
});

describe('the shown derivation (Phase 19)', () => {
  const man = { sex: 'male' as const, age: 40, height: 180, weight: 80, activity: 'sedentary' as const };

  it('shows every step, and its goals are the ones the fields get', () => {
    const split = { protein: 40, carbs: 30, fat: 30 };
    const derivation = deriveGoals(man, split);
    expect(derivation.bmr).toBeCloseTo(1730, 2);
    expect(derivation.factor).toBe(1.2);
    expect(derivation.goals.kcal).toBe(Math.round(1730 * 1.2));
    expect(derivation.split).toEqual(split);
    expect(derivation.goals).toEqual(calculateGoals(man, split));
  });

  it('reports the split it actually used when the given one is impossible', () => {
    expect(deriveGoals(man, { protein: 40, carbs: 30, fat: 40 }).split).toEqual(DEFAULT_SPLIT);
  });

  it('knows which body data can go through the formula', () => {
    expect(isBodyUsable(man)).toBe(true);
    expect(isBodyUsable({ ...man, weight: 0 })).toBe(false);
    expect(isBodyUsable({ ...man, age: Number.NaN })).toBe(false);
    expect(isBodyUsable({ ...man, height: -170 })).toBe(false);
  });
});

describe('body data read back from Drive or a backup (Phase 19)', () => {
  const body = { sex: 'male' as const, age: 40, height: 180, weight: 80, activity: 'sedentary' as const };

  it('round-trips a body with and without a split', () => {
    expect(readBodyData(JSON.parse(JSON.stringify(body)))).toEqual(body);
    const withSplit = { ...body, split: { protein: 40, carbs: 30, fat: 30 } };
    expect(readBodyData(JSON.parse(JSON.stringify(withSplit)))).toEqual(withSplit);
  });

  it('degrades a malformed body to "nothing was ever entered"', () => {
    expect(readBodyData(undefined)).toBeUndefined();
    expect(readBodyData(null)).toBeUndefined();
    expect(readBodyData('male')).toBeUndefined();
    expect(readBodyData({ ...body, sex: 'other' })).toBeUndefined();
    expect(readBodyData({ ...body, activity: 'olympic' })).toBeUndefined();
    expect(readBodyData({ ...body, height: '180' })).toBeUndefined();
    expect(readBodyData({ sex: 'male', activity: 'sedentary' })).toBeUndefined();
  });

  it('drops an impossible split but keeps the body around it', () => {
    expect(readBodyData({ ...body, split: { protein: 40, carbs: 30, fat: 40 } })).toEqual(body);
    expect(readBodyData({ ...body, split: 'high-protein' })).toEqual(body);
  });

  it('offers the default split for a body that carries none', () => {
    expect(splitOf(undefined)).toEqual(DEFAULT_SPLIT);
    expect(splitOf(body)).toEqual(DEFAULT_SPLIT);
    expect(splitOf({ ...body, split: { protein: 40, carbs: 30, fat: 30 } })).toEqual({
      protein: 40,
      carbs: 30,
      fat: 30
    });
  });
});
