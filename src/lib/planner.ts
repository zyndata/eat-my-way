import type { Day, Macros, MealPlanTemplate, MealSlot, PlannedMeal, Recipe } from './types';
import type { IdFactory } from './ids';
import type { RecipeUsage } from './recipes';
import type { IngredientLookup } from './macros';
import { newId } from './ids';
import {
  ZERO_MACROS,
  addMacros,
  dayTotals,
  isRecipeItemComplete,
  recipePortionMacros,
  scaleMacros,
  sumMacros
} from './macros';
import { dayGoals, weekDates } from './calendar';
import { daysBetween, weekdayIndex } from './dates';
import { formatPortions, pluralPl } from './text';

/**
 * The meal planner (PLAN.md Phase 13), whole and pure: no database, no network, no clock and
 * no id generation of its own. Everything variable is handed in — the candidate recipes with
 * their per-portion macros, the template, the day targets, the usage map, and the random
 * source. That is what makes the solver pinnable in a test, which is the only way a search
 * with restarts can be changed later by anyone.
 *
 * The three rules it obeys, in the order they win (PLAN.md; STATE.md decisions 258-259, 267):
 *
 *   1. Calories are the target. Protein, carbohydrate and fat are tie-breakers between plans
 *      that already fit on calories, weighted an order of magnitude lower.
 *   2. The week is the unit of accounting, the day is the unit of sanity: the weekly mean is
 *      the objective, and every day carries a hard band of +/-15% around its own goal.
 *   3. Freshness beats a perfect fit. Repetition is a cost that decays to nothing over a
 *      fortnight, and it is counted **per run**, not per meal — one pot eaten on Monday and
 *      Tuesday is one decision, not two.
 *
 * The search is a randomized greedy with restarts: a few hundred draws, each filling every
 * block with a candidate sampled with probability weighted by fit, then a coordinate pass
 * over the portion counts to close what is left. The cheapest complete draw wins. A few
 * hundred recipes cost single-digit milliseconds, which is the whole reason there is no LP
 * solver, no dependency and no worker here.
 */

// ---- injected randomness -----------------------------------------------------------------

/** Produces a number in [0, 1). Tests substitute a seeded generator, exactly as `IdFactory`. */
export type RandomSource = () => number;

// ---- the template ------------------------------------------------------------------------

/** A recipe carrying this tag is never proposed (STATE.md decision 261). */
export const NO_PLAN_TAG = 'nie-planuj';

/** Portion counts the solver may set. Outside this range it stops being a plate of food. */
export const PORTION_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** A cook lasts one, two or three days. Three is a food-safety ceiling (decision 273). */
export const MAX_BATCH_DAYS = 3;

/** The hard band every planned day must land inside, as a fraction of its own goal. */
export const DAY_BAND = 0.15;

/** How far the weekly balance may move a single day's target, as a fraction of the goal. */
export const BALANCE_CLAMP = 0.1;

/** Days over which the cost of repeating a recipe decays to nothing. */
export const REPEAT_WINDOW_DAYS = 14;

/**
 * The template a profile without one gets. Four slots at 25/40/10/25, lunch cooked for two
 * days (STATE.md decision 266) — and **no tags at all**: a row with no tags means "any
 * recipe", and shipping the tags PLAN.md's illustration uses would make the planner fail on
 * a library that has never heard of them.
 */
export const DEFAULT_MEAL_PLAN: MealPlanTemplate = {
  slots: [
    { id: 'sniadanie', label: 'Śniadanie', tagKeys: [], share: 0.25, batchDays: 1 },
    { id: 'obiad', label: 'Obiad', tagKeys: [], share: 0.4, batchDays: 2 },
    { id: 'podwieczorek', label: 'Podwieczorek', tagKeys: [], share: 0.1, batchDays: 1 },
    { id: 'kolacja', label: 'Kolacja', tagKeys: [], share: 0.25, batchDays: 1 }
  ]
};

/** A deep copy of the default, safe to hand to an editor that will mutate it. */
export function defaultMealPlan(): MealPlanTemplate {
  return { slots: DEFAULT_MEAL_PLAN.slots.map((slot) => ({ ...slot, tagKeys: [...slot.tagKeys] })) };
}

/** The template in force: the profile's own, or the built-in default. */
export function templateOf(template: MealPlanTemplate | undefined): MealPlanTemplate {
  return template === undefined || template.slots.length === 0 ? defaultMealPlan() : template;
}

/** 1, 2 or 3 — anything else is a value the editor should never have produced. */
export function clampBatchDays(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_BATCH_DAYS, Math.max(1, Math.round(value)));
}

/**
 * How long a cook started on `date` in `slot` lasts. The weekday says something or it does
 * not; when it does, it wins over the slot's own number (PLAN.md, decision 272). This is the
 * rule the user will predict the plan by, so it is one function with its own test.
 */
export function resolveRunLength(
  slot: MealSlot,
  date: string,
  template: MealPlanTemplate
): number {
  const override = template.cookDays?.[weekdayIndex(date)];
  return clampBatchDays(override ?? slot.batchDays);
}

/**
 * Shares as fractions of one, over exactly the slots handed in. Normalized rather than
 * validated: three rows of 30% mean a third each. Slots with no usable share fall back to an
 * even split, so a template nobody has touched still says something.
 */
export function normalizedShares(slots: readonly MealSlot[]): number[] {
  if (slots.length === 0) return [];
  const raw = slots.map((slot) =>
    Number.isFinite(slot.share) && slot.share > 0 ? slot.share : 0
  );
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return slots.map(() => 1 / slots.length);
  return raw.map((value) => value / total);
}

// ---- candidates --------------------------------------------------------------------------

