import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from './repository';
import type { EatMyWayDb } from './db';
import { DEFAULT_PROFILE } from './db';
import { dayTotals } from './macros';
import type { Recipe } from './types';
import { chicken, freshDb, ingredients, item, macros, makeRecipe, seqIds } from '../test/fixtures';

let db: EatMyWayDb;
let repo: Repository;

const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';
const WEDNESDAY = '2026-09-09';

/** A repository preloaded with the fixture ingredients and one recipe. */
async function seedRecipe(overrides: Partial<Recipe> = {}): Promise<Recipe> {
  await repo.putIngredients(ingredients);
  const recipe = makeRecipe(overrides);
  await repo.saveRecipe(recipe);
  return recipe;
}

beforeEach(async () => {
  db = freshDb();
  await db.open();
  repo = createRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe('profile', () => {
  it('reads back the seeded default', async () => {
    expect(await repo.getProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('persists changed goals without touching the rest of the profile', async () => {
    await repo.setGoals(macros(1800, 120, 180, 60));
    const profile = await repo.getProfile();

    expect(profile.goals).toEqual(macros(1800, 120, 180, 60));
    expect(profile.geminiModel).toBe(DEFAULT_PROFILE.geminiModel);
    expect(profile.encryptVault).toBe(true);
  });
});

describe('ingredients', () => {
  it('round-trip in the wire shape, with no local index fields leaking out', async () => {
    await repo.putIngredient(chicken);
    expect(await repo.getIngredient(chicken.id)).toEqual(chicken);
    expect(await repo.allIngredients()).toEqual([chicken]);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await repo.getIngredient('custom:nope')).toBeUndefined();
  });
});

describe('days', () => {
  it('read an unplanned day as empty without creating a row', async () => {
    expect(await repo.getDay(MONDAY)).toEqual({ date: MONDAY, meals: [] });
    expect(await db.days.count()).toBe(0);
  });

  it('capture the profile goals when the first meal is added', async () => {
    await repo.setGoals(macros(1800, 120, 180, 60));
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);

    expect((await repo.getDay(MONDAY)).goalSnapshot).toEqual(macros(1800, 120, 180, 60));
  });

  it('keep the first snapshot when goals change and another meal is added', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);
    await repo.setGoals(macros(1200, 60, 120, 40));
    await repo.addRecipeToDay(MONDAY, recipe.id);

    expect((await repo.getDay(MONDAY)).goalSnapshot).toEqual(DEFAULT_PROFILE.goals);
  });

  it('drop the row when the day is cleared', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);
    expect(await db.days.count()).toBe(1);

    await repo.clearDay(MONDAY);
    expect(await db.days.count()).toBe(0);
    expect(await repo.getDay(MONDAY)).toEqual({ date: MONDAY, meals: [] });
  });

  it('list a date range in order', async () => {
    const recipe = await seedRecipe();
    for (const date of [WEDNESDAY, MONDAY, TUESDAY]) {
      await repo.addRecipeToDay(date, recipe.id);
    }

    expect((await repo.getDays(MONDAY, TUESDAY)).map((day) => day.date)).toEqual([
      MONDAY,
      TUESDAY
    ]);
  });

  it('remove a single meal and reset the day when it was the last one', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);

    const day = await repo.removeMealFromDay(MONDAY, meal.id);
    expect(day.meals).toEqual([]);
    expect(day.goalSnapshot).toBeUndefined();
    expect(await db.days.count()).toBe(0);
  });
});

describe('planning a recipe', () => {
  it('freezes the per-portion macros at add time', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);

    expect(meal.macroSnapshot).toEqual(macros(300, 45, 1, 9));
    expect(dayTotals(await repo.getDay(MONDAY))).toEqual(macros(300, 45, 1, 9));
  });

  it('leaves already-planned days untouched when the recipe is edited afterwards', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.saveRecipe({ ...recipe, items: [item(chicken.id, 1000)] });
    await repo.addRecipeToDay(TUESDAY, recipe.id);

    expect(dayTotals(await repo.getDay(MONDAY)).kcal).toBe(300);
    expect(dayTotals(await repo.getDay(TUESDAY)).kcal).toBe(1000);
  });

  it('rejects an unknown recipe id', async () => {
    await expect(repo.addRecipeToDay(MONDAY, 'recipe-missing')).rejects.toThrow(/Unknown recipe/);
  });

  it('multiplies the day total by portionsEaten, never by cookingScale', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id, { cookingScale: 4, portionsEaten: 2 });

    expect(dayTotals(await repo.getDay(MONDAY)).kcal).toBe(600);
  });
});

describe('duplicateMeal', () => {
  it('persists a copy with a new id directly after the original', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'meal-1' });

    const day = await repo.duplicateMeal(MONDAY, meal.id, seqIds('copy'));

    expect(day.meals.map((entry) => entry.id)).toEqual(['meal-1', 'copy-1']);
    expect(day.meals[1]?.macroSnapshot).toEqual(meal.macroSnapshot);
    expect(dayTotals(await repo.getDay(MONDAY)).kcal).toBe(600);
  });
});

