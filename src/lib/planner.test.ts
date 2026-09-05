import { describe, expect, it } from 'vitest';
// The module's own text, so the purity rule below is checked against the file rather than
// against a promise in a comment. Vite's `?raw` is a build-time read; nothing runs.
import plannerSource from './planner.ts?raw';
import type { Day, MealPlanTemplate, MealSlot, Recipe } from './types';
import {
  BALANCE_CLAMP,
  DAY_BAND,
  MAX_BATCH_DAYS,
  NO_PLAN_TAG,
  PORTION_STEPS,
  type PlanCandidate,
  type PlanRun,
  type RandomSource,
  batchedShare,
  candidatesForSlot,
  clampBatchDays,
  correctedGoals,
  defaultMealPlan,
  diffLabel,
  failureMessage,
  normalizedShares,
  planBlocks,
  planCandidates,
  planDayInputs,
  planRange,
  planWrites,
  plannerWeek,
  repeatCost,
  resolveRunLength,
  runId,
  runsForDates,
  skippedLabel,
  templateOf,
  weekBalance
} from './planner';
import { ingredientLookup } from './macros';
import { shoppingLines } from './shopping';
import { macros } from '../test/fixtures';

/**
 * The planner (PLAN.md Phase 13 task 10). Every rule the solver obeys is asserted against a
 * **seeded** generator, so a search with restarts still produces one exact answer: a solver
 * nobody can pin is a solver nobody can change later.
 */

/** mulberry32 — five lines, deterministic, and it exists only here. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOALS = macros(2000, 120, 220, 70);

/** A candidate whose macros scale with its kcal, so the tie-breakers stay meaningful. */
function candidate(
  id: string,
  kcal: number,
  options: { tags?: string[]; lastPlannedDate?: string } = {}
): PlanCandidate {
  return {
    recipeId: id,
    name: id,
    tags: options.tags ?? [],
    macros: macros(kcal, kcal / 16, kcal / 9, kcal / 30),
    ...(options.lastPlannedDate === undefined ? {} : { lastPlannedDate: options.lastPlannedDate })
  };
}

/** Twelve recipes spread across the energies a day is built out of. */
function library(): PlanCandidate[] {
  return [
    candidate('r1', 320),
    candidate('r2', 380),
    candidate('r3', 450),
    candidate('r4', 520),
    candidate('r5', 610),
    candidate('r6', 680),
    candidate('r7', 740),
    candidate('r8', 820),
    candidate('r9', 180),
    candidate('r10', 240),
    candidate('r11', 290),
    candidate('r12', 560)
  ];
}

function slot(id: string, share: number, batchDays = 1, tagKeys: string[] = []): MealSlot {
  return { id, label: id, tagKeys, share, batchDays };
}

const FOUR_SLOTS: MealPlanTemplate = {
  slots: [
    slot('sniadanie', 0.25),
    slot('obiad', 0.4),
    slot('podwieczorek', 0.1),
    slot('kolacja', 0.25)
  ]
};

/** A plain range with nothing already on it — the „Zaplanuj dzień" / „tydzień" case. */
function inputs(dates: readonly string[], goals = GOALS) {
  return planDayInputs(dates, [], goals, FOUR_SLOTS, {
    surplus: 0,
    spreadDays: 0,
    correction: 0,
    clamped: false,
    note: ''
  });
}

// 2026-09-07 is a Monday.
const MONDAY = '2026-09-07';
const WEEK = plannerWeek(MONDAY);

// ---- purity ------------------------------------------------------------------------------

describe('planner.ts is pure', () => {
  it('imports nothing that touches the database, the network or the clock', () => {
    const source = plannerSource;
    const imported = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    // Every one of these is itself a pure module; none of them is `db`, `repository`,
    // `net`, `sync/*` or `gemini/*`.
    expect([...new Set(imported)].sort()).toEqual([
      './calendar',
      './dates',
      './ids',
      './macros',
      './recipes',
      './text',
      './types'
    ]);
    expect(source).not.toContain('new Date(');
    expect(source).not.toContain('Math.random');
  });
});

// ---- the template ------------------------------------------------------------------------