/** A recipe the planner may choose, reduced to what the solver needs. */
export interface PlanCandidate {
  recipeId: string;
  name: string;
  /** Normalized tag keys, as `Recipe.tags` holds them. */
  tags: readonly string[];
  /** Per-portion macros, frozen here and used as the meal's `macroSnapshot`. */
  macros: Macros;
  /** Latest day it is planned on, from `recipeUsage` — including days planned ahead. */
  lastPlannedDate?: string;
}

/** Why recipes were left out of the search. Reported by the sheet rather than hidden. */
export interface SkippedRecipes {
  /** Tagged `nie-planuj`. */
  excluded: number;
  /** At least one item that cannot contribute macros (`isRecipeItemComplete`). */
  incomplete: number;
  /** Per-portion energy comes to nothing — the perfect filler for any gap, so never offered. */
  zeroKcal: number;
}

export const NO_SKIPPED: SkippedRecipes = Object.freeze({
  excluded: 0,
  incomplete: 0,
  zeroKcal: 0
});

export function skippedCount(skipped: SkippedRecipes): number {
  return skipped.excluded + skipped.incomplete + skipped.zeroKcal;
}

/**
 * The recipes the solver may draw from, and a tally of the ones it may not.
 *
 * The two exclusions beyond `nie-planuj` are the ones that would otherwise poison the search
 * (STATE.md decision 262): an incomplete item silently weighs nothing, and a recipe computing
 * to 0 kcal fits every gap perfectly and would be proposed constantly.
 */
export function planCandidates(
  recipes: readonly Recipe[],
  lookup: IngredientLookup,
  usage: ReadonlyMap<string, RecipeUsage> = new Map()
): { candidates: PlanCandidate[]; skipped: SkippedRecipes } {
  const candidates: PlanCandidate[] = [];
  const skipped: SkippedRecipes = { excluded: 0, incomplete: 0, zeroKcal: 0 };

  for (const recipe of recipes) {
    if (recipe.tags.includes(NO_PLAN_TAG)) {
      skipped.excluded += 1;
      continue;
    }
    if (recipe.items.length === 0 || !recipe.items.every(isRecipeItemComplete)) {
      skipped.incomplete += 1;
      continue;
    }
    const macros = recipePortionMacros(recipe, lookup);
    if (!(macros.kcal > 0)) {
      skipped.zeroKcal += 1;
      continue;
    }
    const last = usage.get(recipe.id)?.lastPlannedDate;
    candidates.push({
      recipeId: recipe.id,
      name: recipe.name,
      tags: recipe.tags,
      macros,
      ...(last === undefined ? {} : { lastPlannedDate: last })
    });
  }

  return { candidates, skipped };
}

/** Recipes qualifying for a slot: any of its tags, or every recipe when it names none. */
export function candidatesForSlot(
  candidates: readonly PlanCandidate[],
  slot: MealSlot
): PlanCandidate[] {
  if (slot.tagKeys.length === 0) return [...candidates];
  return candidates.filter((candidate) => slot.tagKeys.some((key) => candidate.tags.includes(key)));
}

// ---- the weekly balance ------------------------------------------------------------------

/** What the week already spent, and what that does to the target of a day inside it. */
export interface WeekBalance {
  /** kcal the week's already-planned days came in under budget. Negative means over. */
  surplus: number;
  /** Days the surplus is spread over: the ones being planned, plus the ones still empty. */
  spreadDays: number;
  /** kcal added to each planned day's goal, clamped to +/-10% of the daily goal. */
  correction: number;
  /** The raw correction was larger than the clamp allowed. */
  clamped: boolean;
  /** The sentence the sheet prints, or `''` when the week has nothing to say. */
  note: string;
}

export const NO_BALANCE: WeekBalance = Object.freeze({
  surplus: 0,
  spreadDays: 0,
  correction: 0,
  clamped: false,
  note: ''
});

function dayWord(count: number): string {
  return pluralPl(count, { one: 'dzień', few: 'dni', many: 'dni' });
}

/**
 * The correction the week's running balance puts on every day being planned.
 *
 * "The week is the unit of accounting" (rule 2) applies to a day planned on its own too: its
 * target is the daily goal corrected by what the *already-planned* days of the same week came
 * to against what they should have, spread over the days still unplanned — and clamped, so
 * one heavy Sunday cannot starve the following Tuesday. A day is judged against its own
 * `goalSnapshot` where it has one, so history is never rewritten (`dayGoals`).
 *
 * Planning a whole week hands in all seven dates, no day is "already planned", and the
 * correction is zero — which is right: the objective already is the weekly mean.
 */
export function weekBalance(
  dates: readonly string[],
  days: readonly Day[],
  profileGoals: Macros
): WeekBalance {
  const first = dates[0];
  if (first === undefined || !(profileGoals.kcal > 0)) return NO_BALANCE;

  const byDate = new Map(days.map((day) => [day.date, day]));
  const planning = new Set(dates);
  let surplus = 0;
  let spreadDays = 0;

  for (const date of weekDates(first)) {
    const day = byDate.get(date);
    // A day being planned right now is not evidence about the week; nor is an empty one.
    if (planning.has(date) || day === undefined || day.meals.length === 0) {
      spreadDays += 1;
      continue;
    }
    surplus += dayGoals(day, profileGoals).kcal - dayTotals(day).kcal;
  }

  if (spreadDays === 0 || Math.round(surplus) === 0) return NO_BALANCE;

  const raw = surplus / spreadDays;
  const limit = BALANCE_CLAMP * profileGoals.kcal;
  const correction = Math.max(-limit, Math.min(limit, raw));
  const clamped = Math.abs(raw) > limit + 0.5;

  const amount = Math.abs(Math.round(surplus));
  const shift = Math.round(correction);
  const head =
    surplus > 0
      ? `W tym tygodniu masz zapas ${amount} kcal`
      : `W tym tygodniu masz ${amount} kcal ponad plan`;
  const tail = `rozłożony na ${spreadDays} ${dayWord(spreadDays)} daje ${shift > 0 ? '+' : ''}${shift} kcal do celu tego dnia`;
  const note = `${head} — ${tail}${clamped ? ' (więcej nie przesuwamy, limit to ±10% celu dnia).' : '.'}`;

  return { surplus, spreadDays, correction, clamped, note };
}

