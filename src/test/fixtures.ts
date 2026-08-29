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
  source: 'usda'
};

export const egg: Ingredient = {
  id: 'usda:2',
  name: 'Jajko',
  aliases: [],
  state: 'raw',
  per100g: macros(200, 10, 2, 10),
  source: 'usda'
};

export const oil: Ingredient = {
  id: 'usda:3',
  name: 'Oliwa z oliwek',
  aliases: [],
  state: 'raw',
  per100g: macros(900, 0, 0, 100),
  source: 'usda'
};

export const ingredients: Ingredient[] = [chicken, egg, oil];

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
