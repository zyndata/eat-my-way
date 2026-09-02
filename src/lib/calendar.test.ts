import { describe, expect, it } from 'vitest';
import {
  dayBudget,
  dayGoals,
  goalRatio,
  isOverGoal,
  isSameMonth,
  monthEnd,
  monthStart,
  monthWeeks,
  nextWeekDates,
  remainingGoals,
  summarizeDates,
  summarizeDay,
  weekDates,
  weekStart
} from './calendar';
import type { Day, PlannedMeal } from './types';
import { macros } from '../test/fixtures';

const goals = macros(2000, 100, 250, 70);

function mealOf(id: string, kcal: number, portionsEaten = 1): PlannedMeal {
  return {
    id,
    recipeId: 'recipe-1',
    cookingScale: 1,
    portionsEaten,
    macroSnapshot: macros(kcal, 10, 20, 5)
  };
}

describe('weekStart / weekDates', () => {
  it('starts the week on Monday', () => {
    // 2026-09-03 is a Thursday.
    expect(weekStart('2026-09-03')).toBe('2026-08-31');
    expect(weekStart('2026-08-31')).toBe('2026-08-31');
    // Sunday belongs to the week that started six days earlier, not to the next one.
    expect(weekStart('2026-09-06')).toBe('2026-08-31');
  });

  it('returns seven consecutive days', () => {
    expect(weekDates('2026-09-03')).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06'
    ]);
  });
});

describe('nextWeekDates', () => {
  it('is the whole week after the one containing the date', () => {
    expect(nextWeekDates('2026-09-03')).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13'
    ]);
  });
});

describe('monthStart / monthEnd', () => {
  it('finds the edges of the month, February included', () => {
    expect(monthStart('2026-09-17')).toBe('2026-09-01');
    expect(monthEnd('2026-09-17')).toBe('2026-09-30');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthEnd('2024-02-10')).toBe('2024-02-29');
  });
});

describe('monthWeeks', () => {
  it('covers the month in whole Monday-to-Sunday rows', () => {
    const weeks = monthWeeks('2026-09-17');
    expect(weeks[0]?.[0]).toBe('2026-08-31');
    expect(weeks.at(-1)?.at(-1)).toBe('2026-10-04');
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });

  it('is only as tall as the month needs — five rows here, six there', () => {
    // September 2026 starts on a Tuesday and ends on a Wednesday: five rows.
    expect(monthWeeks('2026-09-01')).toHaveLength(5);
    // August 2026 starts on a Saturday and ends on a Monday: six.
    expect(monthWeeks('2026-08-01')).toHaveLength(6);
  });

  it('a month that starts on a Monday needs no leading days', () => {
    expect(monthWeeks('2026-06-15')[0]?.[0]).toBe('2026-06-01');
  });
});

describe('isSameMonth', () => {
  it('compares month and year together', () => {
    expect(isSameMonth('2026-09-01', '2026-09-30')).toBe(true);
    expect(isSameMonth('2026-09-30', '2026-10-01')).toBe(false);
    expect(isSameMonth('2025-09-01', '2026-09-01')).toBe(false);
  });
});

describe('dayGoals', () => {
  it('prefers the day snapshot over the profile goals', () => {
    const frozen = macros(1800, 90, 200, 60);
    const day: Day = { date: '2026-09-01', meals: [mealOf('m1', 500)], goalSnapshot: frozen };
    expect(dayGoals(day, goals)).toEqual(frozen);
  });

  it('falls back to the profile for a day that was never planned', () => {
    expect(dayGoals(undefined, goals)).toEqual(goals);
    expect(dayGoals({ date: '2026-09-01', meals: [] }, goals)).toEqual(goals);
  });
});

describe('summarizeDay', () => {
  it('totals the meals against the frozen goals', () => {
    const frozen = macros(1800, 90, 200, 60);
    const day: Day = {
      date: '2026-09-01',
      meals: [mealOf('m1', 500), mealOf('m2', 300, 2)],
      goalSnapshot: frozen
    };

    const summary = summarizeDay('2026-09-01', day, goals);
    expect(summary.totals.kcal).toBe(1100);
    expect(summary.goals).toEqual(frozen);
    expect(summary.mealCount).toBe(2);
    expect(summary.goalsFrozen).toBe(true);
  });

  it('reads an unplanned day as zero against the profile goals', () => {
    const summary = summarizeDay('2026-09-02', undefined, goals);
    expect(summary.totals).toEqual(macros(0, 0, 0, 0));
    expect(summary.goals).toEqual(goals);
    expect(summary.goalsFrozen).toBe(false);
  });
});

