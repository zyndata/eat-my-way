import type { Day, Ingredient, Macros, PlannedMeal, Profile, Recipe, Tag } from './types';
import type { EatMyWayDb, IngredientRecord, MetaKey, MetaValues } from './db';
import {
  DEFAULT_PROFILE,
  PROFILE_KEY,
  db as defaultDb,
  fromIngredientRecord,
  toIngredientRecord
} from './db';
import { ingredientLookup, type IngredientLookup } from './macros';
import {
  addMeals,
  copyMealsInto,
  duplicateMealInDay,
  emptyDay,
  findMeal,
  planMeal,
  removeMeal,
  type CopyMode
} from './day';
import { newId, type IdFactory } from './ids';
import { resolveTags } from './tags';
import type { SearchCandidate } from './search';

/**
 * One row as the ingredient autocomplete needs it: the wire-shape ingredient plus the
 * normalized keys IndexedDB already indexes and how many recipes refer to it.
 */
export interface IngredientSearchEntry extends SearchCandidate {
  ingredient: Ingredient;
}

/**
 * Persistence. Everything here is a thin transaction around the pure functions in
 * `day.ts`, `macros.ts` and `tags.ts` - the rules live there, this file only reads and
 * writes rows.
 *
 * Bound to a database instance through a factory so tests can run against their own.
 */
