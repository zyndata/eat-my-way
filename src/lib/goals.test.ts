import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT,
  MAINTAIN,
  WEIGHT_GOALS,
  activityFactor,
  areGoalsUsable,
  basalRate,
  calculateGoals,
  deriveGoals,
  energyOffset,
  isBodyUsable,
  isProteinLow,
  isRateAggressive,
  isSplitUsable,
  minimumKcal,
  proteinPerKg,
  readBodyData,
  splitOf,
  targetOf
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

  it('round-trips a goal and a rate (Phase 23)', () => {
    const reducing = { ...body, goal: 'lose' as const, rate: 0.75 };
    expect(readBodyData(JSON.parse(JSON.stringify(reducing)))).toEqual(reducing);
    const maintaining = { ...body, goal: 'maintain' as const };
    expect(readBodyData(JSON.parse(JSON.stringify(maintaining)))).toEqual(maintaining);
  });

  it('degrades an unknown goal or an off-list rate to maintain, keeping the body (Phase 23)', () => {
    expect(readBodyData({ ...body, goal: 'lose', rate: 3 })).toEqual(body);
    expect(readBodyData({ ...body, goal: 'gain', rate: 0.75 })).toEqual(body);
    expect(readBodyData({ ...body, goal: 'lose' })).toEqual(body);
    expect(readBodyData({ ...body, goal: 'cut', rate: 0.5 })).toEqual(body);
    expect(readBodyData({ ...body, goal: 'lose', rate: '0.5' })).toEqual(body);
    // A maintain carrying a stray rate keeps the goal and drops the rate.
    expect(readBodyData({ ...body, goal: 'maintain', rate: 0.5 })).toEqual({ ...body, goal: 'maintain' });
    expect(targetOf(readBodyData({ ...body, goal: 'lose', rate: 3 }))).toEqual(MAINTAIN);
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

describe('reduction and gain (Phase 23)', () => {
  /**
   * Reference cases from PLAN.md's acceptance criteria, computed by hand:
   *   maintenance = round(BMR × factor)
   *   offset      = round(rate × 7700 / 7)   → 0,25 kg: 275, 0,5: 550, 0,75: 825, 1: 1100
   *   reduction   = max(maintenance − offset, min(1200 women / 1500 men, maintenance))
   *   grams       = round(kcal × share / 4 or 9)
   */
  const man = { sex: 'male' as const, age: 40, height: 180, weight: 80, activity: 'sedentary' as const };
  // 10·50 + 6.25·155 − 5·60 − 161 = 500 + 968.75 − 300 − 161 = 1007.75 × 1.2 = 1209.3 → 1209
  const smallWoman = { sex: 'female' as const, age: 60, height: 155, weight: 50, activity: 'sedentary' as const };
  // 10·60 + 6.25·165 − 5·70 + 5 = 600 + 1031.25 − 350 + 5 = 1286.25 × 1.2 = 1543.5 → 1544
  const olderMan = { sex: 'male' as const, age: 70, height: 165, weight: 60, activity: 'sedentary' as const };

  it('turns the presets into 275, 550, 825 and 1100 kcal a day', () => {
    expect(WEIGHT_GOALS.find((goal) => goal.key === 'lose')?.rates.map((rate) => energyOffset('lose', rate))).toEqual([
      -275, -550, -825, -1100
    ]);
    expect(WEIGHT_GOALS.find((goal) => goal.key === 'gain')?.rates.map((rate) => energyOffset('gain', rate))).toEqual([
      275, 550
    ]);
    expect(energyOffset('maintain', 0.5)).toBe(0);
  });

  it('leaves maintain exactly where the calculator always was', () => {
    // 1730 × 1.2 = 2076, no offset, the Phase 19 grams.
    const derivation = deriveGoals(man, DEFAULT_SPLIT, MAINTAIN);
    expect(derivation.maintenance).toBe(2076);
    expect(derivation.offset).toBe(0);
    expect(derivation.floorApplied).toBe(false);
    expect(derivation.goals).toEqual({ kcal: 2076, protein: 130, carbs: 234, fat: 69 });
    expect(derivation.goals).toEqual(calculateGoals(man));
  });

  it('reduces the man of 40 at 0,5 kg to 1526 kcal', () => {
    // 2076 − 550 = 1526; 1526·0.25/4 = 95.4 → 95, 1526·0.45/4 = 171.7 → 172, 1526·0.3/9 = 50.9 → 51
    const derivation = deriveGoals(man, DEFAULT_SPLIT, { goal: 'lose', rate: 0.5 });
    expect(derivation.maintenance).toBe(2076);
    expect(derivation.offset).toBe(-550);
    expect(derivation.floorApplied).toBe(false);
    expect(derivation.goals).toEqual({ kcal: 1526, protein: 95, carbs: 172, fat: 51 });
  });

  it('adds 275 kcal for the man of 40 gaining 0,25 kg', () => {
    // 2076 + 275 = 2351
    expect(calculateGoals(man, DEFAULT_SPLIT, { goal: 'gain', rate: 0.25 }).kcal).toBe(2351);
  });

  it('raises the woman of 60 losing 1 kg to 1200 kcal, not 109', () => {
    // 1209 − 1100 = 109 < min(1200, 1209) = 1200; protein 1200·0.25/4 = 75 g = 1,5 g/kg
    const target = { goal: 'lose' as const, rate: 1 };
    const derivation = deriveGoals(smallWoman, DEFAULT_SPLIT, target);
    expect(derivation.maintenance).toBe(1209);
    expect(derivation.floorApplied).toBe(true);
    expect(derivation.goals.kcal).toBe(1200);
    expect(derivation.goals.protein).toBe(75);
    expect(proteinPerKg(derivation.goals, smallWoman)).toBeCloseTo(1.5, 5);
    expect(isRateAggressive({ ...smallWoman, ...target })).toBe(true);
    expect(isProteinLow(derivation.goals, { ...smallWoman, ...target })).toBe(true);
  });

  it('raises the man of 70 losing 1 kg to 1500 kcal', () => {
    // 1544 − 1100 = 444 < min(1500, 1544) = 1500
    const derivation = deriveGoals(olderMan, DEFAULT_SPLIT, { goal: 'lose', rate: 1 });
    expect(derivation.floorApplied).toBe(true);
    expect(derivation.goals.kcal).toBe(1500);
  });

  it('never raises a reduction above the maintenance figure', () => {
    // 10·40 + 6.25·150 − 5·80 − 161 = 400 + 937.5 − 400 − 161 = 776.5 × 1.2 = 931.8 → 932
    const tiny = { sex: 'female' as const, age: 80, height: 150, weight: 40, activity: 'sedentary' as const };
    const derivation = deriveGoals(tiny, DEFAULT_SPLIT, { goal: 'lose', rate: 0.25 });
    expect(derivation.maintenance).toBe(932);
    expect(derivation.floorApplied).toBe(true);
    expect(derivation.goals.kcal).toBe(932);

    // And across every body shape the calculator could see, for every reduction preset.
    for (const sex of ['female', 'male'] as const) {
      for (const weight of [35, 45, 60, 90, 140]) {
        for (const rate of [0.25, 0.5, 0.75, 1]) {
          const input = { sex, age: 75, height: 150, weight, activity: 'sedentary' as const };
          const result = deriveGoals(input, DEFAULT_SPLIT, { goal: 'lose', rate });
          expect(result.goals.kcal).toBeLessThanOrEqual(result.maintenance);
          expect(result.goals.kcal).toBeGreaterThanOrEqual(Math.min(minimumKcal(sex), result.maintenance));
        }
      }
    }
  });

  it('leaves the split alone whatever the goal', () => {
    const split = { protein: 40, carbs: 30, fat: 30 };
    expect(deriveGoals(man, split, { goal: 'lose', rate: 0.75 }).split).toEqual(split);
    expect(deriveGoals(man, split, { goal: 'gain', rate: 0.5 }).split).toEqual(split);
  });

  it('calculates an unusable target as maintain', () => {
    const derivation = deriveGoals(man, DEFAULT_SPLIT, { goal: 'lose', rate: 3 });
    expect(derivation.target).toEqual(MAINTAIN);
    expect(derivation.goals.kcal).toBe(2076);
  });

  it('warns past 1 % of body weight a week, and only on a reduction', () => {
    // 80 kg: 0,75 kg is under 0,8; 1 kg is over.
    expect(isRateAggressive({ ...man, goal: 'lose', rate: 0.75 })).toBe(false);
    expect(isRateAggressive({ ...man, goal: 'lose', rate: 1 })).toBe(true);
    // 50 kg at 0,5 kg is exactly 1 % — not more than it.
    expect(isRateAggressive({ ...smallWoman, goal: 'lose', rate: 0.5 })).toBe(false);
    expect(isRateAggressive({ ...smallWoman, goal: 'gain', rate: 0.5 })).toBe(false);
    expect(isRateAggressive(smallWoman)).toBe(false);
  });

  it('hints at protein below 1,6 g/kg on a reduction or a gain, never on maintain', () => {
    // 95 g / 80 kg = 1,19 g/kg
    const reducing = { ...man, goal: 'lose' as const, rate: 0.5 };
    const goals = calculateGoals(man, DEFAULT_SPLIT, reducing);
    expect(isProteinLow(goals, reducing)).toBe(true);
    expect(isProteinLow(goals, man)).toBe(false);
    // 128 g / 80 kg = 1,6 g/kg exactly
    expect(isProteinLow({ ...goals, protein: 128 }, reducing)).toBe(false);
    // 1,56 shows as 1,6, so it does not ask for 1,6
    expect(isProteinLow({ ...goals, protein: 124.8 }, reducing)).toBe(false);
  });

  it('knows each goal from what the profile stored', () => {
    expect(targetOf(undefined)).toEqual(MAINTAIN);
    expect(targetOf(man)).toEqual(MAINTAIN);
    expect(targetOf({ ...man, goal: 'gain', rate: 0.5 })).toEqual({ goal: 'gain', rate: 0.5 });
    expect(minimumKcal('female')).toBe(1200);
    expect(minimumKcal('male')).toBe(1500);
  });
});