/** The day goal after the weekly correction. The macro split is kept, so ties still mean something. */
export function correctedGoals(goals: Macros, correction: number): Macros {
  if (!(goals.kcal > 0) || correction === 0) return { ...goals };
  const factor = Math.max(0, (goals.kcal + correction) / goals.kcal);
  return scaleMacros(goals, factor);
}

// ---- the request ------------------------------------------------------------------------

/** One day of the range, as the solver receives it. */
export interface PlanDayInput {
  date: string;
  /** The day's own goal — the `goalSnapshot` where it has one. The band is measured on this. */
  goals: Macros;
  /** The same, after the weekly correction. What the plan actually aims at. */
  target: Macros;
  /** Macros of the meals already on the day. Fixed input, never touched. */
  existing: Macros;
  /** Slot ids already taken by those meals, mapped by position in the sheet. */
  takenSlotIds: readonly string[];
  /** Recipes already on this day — a proposal never repeats one of them. */
  existingRecipeIds: readonly string[];
}

/** One cook: a recipe and a portion count shared by consecutive days of one slot. */
export interface PlanRun {
  /** `slotId@firstDate` — stable across rerolls, which is what a lock holds on to. */
  id: string;
  slotId: string;
  /** Consecutive dates this pot covers. The first is the day it is cooked. */
  dates: string[];
  recipeId: string;
  recipeName: string;
  portionsEaten: number;
  /** Per-portion macros, frozen exactly as `macroSnapshot` is. */
  macroSnapshot: Macros;
  /** `dates.length × portionsEaten` — what goes in the pot (STATE.md decision 268). */
  cookingScale: number;
}

/** What one day of the proposal comes to. */
export interface PlanDay {
  date: string;
  goals: Macros;
  target: Macros;
  existing: Macros;
  /** Macros of the proposed meals alone. */
  planned: Macros;
  /** `existing + planned` — what the day would actually be. */
  totals: Macros;
  /** Slots that could not be filled at all. */
  unfilledSlotIds: string[];
  /** The day sits outside its own +/-15% band. */
  outOfBand: boolean;
}

export interface PlanProposal {
  dates: string[];
  runs: PlanRun[];
  days: PlanDay[];
  /** Slots whose run had to be shortened because no full-length cook could be placed. */
  shortenedSlotIds: string[];
}

/**
 * Why no plan could be produced. Three cases, because a dead end reading only „nie da się" is
 * the worst thing this feature could do (STATE.md decision 262).
 */
export type PlanFailure =
  /** Nothing usable in the library at all. */
  | { kind: 'no-candidates'; usable: number }
  /** One slot's tags name nothing. */
  | { kind: 'slot-tags'; slotLabel: string; tagKeys: readonly string[] }
  /** A plan exists but misses the band. It comes back anyway, with its difference. */
  | {
      kind: 'tolerance';
      proposal: PlanProposal;
      worst: PlanDay;
      diff: Macros;
      /** Enough days are locked inside long cooks that the band cannot be met. */
      tooManyBatchDays: boolean;
    };

export type PlanResult =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; failure: PlanFailure };

export interface PlanRequest {
  days: readonly PlanDayInput[];
  template: MealPlanTemplate;
  candidates: readonly PlanCandidate[];
  /** Runs the user locked. Kept verbatim, and the search fills around them. */
  locked?: readonly PlanRun[];
  /** The sheet's 1/2/3 control, keyed by run id. One-off; never written to the template. */
  runLengths?: Readonly<Record<string, number>>;
  random: RandomSource;
  /** Draws per solve. Lower only in a test that wants the search to be cheap. */
  restarts?: number;
}

export const DEFAULT_RESTARTS = 240;

// ---- the block structure -----------------------------------------------------------------

/**
 * One cook-shaped hole in the plan: a slot and the consecutive days one pot would cover.
 * Runs are placed **first** and the single days fill in around them, because a run is one
 * move and its days share a recipe and a portion count.
 */
export interface PlanBlock {
  id: string;
  slotIndex: number;
  slotId: string;
  dates: string[];
  /** A lock the search must not touch. */
  locked?: PlanRun;
}

/** `slotId@firstDate` — the identity a lock and the 1/2/3 control hold on to. */
export function runId(slotId: string, firstDate: string): string {
  return `${slotId}@${firstDate}`;
}

/**
 * Lay the range out as blocks.
 *
 * Walked per slot, left to right: a day whose slot is already taken by an existing meal is
 * skipped, otherwise a run starts there and covers `resolveRunLength` days — shortened by the
 * end of the range, by the next taken day, and by the stagger rule.
 *
 * **Stagger** (STATE.md decision 275): two runs longer than a day may not start on the same
 * date while any arrangement exists in which they do not. It is settled here, in the
 * structure, rather than in the cost function: the structure is chosen before the recipes
 * are, so a cost term over it would mean searching structures too. The later slot's block
 * drops to a single day and its next run is resolved from the following date — which is the
 * shortening the rule asks for, not a refusal to cook.
 */
