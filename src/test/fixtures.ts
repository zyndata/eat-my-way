import type { Ingredient, Macros, Recipe, RecipeItem } from '../lib/types';
import type { IdFactory } from '../lib/ids';
import { EatMyWayDb } from '../lib/db';

/** Shared test data. Kept out of `*.test.ts` so Vitest does not collect it as a suite. */

export function macros(kcal: number, protein: number, carbs: number, fat: number): Macros {
  return { kcal, protein, carbs, fat };
}

/** 100 g of chicken breast. Round numbers so expected values stay readable. */
export const chicken: Ingredient = {
  id: 'usda:1',
  name: 'Pierś z kurczaka',
  aliases: ['kurczak', 'filet z kurczaka'],
  state: 'raw',
  per100g: macros(100, 20, 0, 2),
  source: 'usda',
  department: 'mieso'
};

export const egg: Ingredient = {
  id: 'usda:2',
  name: 'Jajko',
  aliases: [],
  state: 'raw',
  per100g: macros(200, 10, 2, 10),
  source: 'usda',
  department: 'nabial'
};

/**
 * Deliberately carries **no** department: the „Inne" fallback is a rule the app lives with on
 * every row nobody has filed (Phase 17), so one fixture has to exercise it.
 */
export const oil: Ingredient = {
  id: 'usda:3',
  name: 'Oliwa z oliwek',
  aliases: [],
  state: 'raw',
  per100g: macros(900, 0, 0, 100),
  source: 'usda'
};

/** The Phase 16 fixture: an ingredient that offers household measures. */
export const garlic: Ingredient = {
  id: 'usda:4',
  name: 'Czosnek',
  aliases: [],
  state: 'raw',
  per100g: macros(149, 6, 33, 0.5),
  source: 'usda',
  department: 'warzywa',
  measures: [
    { name: 'ząbek', grams: 5 },
    { name: 'szt.', grams: 45 }
  ]
};

export const ingredients: Ingredient[] = [chicken, egg, oil, garlic];

export function item(
  ingredientId: string,
  amount: number,
  unit: RecipeItem['unit'] = 'g',
  extra: Omit<RecipeItem, 'ingredientId' | 'amount' | 'unit'> = {}
): RecipeItem {
  return { ingredientId, amount, unit, ...extra };
}

export function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    name: 'Kurczak z jajkiem',
    instructions: 'Usmaż.',
    items: [item(chicken.id, 200), item(egg.id, 1, 'szt', { gramsPerUnit: 50 })],
    tags: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides
  };
}

/** Deterministic ids: `prefix-1`, `prefix-2`, ... so copies can be asserted exactly. */
export function seqIds(prefix = 'id'): IdFactory {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A database nobody else touches, for one test. Delete it when the test is done. */
export function freshDb(): EatMyWayDb {
  return new EatMyWayDb(`test-${crypto.randomUUID()}`);
}

/**
 * `rows[index]`, minus the `| undefined` that `noUncheckedIndexedAccess` adds. A missing row
 * is a failing test, so it throws rather than making every assertion write `!`.
 */
export function at<T>(rows: readonly T[], index = 0): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`No row at index ${index} (length ${rows.length})`);
  return row;
}
