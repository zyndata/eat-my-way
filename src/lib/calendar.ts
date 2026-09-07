import type { Day, Macros } from './types';
import { dayTotals, remainingMacros } from './macros';
import { addDays, toDateKey, parseDateKey, weekdayIndex } from './dates';

/**
 * Calendar structure and the numbers the calendar screens draw: which days a week or a
 * month covers, and how one day stands against its goals.
 *
 * Pure — nothing here reads the clock or the database. The week starts on Monday
 * (decision 74).
 */

export const WEEK_LENGTH = 7;

/** The Monday of the week containing `key`. */
export function weekStart(key: string): string {
  return addDays(key, -weekdayIndex(key));
}

/** `length` consecutive days starting at `start` — a run of days that need not begin on a Monday. */
export function rangeFrom(start: string, length: number = WEEK_LENGTH): string[] {
  return Array.from({ length }, (_, index) => addDays(start, index));
}

/** The seven days of the week containing `key`, Monday first. */
export function weekDates(key: string): string[] {
  return rangeFrom(weekStart(key));
}

/** The week after the one containing `key` — PLAN.md's „cały przyszły tydzień" shortcut. */
export function nextWeekDates(key: string): string[] {
  return weekDates(addDays(weekStart(key), WEEK_LENGTH));
}

/** True when both keys fall in the same calendar month of the same year. */
export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** First day of the month containing `key`. */
export function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** Last day of the month containing `key`. */
export function monthEnd(key: string): string {
  const date = parseDateKey(key);
  // Day 0 of the next month is the last day of this one.
  return toDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12));
}

/**
 * The month containing `key` as whole Monday-to-Sunday rows: from the Monday on or before
 * the 1st to the Sunday on or after the last day. Five or six rows, never a padded fixed
 * six (decision 74). Leading and trailing cells belong to the neighbouring months, which is
 * what `isSameMonth` is for.
 */
export function monthWeeks(key: string): string[][] {
  const first = weekStart(monthStart(key));
  const last = weekStart(monthEnd(key));
  const weeks: string[][] = [];
  for (let start = first; start <= last; start = addDays(start, WEEK_LENGTH)) {
    weeks.push(weekDates(start));
  }
  return weeks;
}

// ---- day summaries -----------------------------------------------------------------------

/** Everything a ring, a bar or a day header needs about one day. */
export interface DaySummary {
  date: string;
  /** Sum of the day's meals — `macroSnapshot × portionsEaten` each. */
  totals: Macros;
  /** The day's own `goalSnapshot`, or the profile's current goals (decision 75). */
  goals: Macros;
  mealCount: number;
  /** True when the day has a frozen `goalSnapshot`, i.e. `goals` is history, not the profile. */
  goalsFrozen: boolean;
}

/**
 * The goals a day is judged against: the snapshot taken when its first meal landed, or the
 * profile's current goals for a day that has never been planned. The single place this
 * fallback is decided.
 */
export function dayGoals(day: Day | undefined, profileGoals: Macros): Macros {
  return day?.goalSnapshot ?? profileGoals;
}

export function summarizeDay(
  date: string,
  day: Day | undefined,
  profileGoals: Macros
): DaySummary {
  return {
    date,
    totals: day === undefined ? { kcal: 0, protein: 0, carbs: 0, fat: 0 } : dayTotals(day),
    goals: dayGoals(day, profileGoals),
    mealCount: day?.meals.length ?? 0,
    goalsFrozen: day?.goalSnapshot !== undefined
  };
}

/** Summaries for a list of dates, given whatever day rows exist among them. */
export function summarizeDates(
  dates: readonly string[],
  days: readonly Day[],
  profileGoals: Macros
): DaySummary[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return dates.map((date) => summarizeDay(date, byDate.get(date), profileGoals));
}

// ---- progress ----------------------------------------------------------------------------

/**
 * How full a ring or bar is drawn: `value / goal`, clamped to 0…1. A goal of zero or less
 * has nothing to fill, so it reads as empty rather than as infinitely exceeded.
 */
export function goalRatio(value: number, goal: number): number {
  if (!Number.isFinite(goal) || goal <= 0) return 0;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / goal);
}

/** True once the goal has actually been passed — what colours the bar, not what fills it. */
export function isOverGoal(value: number, goal: number): boolean {
  return Number.isFinite(goal) && goal > 0 && value > goal;
}