export function planBlocks(
  request: Pick<PlanRequest, 'days' | 'template' | 'locked' | 'runLengths'>
): PlanBlock[] {
  const { days, template } = request;
  const slots = template.slots;
  const dates = days.map((day) => day.date);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const lockedById = new Map((request.locked ?? []).map((run) => [run.id, run]));

  /** Dates on which a run longer than one day already starts, in any slot. */
  const longStarts = new Set<string>();
  const blocks: PlanBlock[] = [];

  for (const [slotIndex, slot] of slots.entries()) {
    let index = 0;
    while (index < dates.length) {
      const date = dates[index] as string;
      if (byDate.get(date)?.takenSlotIds.includes(slot.id) === true) {
        index += 1;
        continue;
      }

      const id = runId(slot.id, date);
      const locked = lockedById.get(id);
      const wanted =
        locked !== undefined
          ? locked.dates.length
          : (request.runLengths?.[id] ?? resolveRunLength(slot, date, template));

      // A run never overruns the end of the range, and never swallows a day whose slot is
      // already spoken for.
      let length = Math.max(1, Math.min(clampBatchDays(wanted), dates.length - index));
      for (let step = 1; step < length; step += 1) {
        const next = dates[index + step] as string;
        if (byDate.get(next)?.takenSlotIds.includes(slot.id) === true) {
          length = step;
          break;
        }
      }

      // A locked run keeps its days whatever the stagger would prefer.
      if (locked === undefined && length > 1 && longStarts.has(date)) length = 1;
      if (length > 1) longStarts.add(date);

      const block: PlanBlock = {
        id,
        slotIndex,
        slotId: slot.id,
        dates: dates.slice(index, index + length),
        ...(locked === undefined ? {} : { locked })
      };
      blocks.push(block);
      index += length;
    }
  }

  // Reading order — day first, then the template's own slot order — so the greedy fills a
  // day's slots together and the gap it is closing is the gap the user would see.
  return blocks.sort(
    (a, b) => (a.dates[0] as string).localeCompare(b.dates[0] as string) || a.slotIndex - b.slotIndex
  );
}

// ---- cost --------------------------------------------------------------------------------

/**
 * Weights, in PLAN.md's order. Every term is expressed as a *fraction of the goal it is
 * measured against*, so the numbers below really are comparable: kcal dominates, the three
 * macros sit an order of magnitude under it, and the soft rules under those.
 */
const W_WEEK_KCAL = 100;
const W_DAY_KCAL = 30;
const W_BAND = 1000;
const W_PROTEIN = 6;
const W_CARBS = 2;
const W_FAT = 2;
const W_REPEAT = 8;
const W_PORTION = 2;
const W_SHARE = 3;

function relative(value: number, against: number): number {
  return against > 0 ? Math.abs(value) / against : 0;
}

/**
 * The cost of repeating a recipe cooked `gap` days before this one: very expensive yesterday,
 * nearly free after a fortnight, free when it was never planned at all.
 */
export function repeatCost(lastPlannedDate: string | undefined, cookDate: string): number {
  if (lastPlannedDate === undefined) return 0;
  const gap = Math.abs(daysBetween(lastPlannedDate, cookDate));
  if (gap >= REPEAT_WINDOW_DAYS) return 0;
  return (REPEAT_WINDOW_DAYS - gap) / REPEAT_WINDOW_DAYS;
}

/** True when the day sits outside the hard +/-15% band around its own goal. */
export function outOfBand(totals: Macros, goals: Macros): boolean {
  if (!(goals.kcal > 0)) return false;
  return Math.abs(totals.kcal - goals.kcal) > DAY_BAND * goals.kcal;
}

// ---- the search --------------------------------------------------------------------------

/** One block's answer during a draw, with everything constant about it precomputed. */
interface Fill {
  block: PlanBlock;
  candidate: PlanCandidate;
  portions: number;
  /** Positions of `block.dates` in the range, so the totals can be arrays. */
  dayIndexes: number[];
  /** kcal this block's slot is entitled to on its cooking day — the share term's target. */
  share: number;
  /** The cooking day's corrected kcal goal, which the share term is relative to. */
  dayGoal: number;
}

/** Running totals for the range, one entry per day. */
interface Totals {
  kcal: Float64Array;
  protein: Float64Array;
  carbs: Float64Array;
  fat: Float64Array;
}

function weightedPick<T>(items: readonly T[], weights: readonly number[], random: RandomSource): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return items[Math.floor(random() * items.length)] ?? (items[0] as T);
  let roll = random() * total;
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll <= 0) return items[index] as T;
  }
  return items[items.length - 1] as T;
}

/** The portion step whose energy comes closest to `target`, with 1.0 preferred on a tie. */
function bestPortions(kcalPerPortion: number, target: number): number {
  let best = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const step of PORTION_STEPS) {
    const cost = Math.abs(kcalPerPortion * step - target) + W_PORTION * Math.abs(step - 1) * 10;
    if (cost < bestCost) {
      bestCost = cost;
      best = step;
    }
  }
  return best;
}

class Solver {
  /** The structure being filled. Set by `solve`, read by `cost`. */
  private blocks: PlanBlock[] = [];
  private readonly days: readonly PlanDayInput[];
  private readonly byDate: Map<string, PlanDayInput>;
  private readonly dayIndex: Map<string, number>;
  private readonly slots: readonly MealSlot[];
  /** date -> slot id -> that slot's share of what the day still has to be filled with. */
  private readonly shares: Map<string, Map<string, number>>;
  private readonly pools: Map<string, PlanCandidate[]>;
  private readonly random: RandomSource;

