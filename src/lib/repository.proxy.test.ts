import { describe, expect, it } from 'vitest';
import { createRepository } from './repository';
import { freshDb } from '../test/fixtures';
import { chicken, makeRecipe } from '../test/fixtures';
import type { Day, Ingredient, Macros, PlannedMeal, Profile, Recipe } from './types';

/**
 * Every repository write, given the kind of value the UI actually hands it.
 *
 * Svelte `$state` is a `Proxy`, and IndexedDB's structured clone refuses to clone one
 * (STATE.md decision 56, which predicted this "will recur" — it did, in `setGoals`). The
 * existing suite never caught it because it calls these methods with object literals, while
 * every real caller in `routes/` and `components/` passes something that came out of a rune.
 *
 * `proxied` stands in for that: it is what `$state` produces as far as structured clone is
 * concerned, nested objects included.
 */

/** A deep `Proxy`, the way `$state` hands values out. */
function proxied<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return new Proxy(value.map(proxied) as unknown as object, {}) as T;
  return new Proxy(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, proxied(item)])),
    {}
  ) as T;
}

const GOALS: Macros = { kcal: 2200, protein: 160, carbs: 210, fat: 70 };

const PROFILE: Profile = {
  goals: GOALS,
  geminiModel: 'gemini-2.5-flash',
  encryptVault: true,
  locale: 'pl'
};

const MEAL: PlannedMeal = {
  id: 'meal-1',
  recipeId: 'recipe-1',
  cookingScale: 1,
  portionsEaten: 1,
  macroSnapshot: { kcal: 500, protein: 30, carbs: 40, fat: 20 }
};

const DAY: Day = { date: '2026-09-02', meals: [MEAL], goalSnapshot: GOALS };

function repo(): ReturnType<typeof createRepository> {
  return createRepository(freshDb());
}

describe('a $state proxy reaches every write path the UI uses', () => {
  it('sanity: a bare proxy is what IndexedDB refuses', async () => {
    const db = freshDb();
    await expect(db.profile.put(proxied(PROFILE), 1)).rejects.toThrow(/could not be cloned/);
  });

  it('setGoals — Ustawienia and the wizard’s „Cele" step', async () => {
    const repository = repo();
    await repository.setGoals(proxied(GOALS));
    expect((await repository.getProfile()).goals).toEqual(GOALS);
  });

  it('saveProfile — the Gemini model field', async () => {
    const repository = repo();
    // Exactly what Settings does: spread the top level and change one string.
    const fromState = proxied(PROFILE);
    await repository.saveProfile({ ...fromState, geminiModel: 'gemini-2.5-pro' });
    const stored = await repository.getProfile();
    expect(stored.geminiModel).toBe('gemini-2.5-pro');
    expect(stored.goals).toEqual(GOALS);
  });

  it('putIngredient — a hand-written ingredient', async () => {
    const repository = repo();
    await repository.putIngredient(proxied<Ingredient>(chicken));
    expect(await repository.getIngredient(chicken.id)).toMatchObject({ id: chicken.id });
  });

  it('saveRecipe — the editor’s draft and its tag labels', async () => {
    const repository = repo();
    const recipe = proxied<Recipe>(makeRecipe({ tags: ['obiad'] }));
    await repository.saveRecipe(recipe, proxied(['Obiad']));
    expect(await repository.getRecipe(recipe.id)).toMatchObject({ id: recipe.id });
  });

  it('saveDay and addMealToDay — the day screen', async () => {
    const repository = repo();
    await repository.saveDay(proxied<Day>(DAY));
    await repository.addMealToDay('2026-09-03', proxied<PlannedMeal>({ ...MEAL, id: 'meal-2' }));
    expect((await repository.getDay('2026-09-02'))?.meals).toHaveLength(1);
  });

  it('setMealOrder — drag and drop', async () => {
    const repository = repo();
    await repository.saveDay(DAY);
    await repository.setMealOrder('2026-09-02', proxied(['meal-1']));
    expect((await repository.getDay('2026-09-02'))?.meals[0]?.id).toBe('meal-1');
  });

  it('updateMeal — the portion and scale steppers', async () => {
    const repository = repo();
    await repository.saveDay(DAY);
    await repository.updateMeal('2026-09-02', 'meal-1', proxied({ portionsEaten: 2 }));
    expect((await repository.getDay('2026-09-02'))?.meals[0]?.portionsEaten).toBe(2);
  });
});
