import type { Day, Macros, PlannedMeal } from './types';
import type { DaySummary } from './calendar';
import { summarizeDates } from './calendar';
import { formatDayLong } from './dates';
import { formatPortions } from './text';

/**
 * The menu as text (PLAN.md Phase 18 task C) — the same two moves the shopping list makes,
 * for the meals instead of the ingredients: a range of days becomes plain text, and
 * `shareText` gets it out of the app.
 *
 * **Meals and day totals, not ingredients** (STATE.md decision 334). Ingredients are the
 * shopping list, which already exists; repeating them here would duplicate it and turn a week
 * into a wall of text nobody pastes into a message.
 *
 * Plain text on purpose, for `formatShoppingList`'s reasons exactly: it is what a share target
 * accepts, what a clipboard paste produces everywhere, and what stays readable when the app it
 * was pasted into parses nothing. Nothing here touches the network, so the CSP is untouched
 * (decisions 144 and 158).
 *
 * Totals are printed against the day's **own** goals — its `goalSnapshot` where it has one, so
 * a week exported in October still reads against what the goals were in September. That is
 * `summarizeDates`' rule (decision 75) and this reuses it rather than restating it.
 */

/** One meal, as the menu names it. */
export interface MenuMeal {
  name: string;
  /** Plates, not pots: a menu is what was eaten. `cookingScale` belongs to the shopping list. */
  portionsEaten: number;
}

/** One day of the menu: what is on it, and how it stands against its goals. */
export interface MenuDay {
  date: string;
  meals: MenuMeal[];
  totals: Macros;
  goals: Macros;
}

/**
 * Build the menu for `dates` out of whatever day rows exist among them.
 *
 * `nameOf` is handed in because a meal outlives the recipe it came from (decisions 51 and 73)
 * and this module has no way to look one up — the caller already holds the recipes.
 */
export function menuDays(
  dates: readonly string[],
  days: readonly Day[],
  profileGoals: Macros,
  nameOf: (meal: PlannedMeal) => string
): MenuDay[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return summarizeDates(dates, days, profileGoals).map((summary: DaySummary) => ({
    date: summary.date,
    meals: (byDate.get(summary.date)?.meals ?? []).map((meal) => ({
      name: nameOf(meal),
      portionsEaten: meal.portionsEaten
    })),
    totals: summary.totals,
    goals: summary.goals
  }));
}

/** True for a goal worth printing a target next to. Zero means „not set", not „eat nothing". */
function hasGoal(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** „1800 / 2000" — or just „1800" where no goal was ever set. */
function against(value: number, goal: number): string {
  const eaten = Math.round(value);
  return hasGoal(goal) ? `${eaten} / ${Math.round(goal)}` : `${eaten}`;
}

/** The one line under a day: what it came to, against what it was aiming at. */
export function formatMenuTotals(totals: Macros, goals: Macros): string {
  return (
    `Razem: ${against(totals.kcal, goals.kcal)} kcal` +
    ` · B ${against(totals.protein, goals.protein)} g` +
    ` · W ${against(totals.carbs, goals.carbs)} g` +
    ` · T ${against(totals.fat, goals.fat)} g`
  );
}

/** One day: its date, its meals, and its totals. A day with nothing on it says so. */
export function formatMenuDay(day: MenuDay): string {
  const head = formatDayLong(day.date);
  if (day.meals.length === 0) return `${head}\nNic nie zaplanowano.`;
  return (
    `${head}\n` +
    day.meals.map((meal) => `• ${meal.name} — ${formatPortions(meal.portionsEaten)}`).join('\n') +
    `\n${formatMenuTotals(day.totals, day.goals)}`
  );
}

/**
 * The whole menu as plain text, under `title` — the same shape `formatShoppingList` produces,
 * so the two exports read like one feature.
 */
export function formatMenu(title: string, days: readonly MenuDay[]): string {
  const body =
    days.length === 0
      ? 'Nic nie zaplanowano.'
      : days.map((day) => formatMenuDay(day)).join('\n\n');
  return `${title}\n\n${body}\n`;
}