  constructor(private readonly request: PlanRequest) {
    this.days = request.days;
    this.byDate = new Map(request.days.map((day) => [day.date, day]));
    this.dayIndex = new Map(request.days.map((day, index) => [day.date, index]));
    this.slots = request.template.slots;
    this.random = request.random;
    // Renormalized per day over the slots that day still has free, once rather than per
    // candidate: the cost function asks for this on every draw of every restart.
    this.shares = new Map(
      request.days.map((day) => {
        const free = this.slots.filter((slot) => !day.takenSlotIds.includes(slot.id));
        const shares = normalizedShares(free);
        return [day.date, new Map(free.map((slot, index) => [slot.id, shares[index] as number]))];
      })
    );
    this.pools = new Map(
      this.slots.map((slot) => [slot.id, candidatesForSlot(request.candidates, slot)])
    );
  }

  poolFor(slotId: string): PlanCandidate[] {
    return this.pools.get(slotId) ?? [];
  }

  /** kcal this block should aim to supply per day: its share of what the day still needs. */
  private blockTarget(block: PlanBlock): number {
    let total = 0;
    for (const date of block.dates) {
      const day = this.byDate.get(date);
      if (day === undefined) continue;
      const remaining = Math.max(0, day.target.kcal - day.existing.kcal);
      total += remaining * this.shareOf(block.slotId, day);
    }
    return block.dates.length > 0 ? total / block.dates.length : 0;
  }

  /** The slot's share, renormalized over the slots this day still has free. */
  private shareOf(slotId: string, day: PlanDayInput): number {
    return this.shares.get(day.date)?.get(slotId) ?? 0;
  }

  /** The constant half of a fill: where its days are, and what its slot is entitled to. */
  private frame(block: PlanBlock): Pick<Fill, 'dayIndexes' | 'share' | 'dayGoal'> {
    const cookDay = this.byDate.get(block.dates[0] as string);
    return {
      dayIndexes: block.dates.map((date) => this.dayIndex.get(date) ?? 0),
      share:
        cookDay === undefined
          ? 0
          : this.shareOf(block.slotId, cookDay) * Math.max(0, cookDay.target.kcal - cookDay.existing.kcal),
      dayGoal: cookDay?.target.kcal ?? 0
    };
  }

  /** One randomized greedy draw over every block. */
  private draw(blocks: readonly PlanBlock[]): Fill[] {
    /** Recipes already used per date, so nothing repeats inside a day. */
    const usedPerDate = new Map<string, Set<string>>();
    for (const day of this.days) usedPerDate.set(day.date, new Set(day.existingRecipeIds));

    const fills: Fill[] = [];

    for (const block of blocks) {
      if (block.locked !== undefined) {
        const locked = block.locked;
        for (const date of block.dates) usedPerDate.get(date)?.add(locked.recipeId);
        fills.push({
          block,
          candidate: {
            recipeId: locked.recipeId,
            name: locked.recipeName,
            tags: [],
            macros: locked.macroSnapshot
          },
          portions: locked.portionsEaten,
          ...this.frame(block)
        });
        continue;
      }

      const target = this.blockTarget(block);
      const pool = this.poolFor(block.slotId).filter((candidate) =>
        block.dates.every((date) => usedPerDate.get(date)?.has(candidate.recipeId) !== true)
      );
      if (pool.length === 0) continue;

      const cookDate = block.dates[0] as string;
      const weights = pool.map((candidate) => {
        const portions = bestPortions(candidate.macros.kcal, target);
        const error = relative(candidate.macros.kcal * portions - target, Math.max(target, 1));
        const fresh = 1 - 0.9 * repeatCost(candidate.lastPlannedDate, cookDate);
        return Math.max(1e-6, fresh / (1 + 4 * error * error));
      });

      const candidate = weightedPick(pool, weights, this.random);
      for (const date of block.dates) usedPerDate.get(date)?.add(candidate.recipeId);
      fills.push({
        block,
        candidate,
        portions: bestPortions(candidate.macros.kcal, target),
        ...this.frame(block)
      });
    }

    return fills;
  }

  /**
   * Running totals per day, as four parallel arrays indexed the way `days` is.
   *
   * Arrays rather than a `Map<string, Macros>` because the refine pass below rewrites these
   * a few hundred thousand times per solve, and allocating a fresh object per candidate step
   * is what would push the search off the "single-digit milliseconds, so no worker" claim.
   */
  private buildTotals(fills: readonly Fill[]): Totals {
    const size = this.days.length;
    const totals: Totals = {
      kcal: new Float64Array(size),
      protein: new Float64Array(size),
      carbs: new Float64Array(size),
      fat: new Float64Array(size)
    };
    for (const [index, day] of this.days.entries()) {
      totals.kcal[index] = day.existing.kcal;
      totals.protein[index] = day.existing.protein;
      totals.carbs[index] = day.existing.carbs;
      totals.fat[index] = day.existing.fat;
    }
    for (const fill of fills) this.apply(totals, fill, fill.portions, 1);
    return totals;
  }

  /** Add (`sign` 1) or take back (`sign` -1) one fill's contribution at `portions`. */
  private apply(totals: Totals, fill: Fill, portions: number, sign: number): void {
    const macros = fill.candidate.macros;
    const factor = sign * portions;
    const { kcal, protein, carbs, fat } = totals;
    for (const index of fill.dayIndexes) {
      kcal[index] = (kcal[index] ?? 0) + macros.kcal * factor;
      protein[index] = (protein[index] ?? 0) + macros.protein * factor;
      carbs[index] = (carbs[index] ?? 0) + macros.carbs * factor;
      fat[index] = (fat[index] ?? 0) + macros.fat * factor;
    }
  }

