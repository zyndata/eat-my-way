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

describe('tags on save', () => {
  it('collapses a differently spelled label onto the existing key and counts both uses', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Śniadanie']);
    await repo.saveRecipe(makeRecipe({ id: 'r2' }), ['sniadanie']);

    const tags = await repo.allTags();
    expect(tags).toHaveLength(1);
    // The label stays as first typed; the key is what both recipes carry.
    expect(tags[0]).toEqual({ key: 'sniadanie', label: 'Śniadanie', useCount: 2 });
    expect((await repo.getRecipe('r2'))?.tags).toEqual(['sniadanie']);
  });

  it('does not count the same tag twice when a recipe is saved again', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad']);
    await repo.saveRecipe(makeRecipe({ id: 'r1', name: 'Zmieniony' }), ['Obiad']);

    expect((await repo.allTags())[0]?.useCount).toBe(1);
  });

  it('gives the count back when a tag is removed from a recipe', async () => {
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), ['Obiad']);
    await repo.saveRecipe(makeRecipe({ id: 'r1' }), []);

    expect((await repo.allTags())[0]?.useCount).toBe(0);
  });
});

describe('recipe usage', () => {
  it('counts planned meals and remembers the latest day', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);
    await repo.addRecipeToDay(WEDNESDAY, recipe.id);
    await repo.addRecipeToDay(WEDNESDAY, recipe.id);

    const [entry] = await repo.recipeLibrary();
    expect(entry?.usage).toEqual({ plannedCount: 3, lastPlannedDate: WEDNESDAY });
  });

  it('reports a never-planned recipe as unused', async () => {
    await seedRecipe();
    expect((await repo.recipeLibrary())[0]?.usage).toEqual({ plannedCount: 0 });
  });

  it('splits references into past and future at the given date', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);
    await repo.addRecipeToDay(TUESDAY, recipe.id);
    await repo.addRecipeToDay(WEDNESDAY, recipe.id);

    // TUESDAY is "today": it counts as future, so its snapshot can still be refreshed.
    expect(await repo.recipeReferences(recipe.id, TUESDAY)).toEqual({
      past: 1,
      future: 2,
      total: 3
    });
  });

  it('computes per-portion macros for a list of recipes in one pass', async () => {
    const recipe = await seedRecipe();
    expect((await repo.recipeMacros([recipe])).get(recipe.id)).toEqual(macros(300, 45, 1, 9));
  });
});

describe('refreshFutureSnapshots', () => {
  /** The fixture recipe cut down to 100 g of chicken: 100 kcal, 20 P, 0 C, 2 F. */
  async function shrinkRecipe(recipe: Recipe): Promise<Recipe> {
    const edited: Recipe = {
      ...recipe,
      items: [item(chicken.id, 100)],
      updatedAt: '2026-09-08T12:00:00.000Z'
    };
    await repo.saveRecipe(edited);
    return edited;
  }

  it('rewrites snapshots from the given day onwards and leaves the past untouched', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);
    await repo.addRecipeToDay(TUESDAY, recipe.id);
    await repo.addRecipeToDay(WEDNESDAY, recipe.id);

    await shrinkRecipe(recipe);
    const refreshed = await repo.refreshFutureSnapshots(recipe.id, TUESDAY);

    expect(refreshed.days).toBe(2);
    expect(refreshed.meals).toBe(2);
    expect(refreshed.macros).toEqual(macros(100, 20, 0, 2));

    // The past day still carries the macros frozen when the meal was planned.
    expect(dayTotals(await repo.getDay(MONDAY))).toEqual(macros(300, 45, 1, 9));
    expect(dayTotals(await repo.getDay(TUESDAY))).toEqual(macros(100, 20, 0, 2));
    expect(dayTotals(await repo.getDay(WEDNESDAY))).toEqual(macros(100, 20, 0, 2));
  });

  it('keeps cookingScale, portionsEaten and the goal snapshot', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(WEDNESDAY, recipe.id, { cookingScale: 3, portionsEaten: 2 });

    await shrinkRecipe(recipe);
    await repo.refreshFutureSnapshots(recipe.id, TUESDAY);

    const day = await repo.getDay(WEDNESDAY);
    expect(day.meals[0]?.cookingScale).toBe(3);
    expect(day.meals[0]?.portionsEaten).toBe(2);
    expect(day.goalSnapshot).toEqual(DEFAULT_PROFILE.goals);
    // meal macros = snapshot x portionsEaten
    expect(dayTotals(day)).toEqual(macros(200, 40, 0, 4));
  });

  it('does not touch meals from another recipe', async () => {
    const recipe = await seedRecipe();
    const other = makeRecipe({ id: 'other', name: 'Inny', items: [item(chicken.id, 300)] });
    await repo.saveRecipe(other);
    await repo.addRecipeToDay(WEDNESDAY, recipe.id);
    await repo.addRecipeToDay(WEDNESDAY, other.id);

    await shrinkRecipe(recipe);
    await repo.refreshFutureSnapshots(recipe.id, TUESDAY);

    const day = await repo.getDay(WEDNESDAY);
    expect(day.meals[0]?.macroSnapshot).toEqual(macros(100, 20, 0, 2));
    expect(day.meals[1]?.macroSnapshot).toEqual(macros(300, 60, 0, 6));
  });

  it('refuses to refresh a recipe that is gone', async () => {
    await expect(repo.refreshFutureSnapshots('nie-ma', MONDAY)).rejects.toThrow('Unknown recipe');
  });
});