export function createRepository(database: EatMyWayDb = defaultDb) {
  /** A day that has never been planned has no row; it reads back as an empty day. */
  async function loadDay(date: string): Promise<Day> {
    return (await database.days.get(date)) ?? emptyDay(date);
  }

  /** An emptied day loses its row rather than being stored as an empty one. */
  async function storeDay(day: Day): Promise<Day> {
    if (day.meals.length === 0) await database.days.delete(day.date);
    else await database.days.put(day);
    return day;
  }

  async function currentGoals(): Promise<Macros> {
    const profile = await database.profile.get(PROFILE_KEY);
    return profile?.goals ?? DEFAULT_PROFILE.goals;
  }

  /** Ingredient lookup covering exactly the ingredients one recipe refers to. */
  async function lookupForRecipe(recipe: Recipe): Promise<IngredientLookup> {
    const ids = [...new Set(recipe.items.map((item) => item.ingredientId))];
    const rows = await database.ingredients.bulkGet(ids);
    const found = rows.filter((row): row is IngredientRecord => row !== undefined);
    return ingredientLookup(found.map(fromIngredientRecord));
  }

  /** How many recipes use each ingredient. Ingredients nobody uses are simply absent. */
  async function ingredientUseCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const recipe of await database.recipes.toArray()) {
      // A recipe listing the same ingredient twice still counts as one user of it.
      for (const id of new Set(recipe.items.map((item) => item.ingredientId))) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Move `useCount` for tags a recipe gained or lost. Unknown keys are ignored. */
  async function applyTagDelta(before: readonly string[], after: readonly string[]): Promise<void> {
    const previous = new Set(before);
    const next = new Set(after);

    for (const key of next) {
      if (previous.has(key)) continue;
      await database.tags.where('key').equals(key).modify((tag) => {
        tag.useCount += 1;
      });
    }
    for (const key of previous) {
      if (next.has(key)) continue;
      await database.tags.where('key').equals(key).modify((tag) => {
        tag.useCount = Math.max(0, tag.useCount - 1);
      });
    }
  }

  return {
    // ---- profile -------------------------------------------------------------------

    async getProfile(): Promise<Profile> {
      return (await database.profile.get(PROFILE_KEY)) ?? DEFAULT_PROFILE;
    },

    async saveProfile(profile: Profile): Promise<Profile> {
      await database.profile.put(profile, PROFILE_KEY);
      return profile;
    },

    async setGoals(goals: Macros): Promise<Profile> {
      const current = (await database.profile.get(PROFILE_KEY)) ?? DEFAULT_PROFILE;
      const profile: Profile = { ...current, goals };
      await database.profile.put(profile, PROFILE_KEY);
      return profile;
    },

    // ---- meta ----------------------------------------------------------------------

    async getMeta<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined> {
      return (await database.meta.get(key)) as MetaValues[K] | undefined;
    },

    async setMeta<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
      await database.meta.put(value, key);
    },

    // ---- ingredients ---------------------------------------------------------------

    async getIngredient(id: string): Promise<Ingredient | undefined> {
      const row = await database.ingredients.get(id);
      return row === undefined ? undefined : fromIngredientRecord(row);
    },

    async allIngredients(): Promise<Ingredient[]> {
      return (await database.ingredients.toArray()).map(fromIngredientRecord);
    },

    async putIngredient(ingredient: Ingredient): Promise<Ingredient> {
      await database.ingredients.put(toIngredientRecord(ingredient));
      return ingredient;
    },

    async putIngredients(ingredients: readonly Ingredient[]): Promise<void> {
      await database.ingredients.bulkPut(ingredients.map(toIngredientRecord));
    },

    async countIngredients(): Promise<number> {
      return database.ingredients.count();
    },

    ingredientUseCounts,

    /**
     * Everything the autocomplete ranks over, read once from IndexedDB. The normalized
     * keys come straight off the indexed columns, so nothing is recomputed here.
     */
    async ingredientSearchIndex(): Promise<IngredientSearchEntry[]> {
      const [rows, useCounts] = await Promise.all([
        database.ingredients.toArray(),
        ingredientUseCounts()
      ]);
      return rows.map((row) => ({
        ingredient: fromIngredientRecord(row),
        nameKey: row.nameKey,
        aliasKeys: row.aliasKeys,
        useCount: useCounts.get(row.id) ?? 0
      }));
    },

    // ---- tags ----------------------------------------------------------------------

    /** Most-used first, then alphabetically - the order the tag chips are shown in. */
    async allTags(): Promise<Tag[]> {
      const tags = await database.tags.toArray();
      return tags.sort((a, b) => b.useCount - a.useCount || a.key.localeCompare(b.key));
    },

    // ---- recipes -------------------------------------------------------------------

    async getRecipe(id: string): Promise<Recipe | undefined> {
      return database.recipes.get(id);
    },

    async allRecipes(): Promise<Recipe[]> {
      return database.recipes.toArray();
    },

    /**
     * Store a recipe. When `labels` is given they are the user's free-typed tags: unknown
     * ones are created (keeping the spelling as typed) and the recipe stores their keys.
     * `useCount` follows the difference against what the recipe was tagged with before.
     */
    async saveRecipe(recipe: Recipe, labels?: readonly string[]): Promise<Recipe> {
      return database.transaction('rw', database.recipes, database.tags, async () => {
        const previous = await database.recipes.get(recipe.id);
        let stored = recipe;

        if (labels !== undefined) {
          const { keys, created } = resolveTags(labels, await database.tags.toArray());
          if (created.length > 0) await database.tags.bulkPut(created);
          stored = { ...recipe, tags: keys };
        }

        await applyTagDelta(previous?.tags ?? [], stored.tags);
        await database.recipes.put(stored);
        return stored;
      });
    },

    async deleteRecipe(id: string): Promise<void> {
      await database.transaction('rw', database.recipes, database.tags, async () => {
        const recipe = await database.recipes.get(id);
        if (recipe === undefined) return;
        await applyTagDelta(recipe.tags, []);
        await database.recipes.delete(id);
      });
    },

    // ---- days ----------------------------------------------------------------------

    getDay: loadDay,

    /** Every day with a row between `from` and `to`, inclusive, in date order. */
    async getDays(from: string, to: string): Promise<Day[]> {
      return database.days.where('date').between(from, to, true, true).sortBy('date');
    },

    async saveDay(day: Day): Promise<Day> {
      return storeDay(day);
    },

    /**
     * Plan a recipe onto a day. The recipe's per-portion macros are computed once, here,
     * and frozen into the meal - later edits to the recipe never reach back into this day.
     */
    async addRecipeToDay(
      date: string,
      recipeId: string,
      options: { id?: string; cookingScale?: number; portionsEaten?: number } = {}
    ): Promise<PlannedMeal> {
      return database.transaction(
        'rw',
        database.days,
        database.profile,
        database.recipes,
        database.ingredients,
        async () => {
          const recipe = await database.recipes.get(recipeId);
          if (recipe === undefined) throw new Error(`Unknown recipe: ${recipeId}`);

          const meal = planMeal(recipe, await lookupForRecipe(recipe), options);
          await storeDay(addMeals(await loadDay(date), [meal], await currentGoals()));
          return meal;
        }
      );
    },

    async addMealToDay(date: string, meal: PlannedMeal): Promise<Day> {
      return database.transaction('rw', database.days, database.profile, async () =>
        storeDay(addMeals(await loadDay(date), [meal], await currentGoals()))
      );
    },

    async removeMealFromDay(date: string, mealId: string): Promise<Day> {
      return database.transaction('rw', database.days, async () =>
        storeDay(removeMeal(await loadDay(date), mealId))
      );
    },

    /** "Wyczysc dzien" - the day goes back to having never been planned. */
    async clearDay(date: string): Promise<Day> {
      return storeDay(emptyDay(date));
    },

    // ---- copy operations -----------------------------------------------------------

    /** Copy one meal within its own day, inserted right after the original. */
    async duplicateMeal(dayDate: string, mealId: string, nextId: IdFactory = newId): Promise<Day> {
      return database.transaction('rw', database.days, async () =>
        storeDay(duplicateMealInDay(await loadDay(dayDate), mealId, nextId()))
      );
    },

    /**
     * Copy one meal onto other days, appending to each. `sourceDate` is part of the
     * signature because days are keyed by date and a meal id is not indexed - see STATE.md
     * decision 25. The source day itself is skipped; `duplicateMeal` is the same-day copy.
     */
    async copyMealToDays(
      sourceDate: string,
      mealId: string,
      targetDates: readonly string[],
      nextId: IdFactory = newId
    ): Promise<Day[]> {
      return database.transaction('rw', database.days, database.profile, async () => {
        const meal = findMeal(await loadDay(sourceDate), mealId);
        if (meal === undefined) throw new Error(`Unknown meal: ${mealId} on ${sourceDate}`);

        const goals = await currentGoals();
        const written: Day[] = [];
        for (const date of targetDates) {
          if (date === sourceDate) continue;
          const day = copyMealsInto(await loadDay(date), [meal], 'append', { nextId, goals });
          written.push(await storeDay(day));
        }
        return written;
      });
    },

    /**
     * Copy a whole day onto others. `append` keeps whatever the target already had (the
     * default the UI offers); `replace` wipes it first. The source day is skipped.
     */
    async copyDay(
      sourceDate: string,
      targetDates: readonly string[],
      mode: CopyMode = 'append',
      nextId: IdFactory = newId
    ): Promise<Day[]> {
      return database.transaction('rw', database.days, database.profile, async () => {
        const source = await loadDay(sourceDate);
        const goals = await currentGoals();
        const written: Day[] = [];
        for (const date of targetDates) {
          if (date === sourceDate) continue;
          const day = copyMealsInto(await loadDay(date), source.meals, mode, { nextId, goals });
          written.push(await storeDay(day));
        }
        return written;
      });
    }
  };
}

export type Repository = ReturnType<typeof createRepository>;

/** The application-wide repository, bound to the application-wide database. */
export const repository = createRepository();