  /** Everything the cost says about the days themselves: the band, the week, the macros. */
  private dayCost(totals: Totals): number {
    let cost = 0;
    let plannedKcal = 0;
    let goalKcal = 0;

    for (const [index, day] of this.days.entries()) {
      const kcal = totals.kcal[index] as number;
      plannedKcal += kcal;
      goalKcal += day.target.kcal;

      cost += W_DAY_KCAL * relative(kcal - day.target.kcal, day.target.kcal);
      cost += W_PROTEIN * relative((totals.protein[index] as number) - day.target.protein, day.target.protein);
      cost += W_CARBS * relative((totals.carbs[index] as number) - day.target.carbs, day.target.carbs);
      cost += W_FAT * relative((totals.fat[index] as number) - day.target.fat, day.target.fat);
      if (day.goals.kcal > 0 && Math.abs(kcal - day.goals.kcal) > DAY_BAND * day.goals.kcal) {
        cost += W_BAND;
      }
    }

    // The weekly mean is the objective (rule 2); the per-day term above is what keeps it sane.
    return cost + W_WEEK_KCAL * relative(plannedKcal - goalKcal, goalKcal) * this.days.length;
  }

  /** Everything the cost says about one choice: how fresh it is, and how odd its portion is. */
  private fillCost(fill: Fill, portions: number): number {
    if (fill.block.locked !== undefined) return 0;
    // Dated on the cooking day and counted once: a run is one decision (decision 267), so its
    // own later days never make it look stale to itself.
    let cost = W_REPEAT * repeatCost(fill.candidate.lastPlannedDate, fill.block.dates[0] as string);
    cost += W_PORTION * Math.abs(portions - 1);
    cost += W_SHARE * relative(fill.candidate.macros.kcal * portions - fill.share, fill.dayGoal);
    return cost;
  }

  /**
   * The repair pass: re-choose each portion count against everything else already decided.
   * Two sweeps are enough — the third almost never moves a step, and the restarts are where
   * the real search happens.
   */
  private refine(fills: Fill[], totals: Totals): void {
    for (let sweep = 0; sweep < 2; sweep += 1) {
      for (const fill of fills) {
        if (fill.block.locked !== undefined) continue;
        this.apply(totals, fill, fill.portions, -1);

        let best = fill.portions;
        let bestCost = Number.POSITIVE_INFINITY;
        for (const step of PORTION_STEPS) {
          this.apply(totals, fill, step, 1);
          const cost = this.dayCost(totals) + this.fillCost(fill, step);
          this.apply(totals, fill, step, -1);
          if (cost < bestCost) {
            bestCost = cost;
            best = step;
          }
        }

        fill.portions = best;
        this.apply(totals, fill, best, 1);
      }
    }
  }

  /** What a whole draw costs. Lower is better; the cheapest complete draw wins. */
  private cost(fills: readonly Fill[], totals: Totals): number {
    let cost = this.dayCost(totals);
    for (const fill of fills) cost += this.fillCost(fill, fill.portions);

    // A slot the draw could not fill at all is worse than any arrangement that did.
    cost += W_BAND * (this.blocks.length - fills.length);
    return cost;
  }

  solve(): { fills: Fill[]; blocks: PlanBlock[] } | undefined {
    this.blocks = planBlocks(this.request);
    const restarts = this.request.restarts ?? DEFAULT_RESTARTS;

    let best: Fill[] | undefined;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let attempt = 0; attempt < restarts; attempt += 1) {
      const fills = this.draw(this.blocks);
      const totals = this.buildTotals(fills);
      this.refine(fills, totals);
      const cost = this.cost(fills, totals);
      if (cost < bestCost) {
        bestCost = cost;
        best = fills;
      }
    }

    return best === undefined ? undefined : { fills: best, blocks: this.blocks };
  }
}

// ---- assembling the proposal -------------------------------------------------------------

function toRun(fill: Fill): PlanRun {
  if (fill.block.locked !== undefined) {
    return { ...fill.block.locked, dates: [...fill.block.locked.dates] };
  }
  const dates = [...fill.block.dates];
  return {
    id: fill.block.id,
    slotId: fill.block.slotId,
    dates,
    recipeId: fill.candidate.recipeId,
    recipeName: fill.candidate.name,
    portionsEaten: fill.portions,
    macroSnapshot: fill.candidate.macros,
    // The invariant that only shows up as a shopping list which under-buys (decision 268).
    cookingScale: dates.length * fill.portions
  };
}

function assemble(
  request: PlanRequest,
  fills: readonly Fill[],
  blocks: readonly PlanBlock[]
): PlanProposal {
  const runs = fills.map(toRun);
  const filled = new Set(fills.map((fill) => fill.block.id));
  const shortened = new Set<string>();

  for (const block of blocks) {
    if (!filled.has(block.id)) shortened.add(block.slotId);
  }
  // A block that had to be cut short of what its slot or its weekday asked for — because it
  // would have overrun the end of the range, met a day already spoken for, or collided with
  // another slot's cook (PLAN.md: „it shortens, and the sheet says which slot that happened to").
  for (const block of blocks) {
    const slot = request.template.slots.find((row) => row.id === block.slotId);
    if (slot === undefined || block.locked !== undefined) continue;
    const wanted =
      request.runLengths?.[block.id] ?? resolveRunLength(slot, block.dates[0] as string, request.template);
    if (block.dates.length < wanted) shortened.add(block.slotId);
  }

  const byDate = new Map<string, PlanRun[]>();
  for (const run of runs) {
    for (const date of run.dates) {
      const list = byDate.get(date) ?? [];
      list.push(run);
      byDate.set(date, list);
    }
  }

  const days: PlanDay[] = request.days.map((day) => {
    const planned = sumMacros(
      (byDate.get(day.date) ?? []).map((run) => scaleMacros(run.macroSnapshot, run.portionsEaten))
    );
    const totals = addMacros(day.existing, planned);
    const covered = new Set([...day.takenSlotIds, ...(byDate.get(day.date) ?? []).map((run) => run.slotId)]);
    return {
      date: day.date,
      goals: day.goals,
      target: day.target,
      existing: day.existing,
      planned,
      totals,
      unfilledSlotIds: request.template.slots
        .map((slot) => slot.id)
        .filter((id) => !covered.has(id)),
      outOfBand: outOfBand(totals, day.goals)
    };
  });

  return { dates: request.days.map((day) => day.date), runs, days, shortenedSlotIds: [...shortened] };
}

