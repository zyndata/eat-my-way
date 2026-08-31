import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EatMyWayDb } from '../db';
import { createRepository, type Repository } from '../repository';
import { freshDb } from '../../test/fixtures';
import { importBundledNutrition } from './import';
import type { NutritionBundle } from './bundle';
import { NUTRITION_DATA_VERSION } from './meta';

function bundle(overrides: Partial<NutritionBundle> = {}): NutritionBundle {
  return {
    dataVersion: NUTRITION_DATA_VERSION,
    sources: ['test'],
    attribution: 'test',
    ingredients: [
      {
        id: 'usda:1',
        name: 'Ser żółty gouda',
        aliases: ['gouda', 'ser zolty'],
        state: 'raw',
        per100g: { kcal: 356, protein: 24.9, carbs: 2.2, fat: 27.4 },
        source: 'usda'
      },
      {
        id: 'usda:2',
        name: 'Ziemniaki',
        aliases: ['kartofle'],
        state: 'raw',
        per100g: { kcal: 77, protein: 2.05, carbs: 17.49, fat: 0.09 },
        source: 'usda'
      }
    ],
    ...overrides
  };
}

describe('importBundledNutrition', () => {
  let database: EatMyWayDb;
  let repository: Repository;

  beforeEach(async () => {
    database = freshDb();
    await database.open();
    repository = createRepository(database);
  });

  afterEach(async () => {
    await database.delete();
  });

  it('imports on a fresh database and skips on the second load', async () => {
    const load = vi.fn(async () => bundle());

    const first = await importBundledNutrition({ repository, load });
    expect(first).toMatchObject({ status: 'imported', imported: 2 });
    expect(await repository.countIngredients()).toBe(2);
    expect(await repository.getMeta('nutritionDataVersion')).toBe(NUTRITION_DATA_VERSION);
    expect(await repository.getMeta('nutritionImportedAt')).toEqual(expect.any(String));

    const second = await importBundledNutrition({ repository, load });
    expect(second).toMatchObject({ status: 'skipped', imported: 0 });
    // The guard is a meta flag, so a skipped run must not even reach for the bundle.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-imports when the bundle version is newer than the stored one', async () => {
    await repository.setMeta('nutritionDataVersion', NUTRITION_DATA_VERSION - 1);

    const outcome = await importBundledNutrition({ repository, load: async () => bundle() });
    expect(outcome.status).toBe('imported');
    expect(await repository.getMeta('nutritionDataVersion')).toBe(NUTRITION_DATA_VERSION);
  });

  it('re-imports on demand with force, even when the flag is current', async () => {
    const load = vi.fn(async () => bundle());
    await importBundledNutrition({ repository, load });

    const forced = await importBundledNutrition({ repository, load, force: true });
    expect(forced.status).toBe('imported');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('leaves the user’s own ingredients alone', async () => {
    await repository.putIngredient({
      id: 'custom:mine',
      name: 'Babcine ciasto',
      aliases: [],
      state: 'cooked',
      per100g: { kcal: 400, protein: 5, carbs: 50, fat: 20 },
      source: 'custom'
    });

    await importBundledNutrition({ repository, load: async () => bundle() });

    expect(await repository.getIngredient('custom:mine')).toMatchObject({ name: 'Babcine ciasto' });
    expect(await repository.countIngredients()).toBe(3);
  });

  it('reports a failure without setting the flag, so the next load retries', async () => {
    const outcome = await importBundledNutrition({
      repository,
      load: async () => {
        throw new Error('offline');
      }
    });

    expect(outcome.status).toBe('failed');
    expect(await repository.getMeta('nutritionDataVersion')).toBeUndefined();
    expect(await repository.countIngredients()).toBe(0);
  });
});
