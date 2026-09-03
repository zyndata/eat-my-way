import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from './db';
import type { Ingredient } from './types';
import { createRepository, type Repository } from './repository';
import { IngredientInUseError, NotCustomIngredientError } from './custom-ingredients';
import { importBundledNutrition } from './nutrition/import';
import { at, chicken, freshDb, item, macros, makeRecipe } from '../test/fixtures';

/**
 * The writes behind „Składniki" (PLAN.md Phase 10 tasks 4-7). Every rule here is enforced in
 * the repository rather than only in the screen, because each one of them protects a *number*
 * the user will read later: a missing ingredient silently zeroes a recipe, a stale correction
 * silently mismatches the next import, and a snapshot rewritten too far back silently rewrites
 * history.
 */

let database: EatMyWayDb;
let repository: Repository;

const TODAY = '2026-09-10';

const twarog: Ingredient = {
  id: 'custom:1',
  name: 'Twaróg półtłusty',
  aliases: ['twarog'],
  state: 'raw',
  per100g: macros(130, 18, 3, 4),
  source: 'custom'
};

const skyr: Ingredient = {
  id: 'custom:2',
  name: 'Skyr',
  aliases: [],
  state: 'raw',
  per100g: macros(60, 11, 4, 0),
  source: 'custom'
};

beforeEach(async () => {
  database = freshDb();
  await database.open();
  repository = createRepository(database);
  await repository.putIngredients([chicken, twarog, skyr]);
});

afterEach(async () => {
  await database.delete();
});

describe('saving a custom ingredient', () => {
  it('stamps the edit time the merge needs', async () => {
    const saved = await repository.saveCustomIngredient(twarog, '2026-09-10T08:00:00.000Z');

    expect(saved.updatedAt).toBe('2026-09-10T08:00:00.000Z');
    expect((await repository.getIngredient('custom:1'))?.updatedAt).toBe('2026-09-10T08:00:00.000Z');
  });

  it('refuses a bundled row, which no data refresh would preserve anyway', async () => {
    await expect(repository.saveCustomIngredient({ ...chicken, name: 'Kurczak' })).rejects.toThrow(
      NotCustomIngredientError
    );
    expect((await repository.getIngredient(chicken.id))?.name).toBe(chicken.name);
  });
});

describe('a copy of a bundled row', () => {
  it('survives a forced re-import of the bundle, and the original is rewritten', async () => {
    // What „Kopiuj i edytuj" produces: a `custom:*` row holding the corrected values.
    await repository.saveCustomIngredient({
      ...chicken,
      id: 'custom:3',
      name: 'Pierś z kurczaka (kopia)',
      per100g: macros(111, 21, 0, 3),
      source: 'custom'
    });

    // A data refresh, exactly as `NUTRITION_DATA_VERSION` rising would run it.
    await importBundledNutrition({
      repository,
      force: true,
      load: async () => ({
        dataVersion: 99,
        sources: ['USDA'],
        attribution: 'USDA FoodData Central',
        ingredients: [{ ...chicken, name: 'Pierś z kurczaka, surowa', per100g: macros(120, 23, 0, 3) }]
      })
    });

    expect((await repository.getIngredient('custom:3'))?.per100g.kcal).toBe(111);
    // …while the bundled row is overwritten, which is why editing one in place is refused.
    expect((await repository.getIngredient(chicken.id))?.per100g.kcal).toBe(120);
  });
});

describe('what an ingredient is tied to', () => {
  it('names every recipe using it and splits its planned meals at today', async () => {
    await repository.saveRecipe(makeRecipe({ id: 'r1', name: 'Serniczki', items: [item('custom:1', 200)] }));
    await repository.saveRecipe(makeRecipe({ id: 'r2', name: 'Kurczak', items: [item(chicken.id, 100)] }));
    await repository.addRecipeToDay('2026-09-01', 'r1');
    await repository.addRecipeToDay('2026-09-20', 'r1');
    await repository.addRecipeToDay('2026-09-21', 'r2');

    const references = await repository.ingredientReferences('custom:1', TODAY);

    expect(references.recipes).toEqual([{ id: 'r1', name: 'Serniczki' }]);
    expect(references.past).toBe(1);
    expect(references.future).toBe(1);
  });
});