// ---- the day's remaining budget ----------------------------------------------------------

/**
 * What is left of the day's kcal goal — the number the recipe picker shows and filters by
 * (STATE.md decision 64).
 */
export interface DayBudget {
  /** Kilocalories still available. Negative once the goal has been passed. */
  remaining: number;
  /** There is a kcal goal at all. Without one there is nothing to fit into. */
  hasGoal: boolean;
  /** There is a goal, and nothing is left of it. */
  exhausted: boolean;
  /** The „Zmieści się w limicie" toggle is worth offering. */
  canFilter: boolean;
}

export function dayBudget(totals: Macros, goals: Macros): DayBudget {
  const hasGoal = Number.isFinite(goals.kcal) && goals.kcal > 0;
  const remaining = hasGoal ? goals.kcal - totals.kcal : 0;
  const exhausted = hasGoal && remaining <= 0;
  return { remaining, hasGoal, exhausted, canFilter: hasGoal && !exhausted };
}

/**
 * What is left of every goal the day actually has — the readout PLAN.md Phase 9 task 6 puts
 * in the picker header („zostało 620 kcal · 40 g białka").
 *
 * A **readout, not a ranking** (STATE.md decision 148): it answers „czego mi dziś brakuje"
 * and leaves the choice of recipe to the user. A goal of zero or less is not a goal, so it
 * produces no entry rather than a permanently exhausted one; a day with no goals at all
 * produces an empty list and the header simply says nothing.
 *
 * `remaining` is negative once a goal has been passed, deliberately: „−40 g białka" is the
 * honest reading, and clamping it at zero would claim the day is exactly on target.
 */
export interface RemainingGoal {
  key: keyof Macros;
  /** Polish unit as it follows the number: „kcal", „g białka", … */
  label: string;
  remaining: number;
}

const GOAL_LABELS: ReadonlyArray<{ key: keyof Macros; label: string }> = [
  { key: 'kcal', label: 'kcal' },
  { key: 'protein', label: 'g białka' },
  { key: 'carbs', label: 'g węglowodanów' },
  { key: 'fat', label: 'g tłuszczu' }
];

export function remainingGoals(totals: Macros, goals: Macros): RemainingGoal[] {
  const left = remainingMacros(goals, totals);
  return GOAL_LABELS.filter(({ key }) => Number.isFinite(goals[key]) && goals[key] > 0).map(
    ({ key, label }) => ({ key, label, remaining: left[key] })
  );
}

// ---- the week's totals -------------------------------------------------------------------

/**
 * What a whole week adds up to — the row under the week strip.
 *
 * `goals` sums **every** day in the range, including the ones with nothing on them: a day
 * you have not planned yet still has a target, and the point of a weekly readout is to see
 * how much of the week is still open. Summing only the planned days would make a half-empty
 * week look permanently on budget, which is the opposite of useful when the reason to look
 * is „ile mi jeszcze zostało do zaplanowania".
 *
 * Each day is judged against its own goals — the frozen `goalSnapshot` where there is one,
 * the profile's current goals elsewhere (decision 75) — so a week spanning a change of goals
 * adds up honestly rather than re-judging history against today's numbers.
 */
export interface WeekTotals {
  totals: Macros;
  goals: Macros;
  /** Days carrying at least one meal. */
  plannedDays: number;
  /** Days in the range, planned or not. */
  dayCount: number;
  /** Mean kcal across the planned days only; zero when nothing is planned. */
  averageKcal: number;
}

export function summarizeWeekTotals(summaries: readonly DaySummary[]): WeekTotals {
  const totals: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const goals: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  let plannedDays = 0;

  for (const day of summaries) {
    for (const key of ['kcal', 'protein', 'carbs', 'fat'] as const) {
      totals[key] += day.totals[key];
      // A goal that is zero, absent or nonsense contributes nothing rather than poisoning
      // the sum with a NaN that would blank the whole readout.
      if (Number.isFinite(day.goals[key]) && day.goals[key] > 0) goals[key] += day.goals[key];
    }
    if (day.mealCount > 0) plannedDays += 1;
  }

  return {
    totals,
    goals,
    plannedDays,
    dayCount: summaries.length,
    averageKcal: plannedDays === 0 ? 0 : totals.kcal / plannedDays
  };
}