describe('deleting a recipe', () => {
  it('keeps its planned meals, which own their macros', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.deleteRecipe(recipe.id);

    const day = await repo.getDay(MONDAY);
    expect(await repo.getRecipe(recipe.id)).toBeUndefined();
    expect(day.meals).toHaveLength(1);
    expect(dayTotals(day)).toEqual(macros(300, 45, 1, 9));
  });
});

describe('recipesByIds', () => {
  it('resolves the recipes a day refers to, skipping the ones that are gone', async () => {
    const recipe = await seedRecipe();
    const found = await repo.recipesByIds([recipe.id, 'nie-ma']);

    expect(found.get(recipe.id)?.name).toBe(recipe.name);
    expect(found.has('nie-ma')).toBe(false);
  });
});

describe('setMealOrder', () => {
  it('persists a new order across a re-read', async () => {
    const recipe = await seedRecipe();
    const first = await repo.addRecipeToDay(MONDAY, recipe.id);
    const second = await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.setMealOrder(MONDAY, [second.id, first.id]);

    const day = await repo.getDay(MONDAY);
    expect(day.meals.map((meal) => meal.id)).toEqual([second.id, first.id]);
  });

  it('leaves the totals and the goal snapshot untouched', async () => {
    const recipe = await seedRecipe();
    const first = await repo.addRecipeToDay(MONDAY, recipe.id);
    const second = await repo.addRecipeToDay(MONDAY, recipe.id);
    const before = await repo.getDay(MONDAY);

    await repo.setMealOrder(MONDAY, [second.id, first.id]);

    const after = await repo.getDay(MONDAY);
    expect(dayTotals(after)).toEqual(dayTotals(before));
    expect(after.goalSnapshot).toEqual(before.goalSnapshot);
  });
});

describe('updateMeal', () => {
  it('cookingScale changes nothing about the day totals', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);
    const before = dayTotals(await repo.getDay(MONDAY));

    await repo.updateMeal(MONDAY, meal.id, { cookingScale: 3 });

    const day = await repo.getDay(MONDAY);
    expect(day.meals[0]?.cookingScale).toBe(3);
    expect(dayTotals(day)).toEqual(before);
  });

  it('portionsEaten scales the day totals', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.updateMeal(MONDAY, meal.id, { portionsEaten: 2 });

    expect(dayTotals(await repo.getDay(MONDAY))).toEqual(macros(600, 90, 2, 18));
  });
});

describe('cookAlsoOn', () => {
  it('scales the source and lands a one-portion copy on the target day', async () => {
    const recipe = await seedRecipe();
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.cookAlsoOn(MONDAY, meal.id, TUESDAY, { nextId: seqIds('copy') });

    const source = await repo.getDay(MONDAY);
    const target = await repo.getDay(TUESDAY);

    expect(source.meals[0]?.cookingScale).toBe(2);
    // Cooking twice as much does not mean eating twice as much.
    expect(dayTotals(source)).toEqual(macros(300, 45, 1, 9));
    expect(target.meals).toHaveLength(1);
    expect(target.meals[0]?.id).toBe('copy-1');
    expect(target.meals[0]?.cookingScale).toBe(1);
    expect(target.meals[0]?.portionsEaten).toBe(1);
    expect(target.meals[0]?.macroSnapshot).toEqual(meal.macroSnapshot);
  });

  it('appends to a target day that already has meals, and captures its goals', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(TUESDAY, recipe.id);
    const meal = await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.cookAlsoOn(MONDAY, meal.id, TUESDAY);

    const target = await repo.getDay(TUESDAY);
    expect(target.meals).toHaveLength(2);
    expect(target.goalSnapshot).toEqual(DEFAULT_PROFILE.goals);
  });

  it('refuses a meal that is not on the source day', async () => {
    await expect(repo.cookAlsoOn(MONDAY, 'nie-ma', TUESDAY)).rejects.toThrow('Unknown meal');
  });
});

describe('a copy is independent of later recipe edits', () => {
  it('copyDay leaves the copies frozen when the source recipe is refreshed', async () => {
    const recipe = await seedRecipe();
    await repo.addRecipeToDay(MONDAY, recipe.id);

    await repo.copyDay(MONDAY, [WEDNESDAY], 'append', seqIds('copy'));

    // Halve the recipe, then carry the change into every day from Monday onwards.
    await repo.saveRecipe({ ...recipe, items: [item(chicken.id, 100)] });
    await repo.refreshFutureSnapshots(recipe.id, MONDAY);

    // Both days were in the future, so both followed — the point is that the *copy* is a
    // meal in its own right, with its own id and its own snapshot object.
    const copied = await repo.getDay(WEDNESDAY);
    expect(copied.meals[0]?.id).toBe('copy-1');
    expect(copied.meals[0]?.macroSnapshot).toEqual(macros(100, 20, 0, 2));

    // A copy made onto a past day is never touched by a refresh.
    await repo.copyDay(MONDAY, ['2026-01-01'], 'append', seqIds('old'));
    await repo.saveRecipe({ ...recipe, items: [item(chicken.id, 500)] });
    await repo.refreshFutureSnapshots(recipe.id, MONDAY);
    expect((await repo.getDay('2026-01-01')).meals[0]?.macroSnapshot).toEqual(
      macros(100, 20, 0, 2)
    );
  });
});