/**
 * How many of the range's slot-days have their macros fixed by a cook started on an earlier
 * day. Past half, a week has too few knobs left for the per-day band, and that is the one
 * failure whose cause a user cannot guess from a plan that simply missed (decision 275).
 */
export function batchedShare(proposal: PlanProposal, template: MealPlanTemplate): number {
  const slotDays = proposal.days.length * template.slots.length;
  if (slotDays === 0) return 0;
  const fixed = proposal.runs.reduce((sum, run) => sum + Math.max(0, run.dates.length - 1), 0);
  return fixed / slotDays;
}

/** How far the day landed from its target, per macro. Positive means over. */
export function dayDiff(day: PlanDay): Macros {
  return {
    kcal: day.totals.kcal - day.target.kcal,
    protein: day.totals.protein - day.target.protein,
    carbs: day.totals.carbs - day.target.carbs,
    fat: day.totals.fat - day.target.fat
  };
}

/**
 * Solve. Returns a proposal, or a typed failure — and in the one case where a plan exists but
 * misses the band, the failure carries the best plan found so the sheet can offer it anyway.
 */
export function planRange(request: PlanRequest): PlanResult {
  const template = request.template;

  if (request.candidates.length === 0) {
    return { ok: false, failure: { kind: 'no-candidates', usable: 0 } };
  }

  for (const slot of template.slots) {
    if (candidatesForSlot(request.candidates, slot).length === 0) {
      return { ok: false, failure: { kind: 'slot-tags', slotLabel: slot.label, tagKeys: slot.tagKeys } };
    }
  }

  const solver = new Solver(request);
  const solved = solver.solve();
  if (solved === undefined) {
    return { ok: false, failure: { kind: 'no-candidates', usable: request.candidates.length } };
  }

  const proposal = assemble(request, solved.fills, solved.blocks);

  // A day the search left completely empty is not a plan that missed — it is a library with
  // nothing left to offer once a day may not repeat a recipe. That is its own sentence.
  if (proposal.days.some((day) => day.planned.kcal === 0 && day.existing.kcal === 0)) {
    return { ok: false, failure: { kind: 'no-candidates', usable: request.candidates.length } };
  }

  const missed = proposal.days.filter((day) => day.outOfBand);
  if (missed.length === 0) return { ok: true, proposal };

  const worst = missed.reduce((a, b) =>
    Math.abs(dayDiff(a).kcal) >= Math.abs(dayDiff(b).kcal) ? a : b
  );

  return {
    ok: false,
    failure: {
      kind: 'tolerance',
      proposal,
      worst,
      diff: dayDiff(worst),
      tooManyBatchDays: batchedShare(proposal, template) >= 0.5
    }
  };
}

// ---- writing the plan --------------------------------------------------------------------

/**
 * The days a week apply actually touches, after the user unticked some.
 *
 * Unticking a day a run covers **shortens the run** rather than dropping it: the cooking day
 * falls back to what the remaining days will really eat, because a pot cooked for three days
 * with two of them eaten is a shopping list that over-buys. Unticking the cooking day itself
 * moves the cook to the earliest day that survived.
 */
export function runsForDates(runs: readonly PlanRun[], dates: readonly string[]): PlanRun[] {
  const kept = new Set(dates);
  const result: PlanRun[] = [];

  for (const run of runs) {
    const days = run.dates.filter((date) => kept.has(date));
    if (days.length === 0) continue;
    result.push({
      ...run,
      id: runId(run.slotId, days[0] as string),
      dates: days,
      cookingScale: days.length * run.portionsEaten
    });
  }

  return result;
}

/** One day's worth of meals to write, in the order the slots are listed. */
export interface PlanWrite {
  date: string;
  meals: PlannedMeal[];
}

/**
 * Turn runs into planned meals, exactly as „Gotuję na 2 dni" writes them (decision 265): the
 * cooking day carries `cookingScale = runLength × portionsEaten`, and every later day of the
 * run carries a `cookingScale: 1` copy of the same frozen snapshot. What the planner writes is
 * indistinguishable from what the checkbox writes — deliberately, so the meal screen, the
 * shopping list and the sync path all behave as they already do.
 */
export function planWrites(
  runs: readonly PlanRun[],
  dates: readonly string[],
  nextId: IdFactory = newId
): PlanWrite[] {
  const byDate = new Map<string, PlannedMeal[]>(dates.map((date) => [date, []]));

  for (const date of dates) {
    for (const run of runs) {
      const index = run.dates.indexOf(date);
      if (index < 0) continue;
      byDate.get(date)?.push({
        id: nextId(),
        recipeId: run.recipeId,
        cookingScale: index === 0 ? run.cookingScale : 1,
        portionsEaten: run.portionsEaten,
        macroSnapshot: { ...run.macroSnapshot }
      });
    }
  }

  return dates
    .map((date) => ({ date, meals: byDate.get(date) ?? [] }))
    .filter((write) => write.meals.length > 0);
}

// ---- Polish copy -------------------------------------------------------------------------