describe('summarizeDates', () => {
  it('returns one summary per requested date, in order, filling the gaps', () => {
    const days: Day[] = [{ date: '2026-09-02', meals: [mealOf('m1', 700)] }];
    const summaries = summarizeDates(['2026-09-01', '2026-09-02', '2026-09-03'], days, goals);

    expect(summaries.map((summary) => summary.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03'
    ]);
    expect(summaries.map((summary) => summary.totals.kcal)).toEqual([0, 700, 0]);
  });
});

describe('goalRatio', () => {
  it('is the fraction of the goal, clamped at a full ring', () => {
    expect(goalRatio(500, 2000)).toBe(0.25);
    expect(goalRatio(2500, 2000)).toBe(1);
  });

  it('reads as empty when there is nothing to fill', () => {
    // A goal of zero must not draw a full ring, and must never be a division by zero.
    expect(goalRatio(500, 0)).toBe(0);
    expect(goalRatio(0, 2000)).toBe(0);
    expect(goalRatio(-10, 2000)).toBe(0);
  });
});

describe('isOverGoal', () => {
  it('is true only past the goal, and never for a goal of zero', () => {
    expect(isOverGoal(2001, 2000)).toBe(true);
    expect(isOverGoal(2000, 2000)).toBe(false);
    expect(isOverGoal(10, 0)).toBe(false);
  });
});

describe('dayBudget', () => {
  it('is what the goal has left', () => {
    const budget = dayBudget(macros(1380, 0, 0, 0), goals);

    expect(budget.remaining).toBe(620);
    expect(budget.hasGoal).toBe(true);
    expect(budget.exhausted).toBe(false);
    expect(budget.canFilter).toBe(true);
  });

  it('a day with no kcal goal has nothing to fit into, so it offers no filter', () => {
    const budget = dayBudget(macros(1380, 0, 0, 0), macros(0, 100, 250, 70));

    expect(budget.hasGoal).toBe(false);
    expect(budget.canFilter).toBe(false);
    expect(budget.exhausted).toBe(false);
  });

  it('an exhausted budget says so and stops offering the filter', () => {
    const budget = dayBudget(macros(2300, 0, 0, 0), goals);

    expect(budget.remaining).toBe(-300);
    expect(budget.exhausted).toBe(true);
    expect(budget.canFilter).toBe(false);
  });

  it('hitting the goal exactly counts as exhausted', () => {
    expect(dayBudget(macros(2000, 0, 0, 0), goals).exhausted).toBe(true);
  });
});

describe('remainingGoals', () => {
  it('lists what is left of every goal that is actually set', () => {
    const left = remainingGoals(macros(1380, 80, 100, 40), macros(2000, 120, 250, 70));
    expect(left.map((goal) => [goal.label, goal.remaining])).toEqual([
      ['kcal', 620],
      ['g białka', 40],
      ['g węglowodanów', 150],
      ['g tłuszczu', 30]
    ]);
  });

  it('a goal of zero is not a goal and produces no entry', () => {
    const left = remainingGoals(macros(500, 30, 0, 0), macros(2000, 0, 0, 0));
    expect(left.map((goal) => goal.key)).toEqual(['kcal']);
  });

  it('reports a passed goal as a negative rather than clamping it at zero', () => {
    // „−40 g białka" is the honest reading; zero would claim the day is exactly on target.
    const left = remainingGoals(macros(2200, 160, 0, 0), macros(2000, 120, 0, 0));
    expect(left.map((goal) => goal.remaining)).toEqual([-200, -40]);
  });

  it('a day with no goals at all says nothing', () => {
    expect(remainingGoals(macros(500, 10, 10, 10), macros(0, 0, 0, 0))).toEqual([]);
  });
});