describe('copyMealToDays', () => {
  it('appends a copy to every target and skips the source day', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'meal-1' });

    const written = await repo.copyMealToDays(
      MONDAY,
      meal.id,
      [MONDAY, TUESDAY, WEDNESDAY],
      seqIds('copy')
    );

    expect(written.map((day) => day.date)).toEqual([TUESDAY, WEDNESDAY]);
    expect((await repo.getDay(MONDAY)).meals.map((entry) => entry.id)).toEqual(['meal-1']);
    expect((await repo.getDay(TUESDAY)).meals[0]?.macroSnapshot).toEqual(meal.macroSnapshot);
    expect((await repo.getDay(WEDNESDAY)).meals[0]?.id).toBe('copy-2');
  });

  it('keeps the copies frozen when the source recipe changes later', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'meal-1' });
    await repo.copyMealToDays(MONDAY, meal.id, [TUESDAY], seqIds('copy'));

    await repo.saveRecipe({ ...recipe, items: [item(chicken.id, 1000)] });

    expect(dayTotals(await repo.getDay(TUESDAY)).kcal).toBe(300);
  });

  it('rejects a meal id that is not on the source day', async () => {
    await expect(repo.copyMealToDays(MONDAY, 'meal-missing', [TUESDAY])).rejects.toThrow(
      /Unknown meal/
    );
  });
});

describe('copyDay', () => {
  it('appends to a non-empty target by default', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'a' });
    await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'b' });
    await repo.addRecipeToDay(TUESDAY, recipe.id, { id: 'x' });

    await repo.copyDay(MONDAY, [TUESDAY], 'append', seqIds('copy'));

    expect((await repo.getDay(TUESDAY)).meals.map((meal) => meal.id)).toEqual([
      'x',
      'copy-1',
      'copy-2'
    ]);
  });

  it('discards the target content when replacing', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'a' });
    await repo.addRecipeToDay(TUESDAY, recipe.id, { id: 'x' });

    await repo.copyDay(MONDAY, [TUESDAY], 'replace', seqIds('copy'));

    expect((await repo.getDay(TUESDAY)).meals.map((meal) => meal.id)).toEqual(['copy-1']);
  });

  it('skips the source day and captures goals on an empty target', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id, { id: 'a' });

    const written = await repo.copyDay(MONDAY, [MONDAY, TUESDAY], 'append', seqIds('copy'));

    expect(written.map((day) => day.date)).toEqual([TUESDAY]);
    expect((await repo.getDay(MONDAY)).meals).toHaveLength(1);
    expect((await repo.getDay(TUESDAY)).goalSnapshot).toEqual(DEFAULT_PROFILE.goals);
  });
});

describe('recipes and tags', () => {
  it('creates unknown tags from typed labels and counts their use', async () => {
    const recipe = makeRecipe({ tags: [] });
    const stored = await repo.saveRecipe(recipe, ['Obiad', 'Bez Glutenu']);

    expect(stored.tags).toEqual(['obiad', 'bez glutenu']);
    expect(await repo.allTags()).toEqual([
      { key: 'bez glutenu', label: 'Bez Glutenu', useCount: 1 },
      { key: 'obiad', label: 'Obiad', useCount: 1 }
    ]);
  });

  it('reuses an existing tag and keeps its original label', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad']);
    await repo.saveRecipe(makeRecipe({ id: 'r2' }), ['OBIAD']);

    expect(await repo.allTags()).toEqual([{ key: 'obiad', label: 'Obiad', useCount: 2 }]);
  });

  it('counts down when a tag is removed from a recipe', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad', 'Wege']);
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad']);

    const counts = Object.fromEntries((await repo.allTags()).map((t) => [t.key, t.useCount]));
    expect(counts).toEqual({ obiad: 1, wege: 0 });
  });

  it('counts down when the recipe is deleted', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad']);
    await repo.deleteRecipe('r1');

    expect(await repo.getRecipe('r1')).toBeUndefined();
    expect(await repo.allTags()).toEqual([{ key: 'obiad', label: 'Obiad', useCount: 0 }]);
  });

  it('sorts tags by use, then alphabetically', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Zupa', 'Obiad']);
    await repo.saveRecipe(makeRecipe({ id: 'r2' }), ['Obiad']);

    expect((await repo.allTags()).map((tag) => tag.key)).toEqual(['obiad', 'zupa']);
  });
});

describe('meta', () => {
  it('stores and reads typed bookkeeping values', async () => {
    await repo.setMeta('lastSyncedAt', '2026-09-07T12:00:00.000Z');
    expect(await repo.getMeta('lastSyncedAt')).toBe('2026-09-07T12:00:00.000Z');
    expect(await repo.getMeta('driveModifiedTime')).toBeUndefined();
  });
});