describe('the template', () => {
  it('falls back to the built-in default, which cooks lunch for two days', () => {
    const template = templateOf(undefined);
    expect(template.slots).toHaveLength(4);
    expect(template.slots.map((row) => row.label)).toEqual([
      'Śniadanie',
      'Obiad',
      'Podwieczorek',
      'Kolacja'
    ]);
    expect(template.slots[1]?.batchDays).toBe(2);
    // No tags at all: a default that named tags would fail on a library that has none.
    expect(template.slots.every((row) => row.tagKeys.length === 0)).toBe(true);
    expect(templateOf({ slots: [] }).slots).toHaveLength(4);
  });

  it('hands out an independent copy each time', () => {
    const first = defaultMealPlan();
    first.slots[0]!.label = 'Zmienione';
    expect(defaultMealPlan().slots[0]?.label).toBe('Śniadanie');
  });

  it('normalizes shares rather than validating them', () => {
    expect(normalizedShares([slot('a', 30), slot('b', 30), slot('c', 30)])).toEqual([
      1 / 3,
      1 / 3,
      1 / 3
    ]);
    // Nothing usable at all still says something: an even split.
    expect(normalizedShares([slot('a', 0), slot('b', 0)])).toEqual([0.5, 0.5]);
    expect(normalizedShares([])).toEqual([]);
  });

  it('caps a run at three days, because that is how long cooked food keeps', () => {
    expect(clampBatchDays(4)).toBe(MAX_BATCH_DAYS);
    expect(clampBatchDays(0)).toBe(1);
    expect(clampBatchDays(Number.NaN)).toBe(1);
    expect(clampBatchDays(2.4)).toBe(2);
  });
});

// ---- how long a cook lasts ---------------------------------------------------------------

describe('resolveRunLength', () => {
  const obiad = slot('obiad', 0.4, 2);

  it('uses the slot when the weekday says nothing', () => {
    expect(resolveRunLength(obiad, MONDAY, { slots: [obiad] })).toBe(2);
  });

  it('lets the weekday override the slot — „w niedzielę gotuję na 3 dni"', () => {
    // 6 = Sunday, as `weekdayIndex` numbers the week from Monday.
    const template: MealPlanTemplate = { slots: [obiad], cookDays: { 6: 3 } };
    expect(resolveRunLength(obiad, '2026-09-13', template)).toBe(3);
    // …and every other weekday keeps the slot's own number.
    expect(resolveRunLength(obiad, MONDAY, template)).toBe(2);
  });

  it('reads a weekday set to 1 as „do not start a long cook that day"', () => {
    const template: MealPlanTemplate = { slots: [obiad], cookDays: { 2: 1 } };
    expect(resolveRunLength(obiad, '2026-09-09', template)).toBe(1);
  });
});

// ---- candidates --------------------------------------------------------------------------

describe('planCandidates', () => {
  function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
    return {
      id,
      name: id,
      instructions: '',
      items: [{ ingredientId: 'usda:1', amount: 100, unit: 'g' }],
      tags: [],
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      ...overrides
    };
  }

  const lookup = ingredientLookup([
    {
      id: 'usda:1',
      name: 'Kurczak',
      aliases: [],
      state: 'raw',
      per100g: macros(100, 20, 0, 2),
      source: 'usda'
    },
    {
      id: 'usda:0',
      name: 'Woda',
      aliases: [],
      state: 'raw',
      per100g: macros(0, 0, 0, 0),
      source: 'usda'
    }
  ]);

  it('drops the three kinds of recipe that would poison the search, and counts them', () => {
    const { candidates, skipped } = planCandidates(
      [
        recipe('ok'),
        recipe('excluded', { tags: [NO_PLAN_TAG] }),
        // `szt` with no weight per piece: it silently weighs nothing.
        recipe('incomplete', { items: [{ ingredientId: 'usda:1', amount: 2, unit: 'szt' }] }),
        recipe('zero', { items: [{ ingredientId: 'usda:0', amount: 500, unit: 'g' }] }),
        recipe('empty', { items: [] })
      ],
      lookup
    );

    expect(candidates.map((row) => row.recipeId)).toEqual(['ok']);
    expect(skipped).toEqual({ excluded: 1, incomplete: 2, zeroKcal: 1 });
    expect(skippedLabel(skipped)).toBe(
      'Pominięto 4 przepisy: 1 z tagiem „nie-planuj", 2 z niekompletnymi składnikami, 1 bez wartości odżywczych.'
    );
  });

  it('carries `lastPlannedDate` through from the usage map', () => {
    const usage = new Map([['ok', { plannedCount: 3, lastPlannedDate: '2026-09-05' }]]);
    const { candidates } = planCandidates([recipe('ok')], lookup, usage);
    expect(candidates[0]?.lastPlannedDate).toBe('2026-09-05');
  });

  it('reads a slot’s tags as alternatives, and no tags as "any recipe"', () => {
    const pool = [
      candidate('a', 400, { tags: ['wege'] }),
      candidate('b', 400, { tags: ['mieso'] }),
      candidate('c', 400, { tags: ['deser'] })
    ];
    expect(
      candidatesForSlot(pool, slot('obiad', 0.4, 1, ['wege', 'mieso'])).map((row) => row.recipeId)
    ).toEqual(['a', 'b']);
    expect(candidatesForSlot(pool, slot('obiad', 0.4)).map((row) => row.recipeId)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });
});