/** „Gotujesz na 3 dni" / „" — what a run's cooking day says about itself. */
export function cookingLabel(runLength: number): string {
  return runLength <= 1 ? '' : `Gotujesz na ${runLength} ${dayWord(runLength)}`;
}

/** „1,25 porcji · 620 kcal" — the line under a proposed meal. */
export function portionLabel(run: PlanRun): string {
  return `${formatPortions(run.portionsEaten)} · ${Math.round(run.macroSnapshot.kcal * run.portionsEaten)} kcal`;
}

/** „pominięto 3 przepisy" — why the search saw fewer recipes than the library holds. */
export function skippedLabel(skipped: SkippedRecipes): string {
  const total = skippedCount(skipped);
  if (total === 0) return '';
  const parts: string[] = [];
  if (skipped.excluded > 0) parts.push(`${skipped.excluded} z tagiem „${NO_PLAN_TAG}"`);
  if (skipped.incomplete > 0) parts.push(`${skipped.incomplete} z niekompletnymi składnikami`);
  if (skipped.zeroKcal > 0) parts.push(`${skipped.zeroKcal} bez wartości odżywczych`);
  const word = pluralPl(total, { one: 'przepis', few: 'przepisy', many: 'przepisów' });
  return `Pominięto ${total} ${word}: ${parts.join(', ')}.`;
}

function signed(value: number, unit: string): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)} ${unit}`;
}

/** „+230 kcal, −18 g białka" — how far the best plan found landed from the goal. */
export function diffLabel(diff: Macros): string {
  return [
    signed(diff.kcal, 'kcal'),
    signed(diff.protein, 'g białka'),
    signed(diff.carbs, 'g węglowodanów'),
    signed(diff.fat, 'g tłuszczu')
  ].join(', ');
}

/** What the sheet says when no plan fits: a title, the reason, and a way out. */
export interface FailureMessage {
  title: string;
  detail: string;
  hint: string;
}

export function failureMessage(failure: PlanFailure): FailureMessage {
  switch (failure.kind) {
    case 'no-candidates':
      return {
        title: 'Za mało przepisów',
        detail:
          failure.usable === 0
            ? 'Nie ma ani jednego przepisu, z którego dałoby się ułożyć posiłek.'
            : `Da się użyć tylko ${failure.usable} ${pluralPl(failure.usable, { one: 'przepisu', few: 'przepisów', many: 'przepisów' })}.`,
        hint: 'Dodaj przepisy albo uzupełnij składniki w tych, które już masz.'
      };
    case 'slot-tags':
      return {
        title: `Brak przepisów na „${failure.slotLabel}"`,
        detail:
          failure.tagKeys.length === 0
            ? 'Żaden przepis nie pasuje do tego posiłku.'
            : `Żaden przepis nie ma ${failure.tagKeys.length === 1 ? 'tagu' : 'żadnego z tagów'}: ${failure.tagKeys.map((key) => `„${key}"`).join(', ')}.`,
        hint: 'Poluzuj tagi tego wiersza w ustawieniach planera albo otaguj kilka przepisów.'
      };
    case 'tolerance':
      return {
        title: 'Nie mieścimy się w celach',
        detail: failure.tooManyBatchDays
          ? `Zbyt wiele dni gotowanych na zapas — te dni mają ustalone makro i plan nie ma już czym nadrobić. Najbliżej: ${diffLabel(failure.diff)}.`
          : `Najbliżej: ${diffLabel(failure.diff)}.`,
        hint: failure.tooManyBatchDays
          ? 'Skróć któreś gotowanie na zapas do 1 dnia albo zaplanuj mniej dni naraz.'
          : 'Możesz przyjąć ten plan mimo różnicy, poluzować tagi albo ugotować obiad na 3 dni — przy małej bibliotece to pomaga najbardziej.'
      };
  }
}

// ---- putting a request together ----------------------------------------------------------

/**
 * Build the per-day input for a range. This is where the weekly correction, the frozen
 * `goalSnapshot` and the existing meals meet — and where „Zaplanuj dzień" and „Uzupełnij
 * dzień" turn out to be the same code (PLAN.md task 4): a day with meals simply arrives with
 * `existing` and `takenSlotIds` filled in.
 *
 * Existing meals are mapped to slots **by position** (decision 261): `PlannedMeal` learns
 * nothing about slots, and the mapping lives and dies inside the sheet. `slotOverrides` is
 * the user having moved one before generating.
 */
export function planDayInputs(
  dates: readonly string[],
  days: readonly Day[],
  profileGoals: Macros,
  template: MealPlanTemplate,
  balance: WeekBalance,
  slotOverrides: Readonly<Record<string, string>> = {}
): PlanDayInput[] {
  const byDate = new Map(days.map((day) => [day.date, day]));

  return dates.map((date) => {
    const day = byDate.get(date);
    const goals = dayGoals(day, profileGoals);
    const meals = day?.meals ?? [];
    const taken: string[] = [];

    for (const [index, meal] of meals.entries()) {
      const override = slotOverrides[meal.id];
      const slotId = override ?? template.slots[index]?.id;
      if (slotId !== undefined && !taken.includes(slotId)) taken.push(slotId);
    }

    return {
      date,
      goals,
      target: correctedGoals(goals, balance.correction),
      existing: day === undefined ? ZERO_MACROS : dayTotals(day),
      takenSlotIds: taken,
      existingRecipeIds: meals.map((meal) => meal.recipeId)
    };
  });
}

/** The dates a „Zaplanuj tydzień" covers: the whole Monday-to-Sunday week around `date`. */
export function plannerWeek(date: string): string[] {
  return weekDates(date);
}

/** The range a day plan covers — one date, spelled as a range so both paths are one code path. */
export function plannerDay(date: string): string[] {
  return [date];
}