describe('deleting', () => {
  it('removes an unused ingredient together with the corrections naming it', async () => {
    await repository.putCorrection({
      nameKey: 'twarog',
      ingredientId: 'custom:1',
      updatedAt: '2026-09-01T10:00:00.000Z'
    });

    await repository.deleteIngredient('custom:1');

    expect(await repository.getIngredient('custom:1')).toBeUndefined();
    // A correction outliving its target would make the next import match a name to nothing.
    expect(await repository.allCorrections()).toEqual([]);
  });

  it('refuses through the repository itself when a recipe still uses it', async () => {
    await repository.saveRecipe(makeRecipe({ id: 'r1', name: 'Serniczki', items: [item('custom:1', 200)] }));

    await expect(repository.deleteIngredient('custom:1')).rejects.toThrow(IngredientInUseError);
    expect(await repository.getIngredient('custom:1')).toBeDefined();
  });

  it('names the recipes in the refusal, so the screen can link to each of them', async () => {
    await repository.saveRecipe(makeRecipe({ id: 'r1', name: 'Serniczki', items: [item('custom:1', 200)] }));
    await repository.saveRecipe(makeRecipe({ id: 'r2', name: 'Naleśniki', items: [item('custom:1', 50)] }));

    await expect(repository.deleteIngredient('custom:1')).rejects.toMatchObject({
      recipeNames: ['Serniczki', 'Naleśniki']
    });
  });

  it('refuses a bundled row outright', async () => {
    await expect(repository.deleteIngredient(chicken.id)).rejects.toThrow(NotCustomIngredientError);
  });
});

describe('replacing', () => {
  beforeEach(async () => {
    await repository.saveRecipe(
      makeRecipe({
        id: 'r1',
        name: 'Serniczki',
        items: [
          item('custom:1', 2, 'szt', { gramsPerUnit: 55, macroOverride: macros(9, 9, 9, 9) }),
          item(chicken.id, 100)
        ],
        updatedAt: '2026-08-01T10:00:00.000Z'
      })
    );
    await repository.putCorrection({
      nameKey: 'twarog',
      ingredientId: 'custom:1',
      updatedAt: '2026-09-01T10:00:00.000Z'
    });
  });

  it('moves only the identity and leaves every measurement untouched', async () => {
    const rewritten = await repository.replaceIngredient('custom:1', 'custom:2', '2026-09-10T08:00:00.000Z');

    expect(rewritten).toEqual(['r1']);
    const recipe = await repository.getRecipe('r1');
    expect(at(recipe?.items ?? [])).toEqual({
      ingredientId: 'custom:2',
      amount: 2,
      unit: 'szt',
      gramsPerUnit: 55,
      macroOverride: macros(9, 9, 9, 9)
    });
    // The untouched row is exactly as it was, and the recipe carries a new edit time.
    expect(at(recipe?.items ?? [], 1)).toEqual({ ingredientId: chicken.id, amount: 100, unit: 'g' });
    expect(recipe?.updatedAt).toBe('2026-09-10T08:00:00.000Z');
  });

  it('repoints the corrections and drops the old row', async () => {
    await repository.replaceIngredient('custom:1', 'custom:2');

    expect(await repository.getIngredient('custom:1')).toBeUndefined();
    expect(at(await repository.allCorrections()).ingredientId).toBe('custom:2');
  });

  it('refuses a replacement that does not exist', async () => {
    await expect(repository.replaceIngredient('custom:1', 'custom:404')).rejects.toThrow(
      'Unknown ingredient: custom:404'
    );
    expect(await repository.getIngredient('custom:1')).toBeDefined();
  });
});

describe('the days a macro change may touch', () => {
  beforeEach(async () => {
    await repository.saveRecipe(
      makeRecipe({ id: 'r1', name: 'Serniczki', items: [item('custom:1', 100)] })
    );
    await repository.addRecipeToDay('2026-09-01', 'r1');
    await repository.addRecipeToDay('2026-09-20', 'r1');
  });

  it('rewrites future snapshots on „tak" and never a day before today', async () => {
    await repository.saveCustomIngredient({ ...twarog, per100g: macros(999, 18, 3, 4) });
    await repository.refreshFutureSnapshots('r1', TODAY);

    const past = at((await repository.getDay('2026-09-01')).meals);
    const future = at((await repository.getDay('2026-09-20')).meals);

    expect(past.macroSnapshot.kcal).toBe(130);
    expect(future.macroSnapshot.kcal).toBe(999);
  });

  it('leaves every snapshot alone on „nie" — the ingredient still changes', async () => {
    await repository.saveCustomIngredient({ ...twarog, per100g: macros(999, 18, 3, 4) });

    expect(at((await repository.getDay('2026-09-01')).meals).macroSnapshot.kcal).toBe(130);
    expect(at((await repository.getDay('2026-09-20')).meals).macroSnapshot.kcal).toBe(130);
    expect((await repository.getIngredient('custom:1'))?.per100g.kcal).toBe(999);
  });
});