// ---- repetition --------------------------------------------------------------------------

describe('repeatCost', () => {
  it('is free for a recipe that was never planned', () => {
    expect(repeatCost(undefined, MONDAY)).toBe(0);
  });

  it('decays to nothing over a fortnight', () => {
    expect(repeatCost(MONDAY, MONDAY)).toBe(1);
    expect(repeatCost('2026-09-06', MONDAY)).toBeCloseTo(13 / 14);
    expect(repeatCost('2026-08-31', MONDAY)).toBeCloseTo(7 / 14);
    expect(repeatCost('2026-08-24', MONDAY)).toBe(0);
  });

  it('counts a day planned ahead exactly as it counts one behind', () => {
    expect(repeatCost('2026-09-09', MONDAY)).toBeCloseTo(repeatCost('2026-09-05', MONDAY));
  });
});

// ---- the weekly balance ------------------------------------------------------------------

describe('weekBalance', () => {
  function day(date: string, kcal: number): Day {
    return {
      date,
      meals: [
        {
          id: `m-${date}`,
          recipeId: 'r1',
          cookingScale: 1,
          portionsEaten: 1,
          macroSnapshot: macros(kcal, 10, 20, 5)
        }
      ]
    };
  }

  it('says nothing when the week has nothing to say', () => {
    expect(weekBalance([MONDAY], [], GOALS).note).toBe('');
    // A whole week being planned has no already-planned days at all.
    expect(weekBalance(WEEK, [day(MONDAY, 1400)], GOALS).correction).toBe(0);
  });

  it('spreads a surplus over the days still unplanned, and says so in Polish', () => {
    // Monday 1500 and Tuesday 1700 against 2000 each: 800 kcal of slack over five days
    // still unplanned (Wednesday is the one being planned, plus Thu-Sun).
    const balance = weekBalance(
      ['2026-09-09'],
      [day(MONDAY, 1500), day('2026-09-08', 1700)],
      GOALS
    );
    expect(balance.surplus).toBe(800);
    expect(balance.spreadDays).toBe(5);
    expect(balance.correction).toBe(160);
    expect(balance.clamped).toBe(false);
    expect(balance.note).toBe(
      'W tym tygodniu masz zapas 800 kcal — rozłożony na 5 dni daje +160 kcal do celu tego dnia.'
    );
  });

  it('clamps the correction to ±10% of the daily goal, and says that it did', () => {
    // Four days 1000 kcal under each: 4000 over three remaining days is +1333, far past 200.
    const balance = weekBalance(
      ['2026-09-11'],
      [day(MONDAY, 1000), day('2026-09-08', 1000), day('2026-09-09', 1000), day('2026-09-10', 1000)],
      GOALS
    );
    expect(balance.correction).toBe(BALANCE_CLAMP * GOALS.kcal);
    expect(balance.clamped).toBe(true);
    expect(balance.note).toContain('limit to ±10% celu dnia');
  });

  it('goes the other way when the week is over budget', () => {
    const balance = weekBalance(['2026-09-09'], [day(MONDAY, 2600)], GOALS);
    expect(balance.surplus).toBe(-600);
    expect(balance.correction).toBe(-100);
    expect(balance.note).toBe(
      'W tym tygodniu masz 600 kcal ponad plan — rozłożony na 6 dni daje -100 kcal do celu tego dnia.'
    );
  });

  it('judges a day against its own frozen goalSnapshot, not against the profile', () => {
    const frozen: Day = { ...day(MONDAY, 1000), goalSnapshot: macros(1500, 90, 150, 50) };
    // 1500 - 1000 = 500 of slack, not 1000.
    expect(weekBalance(['2026-09-09'], [frozen], GOALS).surplus).toBe(500);
  });

  it('moves the target and keeps the macro split', () => {
    const corrected = correctedGoals(GOALS, 200);
    expect(corrected.kcal).toBe(2200);
    expect(corrected.protein).toBeCloseTo(132);
    expect(correctedGoals(GOALS, 0)).toEqual(GOALS);
  });
});

// ---- the block structure -----------------------------------------------------------------

describe('planBlocks', () => {
  it('lays a two-day slot out as runs of two across the week', () => {
    const template: MealPlanTemplate = { slots: [slot('obiad', 1, 2)] };
    const blocks = planBlocks({ days: inputs(WEEK), template });
    expect(blocks.map((block) => block.dates)).toEqual([
      [WEEK[0], WEEK[1]],
      [WEEK[2], WEEK[3]],
      [WEEK[4], WEEK[5]],
      // A run never overruns the end of the range, so Sunday stands alone.
      [WEEK[6]]
    ]);
  });

  it('lets `cookDays` start a three-day cook on Sunday and nowhere else', () => {
    const template: MealPlanTemplate = { slots: [slot('obiad', 1, 1)], cookDays: { 6: 3 } };
    // Sunday to Tuesday of the following week.
    const range = [WEEK[6]!, '2026-09-14', '2026-09-15', '2026-09-16'];
    const blocks = planBlocks({ days: inputs(range), template });
    expect(blocks[0]?.dates).toEqual([WEEK[6], '2026-09-14', '2026-09-15']);
    expect(blocks[1]?.dates).toEqual(['2026-09-16']);
  });

  it('staggers two long runs rather than starting both on the same day', () => {
    const template: MealPlanTemplate = { slots: [slot('obiad', 0.6, 3), slot('kolacja', 0.4, 3)] };
    const blocks = planBlocks({ days: inputs(WEEK), template });
    const obiad = blocks.filter((block) => block.slotId === 'obiad');
    const kolacja = blocks.filter((block) => block.slotId === 'kolacja');

    expect(obiad[0]?.dates).toEqual([WEEK[0], WEEK[1], WEEK[2]]);
    // The later slot drops to a single day rather than doubling the first three.
    expect(kolacja[0]?.dates).toEqual([WEEK[0]]);
    expect(kolacja[1]?.dates).toEqual([WEEK[1], WEEK[2], WEEK[3]]);

    const starts = blocks.filter((block) => block.dates.length > 1).map((block) => block.dates[0]);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('honours the sheet’s one-off run length without touching the template', () => {
    const template: MealPlanTemplate = { slots: [slot('obiad', 1, 1)] };
    const id = runId('obiad', WEEK[0]!);
    const blocks = planBlocks({ days: inputs(WEEK), template, runLengths: { [id]: 3 } });
    expect(blocks[0]?.dates).toEqual([WEEK[0], WEEK[1], WEEK[2]]);
    expect(template.slots[0]?.batchDays).toBe(1);
  });

  it('skips a day whose slot an existing meal already holds, and never swallows one', () => {
    const template: MealPlanTemplate = { slots: [slot('obiad', 1, 3)] };
    const days = inputs(WEEK).map((day) =>
      day.date === WEEK[2] ? { ...day, takenSlotIds: ['obiad'] } : day
    );
    const blocks = planBlocks({ days, template });
    // The Monday run stops before the taken Wednesday instead of covering it.
    expect(blocks[0]?.dates).toEqual([WEEK[0], WEEK[1]]);
    expect(blocks.every((block) => !block.dates.includes(WEEK[2]!))).toBe(true);
  });
});

// ---- solving a day -----------------------------------------------------------------------

describe('planning one day', () => {
  it('fills every slot and lands inside the band', () => {
    const result = planRange({
      days: inputs([MONDAY]),
      template: FOUR_SLOTS,
      candidates: library(),
      random: seededRandom(1)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.runs).toHaveLength(4);
    expect(result.proposal.days[0]?.unfilledSlotIds).toEqual([]);
    expect(result.proposal.days[0]?.outOfBand).toBe(false);
    expect(Math.abs(result.proposal.days[0]!.totals.kcal - GOALS.kcal)).toBeLessThanOrEqual(
      DAY_BAND * GOALS.kcal
    );
  });

  it('is deterministic under a seeded generator, and different under another seed', () => {
    const plan = (seed: number) =>
      planRange({
        days: inputs([MONDAY]),
        template: FOUR_SLOTS,
        candidates: library(),
        random: seededRandom(seed)
      });

    const first = plan(7);
    const again = plan(7);
    expect(JSON.stringify(first)).toBe(JSON.stringify(again));

    // „Losuj ponownie" has to actually give something else.
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => {
      const result = plan(seed);
      return result.ok ? result.proposal.runs.map((run) => run.recipeId).join(',') : 'x';
    });
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('never proposes the same recipe twice in one day', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = planRange({
        days: inputs([MONDAY]),
        template: FOUR_SLOTS,
        candidates: library(),
        random: seededRandom(seed)
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const ids = result.proposal.runs.map((run) => run.recipeId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('only ever uses the portion steps it is allowed', () => {
    const result = planRange({
      days: inputs(WEEK),
      template: FOUR_SLOTS,
      candidates: library(),
      random: seededRandom(11)
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const run of result.proposal.runs) expect(PORTION_STEPS).toContain(run.portionsEaten);
  });

  it('prefers a recipe nobody has eaten to an equally good one from yesterday', () => {
    // Two identical fits; only the history differs.
    const pool = [
      candidate('stale', 500, { lastPlannedDate: '2026-09-06' }),
      candidate('fresh', 500)
    ];
    const template: MealPlanTemplate = { slots: [slot('obiad', 1)] };
    const picks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => {
      const result = planRange({
        days: planDayInputs([MONDAY], [], macros(500, 30, 60, 18), template, {
          surplus: 0,
          spreadDays: 0,
          correction: 0,
          clamped: false,
          note: ''
        }),
        template,
        candidates: pool,
        random: seededRandom(seed)
      });
      return result.ok ? result.proposal.runs[0]?.recipeId : 'x';
    });
    expect(picks.every((pick) => pick === 'fresh')).toBe(true);
  });

  it('leaves existing meals alone and fills only what is left — „Uzupełnij dzień"', () => {
    const existing: Day = {
      date: MONDAY,
      meals: [
        {
          id: 'm1',
          recipeId: 'r5',
          cookingScale: 1,
          portionsEaten: 1,
          macroSnapshot: macros(610, 38, 68, 20)
        },
        {
          id: 'm2',
          recipeId: 'r6',
          cookingScale: 1,
          portionsEaten: 1,
          macroSnapshot: macros(680, 42, 76, 23)
        }
      ]
    };
    const days = planDayInputs([MONDAY], [existing], GOALS, FOUR_SLOTS, {
      surplus: 0,
      spreadDays: 0,
      correction: 0,
      clamped: false,
      note: ''
    });

    expect(days[0]?.existing.kcal).toBe(1290);
    // Mapped to slots by position: the first two rows of the template.
    expect(days[0]?.takenSlotIds).toEqual(['sniadanie', 'obiad']);

    const result = planRange({
      days,
      template: FOUR_SLOTS,
      candidates: library(),
      random: seededRandom(3)
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the two free slots are proposed, and neither reuses what is already there.
    expect(result.proposal.runs.map((run) => run.slotId).sort()).toEqual([
      'kolacja',
      'podwieczorek'
    ]);
    expect(result.proposal.runs.map((run) => run.recipeId)).not.toContain('r5');
    expect(result.proposal.runs.map((run) => run.recipeId)).not.toContain('r6');
    // The proposal is judged on the whole day, existing meals included.
    expect(result.proposal.days[0]?.totals.kcal).toBeCloseTo(
      1290 + result.proposal.days[0]!.planned.kcal
    );
    expect(result.proposal.days[0]?.outOfBand).toBe(false);
  });

  it('lets the user move an existing meal to another slot before generating', () => {
    const existing: Day = {
      date: MONDAY,
      meals: [
        {
          id: 'm1',
          recipeId: 'r5',
          cookingScale: 1,
          portionsEaten: 1,
          macroSnapshot: macros(610, 38, 68, 20)
        }
      ]
    };
    const days = planDayInputs([MONDAY], [existing], GOALS, FOUR_SLOTS, {
      surplus: 0,
      spreadDays: 0,
      correction: 0,
      clamped: false,
      note: ''
    }, { m1: 'kolacja' });
    expect(days[0]?.takenSlotIds).toEqual(['kolacja']);
  });
});

// ---- solving a week ----------------------------------------------------------------------

describe('planning a week', () => {
  const result = planRange({
    days: inputs(WEEK),
    template: FOUR_SLOTS,
    candidates: library(),
    random: seededRandom(5)
  });

  it('averages within ±5% of the goal, with no day outside its own ±15%', () => {
    // Every seed, not one lucky one: the band is a hard rule, not a tendency.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const plan = planRange({
        days: inputs(WEEK),
        template: FOUR_SLOTS,
        candidates: library(),
        random: seededRandom(seed)
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;

      const total = plan.proposal.days.reduce((sum, day) => sum + day.totals.kcal, 0);
      const average = total / plan.proposal.days.length;
      expect(Math.abs(average - GOALS.kcal)).toBeLessThanOrEqual(0.05 * GOALS.kcal);

      for (const day of plan.proposal.days) {
        expect(day.outOfBand).toBe(false);
        expect(Math.abs(day.totals.kcal - GOALS.kcal)).toBeLessThanOrEqual(DAY_BAND * GOALS.kcal);
      }
    }
    expect(result.ok).toBe(true);
  });

  it('costs single-digit milliseconds', () => {
    const started = performance.now();
    planRange({
      days: inputs(WEEK),
      template: FOUR_SLOTS,
      candidates: library(),
      random: seededRandom(9)
    });
    // Generous by an order of magnitude: what this asserts is that no worker is needed.
    expect(performance.now() - started).toBeLessThan(400);
  });
});

// ---- cooking ahead -----------------------------------------------------------------------

describe('cooking ahead', () => {
  const template: MealPlanTemplate = {
    slots: [slot('sniadanie', 0.3), slot('obiad', 0.45, 2), slot('kolacja', 0.25)]
  };

  const result = planRange({
    days: inputs(WEEK),
    template,
    candidates: library(),
    random: seededRandom(4)
  });

  it('produces pairs of consecutive days eating one pot', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runs = result.proposal.runs.filter((run) => run.slotId === 'obiad');
    expect(runs.map((run) => run.dates.length)).toEqual([2, 2, 2, 1]);
    for (const run of runs) {
      const [first, second] = run.dates;
      if (second === undefined) continue;
      expect(WEEK.indexOf(second)).toBe(WEEK.indexOf(first!) + 1);
    }
  });

  it('keeps `cookingScale = runLength × portionsEaten` at every length', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const run of result.proposal.runs) {
      expect(run.cookingScale).toBeCloseTo(run.dates.length * run.portionsEaten);
    }
  });

  it('is not simply 2 — a 1.25-portion dinner cooked for three days needs 3.75 in the pot', () => {
    const run: PlanRun = {
      id: runId('obiad', MONDAY),
      slotId: 'obiad',
      dates: [MONDAY, '2026-09-08', '2026-09-09'],
      recipeId: 'r1',
      recipeName: 'r1',
      portionsEaten: 1.25,
      macroSnapshot: macros(500, 30, 60, 18),
      cookingScale: 3.75
    };
    const writes = planWrites([run], run.dates, idFactory());
    expect(writes.map((write) => write.meals[0]?.cookingScale)).toEqual([3.75, 1, 1]);
    // Every day of the run eats the same plate out of the same pot.
    expect(writes.map((write) => write.meals[0]?.portionsEaten)).toEqual([1.25, 1.25, 1.25]);
    // And the snapshot is copied by value onto each day, never shared.
    expect(writes[1]?.meals[0]?.macroSnapshot).toEqual(run.macroSnapshot);
    expect(writes[1]?.meals[0]?.macroSnapshot).not.toBe(run.macroSnapshot);
  });

  it('counts a run as one use, dated on the cooking day', () => {
    // The freshness cost is measured from the day the pot was cooked, not from the last day
    // it was eaten: a run is one decision (STATE.md decision 267).
    expect(repeatCost(MONDAY, '2026-09-09')).toBeCloseTo(12 / 14);

    // Two recipes, one slot cooked for two days, four days to fill: the second pot is a
    // different recipe, because a run that has just been cooked is still expensive.
    const two: MealPlanTemplate = { slots: [slot('obiad', 1, 2)] };
    const range = [MONDAY, '2026-09-08', '2026-09-09', '2026-09-10'];
    const plan = planRange({
      days: inputs(range, macros(1000, 60, 110, 35)),
      template: two,
      candidates: [candidate('a', 1000), candidate('b', 1000)],
      random: seededRandom(3)
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const cooked = plan.proposal.runs.map((run) => run.recipeId);
    expect(cooked).toHaveLength(2);
    expect(cooked[0]).not.toBe(cooked[1]);
  });

  it('never puts the same recipe on one day twice, over a whole week', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const date of WEEK) {
      const onThisDay = result.proposal.runs
        .filter((run) => run.dates.includes(date))
        .map((run) => run.recipeId);
      expect(new Set(onThisDay).size).toBe(onThisDay.length);
    }
  });

  it('shortens a run rather than overrunning the end of the range', () => {
    const three: MealPlanTemplate = { slots: [slot('obiad', 1, 3)] };
    const plan = planRange({
      // One slot has to carry the whole day, so the goal is one the library can reach.
      days: inputs([MONDAY, '2026-09-08'], macros(1200, 72, 132, 42)),
      template: three,
      candidates: library(),
      random: seededRandom(2)
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.proposal.runs[0]?.dates).toEqual([MONDAY, '2026-09-08']);
    expect(plan.proposal.shortenedSlotIds).toEqual(['obiad']);
  });

  it('measures how much of the range is locked inside long cooks', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Three two-day lunch runs over 7 days x 3 slots: three fixed slot-days out of 21.
    expect(batchedShare(result.proposal, template)).toBeCloseTo(3 / 21);
  });
});

// ---- locks and rerolls -------------------------------------------------------------------

describe('locks', () => {
  it('keeps a locked run through a reroll and changes only the rest', () => {
    const first = planRange({
      days: inputs([MONDAY]),
      template: FOUR_SLOTS,
      candidates: library(),
      random: seededRandom(1)
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const locked = first.proposal.runs.find((run) => run.slotId === 'obiad') as PlanRun;

    for (const seed of [2, 3, 4, 5]) {
      const again = planRange({
        days: inputs([MONDAY]),
        template: FOUR_SLOTS,
        candidates: library(),
        locked: [locked],
        random: seededRandom(seed)
      });
      expect(again.ok).toBe(true);
      if (!again.ok) continue;
      const kept = again.proposal.runs.find((run) => run.slotId === 'obiad');
      expect(kept).toEqual(locked);
      // …and nothing else reuses the locked recipe on that day.
      const others = again.proposal.runs.filter((run) => run.slotId !== 'obiad');
      expect(others.map((run) => run.recipeId)).not.toContain(locked.recipeId);
    }
  });

  it('re-solves the days a run’s new length touches and leaves every lock alone', () => {
    const template: MealPlanTemplate = {
      slots: [slot('sniadanie', 0.3), slot('obiad', 0.45, 1), slot('kolacja', 0.25)]
    };
    const base = planRange({
      days: inputs(WEEK),
      template,
      candidates: library(),
      random: seededRandom(6)
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const breakfast = base.proposal.runs.find(
      (run) => run.slotId === 'sniadanie' && run.dates[0] === WEEK[0]
    ) as PlanRun;
    const id = runId('obiad', WEEK[0]!);

    const stretched = planRange({
      days: inputs(WEEK),
      template,
      candidates: library(),
      locked: [breakfast],
      runLengths: { [id]: 3 },
      random: seededRandom(6)
    });
    expect(stretched.ok).toBe(true);
    if (!stretched.ok) return;

    expect(stretched.proposal.runs.find((run) => run.id === id)?.dates).toEqual([
      WEEK[0],
      WEEK[1],
      WEEK[2]
    ]);
    expect(stretched.proposal.runs.find((run) => run.id === breakfast.id)).toEqual(breakfast);
    // The one-off never writes back into the template.
    expect(template.slots[1]?.batchDays).toBe(1);
  });
});

// ---- failures ----------------------------------------------------------------------------

describe('when nothing fits, the message names which case it is', () => {
  it('an empty library', () => {
    const result = planRange({
      days: inputs([MONDAY]),
      template: FOUR_SLOTS,
      candidates: [],
      random: seededRandom(1)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('no-candidates');
    expect(failureMessage(result.failure).title).toBe('Za mało przepisów');
  });

  it('a slot whose tags name nothing, said with the slot and the tags', () => {
    const template: MealPlanTemplate = {
      slots: [slot('obiad', 0.6, 1, ['wege']), slot('kolacja', 0.4)]
    };
    template.slots[0]!.label = 'Obiad';
    const result = planRange({
      days: inputs([MONDAY]),
      template,
      candidates: library(),
      random: seededRandom(1)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: 'slot-tags', slotLabel: 'Obiad' });
    const message = failureMessage(result.failure);
    expect(message.title).toBe('Brak przepisów na „Obiad"');
    expect(message.detail).toContain('„wege"');
    expect(message.hint).toContain('Poluzuj tagi');
  });

  it('a plan that misses the band comes back anyway, with its difference spelled out', () => {
    // One 200 kcal recipe against a 2000 kcal goal: even two portions cannot reach the band.
    const template: MealPlanTemplate = { slots: [slot('obiad', 1)] };
    const result = planRange({
      days: inputs([MONDAY]),
      template,
      candidates: [candidate('tiny', 200)],
      random: seededRandom(1)
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'tolerance') {
      expect.unreachable('expected a tolerance failure');
      return;
    }
    expect(result.failure.proposal.runs).toHaveLength(1);
    expect(result.failure.diff.kcal).toBeLessThan(0);
    expect(diffLabel(result.failure.diff)).toContain('kcal');
    expect(failureMessage(result.failure).detail).toContain('Najbliżej:');
  });

  it('a week made unsatisfiable by long cooks says that in those terms', () => {
    // Every slot on a three-day run: with the days' targets pulled apart by the weekly
    // balance there are almost no knobs left, which is the failure users cannot guess.
    const template: MealPlanTemplate = {
      slots: [slot('obiad', 0.5, 3), slot('kolacja', 0.5, 3)]
    };
    const days = inputs(WEEK).map((day, index) => ({
      ...day,
      // Alternating goals that no fixed three-day block can follow.
      goals: macros(index % 2 === 0 ? 1200 : 2800, 120, 220, 70),
      target: macros(index % 2 === 0 ? 1200 : 2800, 120, 220, 70)
    }));

    const result = planRange({
      days,
      template,
      candidates: library(),
      random: seededRandom(1)
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== 'tolerance') {
      expect.unreachable('expected a tolerance failure');
      return;
    }
    expect(result.failure.tooManyBatchDays).toBe(true);
    expect(failureMessage(result.failure).detail).toContain('Zbyt wiele dni gotowanych na zapas');
    expect(failureMessage(result.failure).hint).toContain('Skróć');
  });
});

// ---- writing the plan --------------------------------------------------------------------

function idFactory(): () => string {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

describe('writing the plan', () => {
  const run: PlanRun = {
    id: runId('obiad', MONDAY),
    slotId: 'obiad',
    dates: [MONDAY, '2026-09-08', '2026-09-09'],
    recipeId: 'r1',
    recipeName: 'r1',
    portionsEaten: 1,
    macroSnapshot: macros(600, 40, 60, 20),
    cookingScale: 3
  };

  it('writes the batch exactly as „Gotuję na 2 dni" writes it', () => {
    const writes = planWrites([run], run.dates, idFactory());
    expect(writes).toHaveLength(3);
    expect(writes[0]?.meals[0]).toMatchObject({ cookingScale: 3, portionsEaten: 1, recipeId: 'r1' });
    expect(writes[1]?.meals[0]).toMatchObject({ cookingScale: 1, portionsEaten: 1 });
    expect(writes[2]?.meals[0]).toMatchObject({ cookingScale: 1, portionsEaten: 1 });
    expect(writes.map((write) => write.meals[0]?.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('shortens a run when a day it covers is unticked, rather than over-buying', () => {
    const kept = runsForDates([run], [MONDAY, '2026-09-08']);
    expect(kept[0]?.dates).toEqual([MONDAY, '2026-09-08']);
    expect(kept[0]?.cookingScale).toBe(2);

    // Unticking the cooking day moves the cook to the earliest day that survived.
    const later = runsForDates([run], ['2026-09-08', '2026-09-09']);
    expect(later[0]?.dates).toEqual(['2026-09-08', '2026-09-09']);
    expect(later[0]?.id).toBe(runId('obiad', '2026-09-08'));
    expect(later[0]?.cookingScale).toBe(2);

    expect(runsForDates([run], ['2026-09-20'])).toEqual([]);
  });

  it('writes nothing for a day the plan does not touch', () => {
    const writes = planWrites([run], [MONDAY, '2026-09-08', '2026-09-09', '2026-09-10'], idFactory());
    expect(writes.map((write) => write.date)).toEqual([MONDAY, '2026-09-08', '2026-09-09']);
  });

  it('buys a batch once — the shopping list over the whole run', () => {
    // The acceptance criterion end to end at the pure level: a run written by `planWrites`,
    // fed into the list the week screen builds. 200 g per portion, 3 portions in the pot.
    const recipe: Recipe = {
      id: 'r1',
      name: 'r1',
      instructions: '',
      items: [{ ingredientId: 'usda:1', amount: 200, unit: 'g' }],
      tags: [],
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z'
    };
    const meals = planWrites([run], run.dates, idFactory()).flatMap((write) =>
      write.meals.map((meal) => ({ meal, recipe, date: write.date }))
    );

    expect(shoppingLines(meals, () => undefined)[0]?.amount).toBe(600);
  });
});
