import type { Day, Ingredient, Macros, PlannedMeal, Profile, Recipe, Tag } from './types';
import type {
  DriveFileRow,
  EatMyWayDb,
  IngredientRecord,
  MetaKey,
  MetaValues,
  SyncBaselineRow
} from './db';
import type { IngredientCorrection } from './sync/documents';
import { monthOf } from './sync/documents';
import {
  DEFAULT_PROFILE,
  PROFILE_KEY,
  db as defaultDb,
  fromIngredientRecord,
  toIngredientRecord
} from './db';
import { ingredientLookup, recipePortionMacros, type IngredientLookup } from './macros';
import {
  addMeals,
  copyMealsInto,
  countMealsFromRecipe,
  clonePlannedMeal,
  duplicateMealInDay,
  emptyDay,
  findMeal,
  orderMeals,
  planMeal,
  removeMeal,
  resnapshotMeals,
  updateMeal,
  type CopyMode,
  type MealChanges
} from './day';
import { newId, type IdFactory } from './ids';
import { resolveTags } from './tags';
import { NO_USAGE, type RecipeListEntry, type RecipeUsage } from './recipes';
import type { SearchCandidate } from './search';

/**
 * A copy IndexedDB will accept.
 *
 * Everything that reaches this module from a screen came out of a Svelte rune, and every
 * object read out of `$state` is a `Proxy` that structured clone refuses (STATE.md decision
 * 56). A spread only unwraps the top level, so the guard has to be deep — and it belongs
 * here rather than at each call site, because decision 56 predicted the mistake would recur
 * and it did: `setGoals` passed the bound goals object straight through, so „Zapisz cele"
 * threw `DataCloneError`, wrote nothing and left the button on „Zapisywanie…" for good.
 *
 * JSON is the right shape for the copy: everything stored here is already JSON-serialisable
 * — that is what keeps the Drive documents byte-identical to the spec — so a round trip
 * loses only the `undefined` properties IndexedDB would have stored as absent anyway.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Planned meals referring to one recipe, split at "today" (STATE.md decision 49). */
export interface RecipeReferences {
  /** Meals on days strictly before `today`. Never rewritten by anything.  */
  past: number;
  /** Meals on days from `today` onwards — what "update future days" would touch. */
  future: number;
  total: number;
}

/** What one "update future days" run changed. */
export interface SnapshotRefresh {
  days: number;
  meals: number;
  /** The per-portion macros written into those meals. */
  macros: Macros;
}

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
    const row = plain(day);
    if (row.meals.length === 0) await database.days.delete(row.date);
    else await database.days.put(row);
    return row;
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

  /**
   * How much each recipe is used, gathered in one pass over the days table. `recipeId`
   * lives inside a meal array, so IndexedDB cannot index it - see STATE.md decision 48.
   */
  async function recipeUsage(): Promise<Map<string, RecipeUsage>> {
    const usage = new Map<string, RecipeUsage>();

    for (const day of await database.days.toArray()) {
      for (const meal of day.meals) {
        const current = usage.get(meal.recipeId);
        if (current === undefined) {
          usage.set(meal.recipeId, { plannedCount: 1, lastPlannedDate: day.date });
          continue;
        }
        current.plannedCount += 1;
        if (current.lastPlannedDate === undefined || day.date > current.lastPlannedDate) {
          current.lastPlannedDate = day.date;
        }
      }
    }

    return usage;
  }

  return {
    // ---- profile -------------------------------------------------------------------

    async getProfile(): Promise<Profile> {
      return (await database.profile.get(PROFILE_KEY)) ?? DEFAULT_PROFILE;
    },

    async saveProfile(profile: Profile): Promise<Profile> {
      const row = plain(profile);
      await database.profile.put(row, PROFILE_KEY);
      return row;
    },

    async setGoals(goals: Macros): Promise<Profile> {
      const current = (await database.profile.get(PROFILE_KEY)) ?? DEFAULT_PROFILE;
      const profile: Profile = plain({ ...current, goals });
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

    async deleteMeta(key: MetaKey): Promise<void> {
      await database.meta.delete(key);
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
      const row = plain(ingredient);
      await database.ingredients.put(toIngredientRecord(row));
      return row;
    },

    async putIngredients(ingredients: readonly Ingredient[]): Promise<void> {
      await database.ingredients.bulkPut(plain([...ingredients]).map(toIngredientRecord));
    },

    async countIngredients(): Promise<number> {
      return database.ingredients.count();
    },

    /** The ingredients behind a set of ids, in one round trip. Unknown ids are skipped. */
    async ingredientsByIds(ids: readonly string[]): Promise<Ingredient[]> {
      const rows = await database.ingredients.bulkGet([...new Set(ids)]);
      return rows
        .filter((row): row is IngredientRecord => row !== undefined)
        .map(fromIngredientRecord);
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
     * The recipes behind a set of ids, keyed by id. Ids that resolve to nothing are simply
     * absent — a meal whose recipe was deleted is a supported state, not an error
     * (STATE.md decisions 51 and 73).
     */
    async recipesByIds(ids: readonly string[]): Promise<Map<string, Recipe>> {
      const rows = await database.recipes.bulkGet([...new Set(ids)]);
      return new Map(
        rows.filter((row): row is Recipe => row !== undefined).map((row) => [row.id, row])
      );
    },

    /**
     * Store a recipe. When `labels` is given they are the user's free-typed tags: unknown
     * ones are created (keeping the spelling as typed) and the recipe stores their keys.
     * `useCount` follows the difference against what the recipe was tagged with before.
     */
    async saveRecipe(recipe: Recipe, labels?: readonly string[]): Promise<Recipe> {
      return database.transaction('rw', database.recipes, database.tags, async () => {
        const previous = await database.recipes.get(recipe.id);
        let stored = plain(recipe);

        if (labels !== undefined) {
          const { keys, created } = resolveTags([...labels], await database.tags.toArray());
          if (created.length > 0) await database.tags.bulkPut(created);
          stored = { ...stored, tags: keys };
        }

        await applyTagDelta(previous?.tags ?? [], stored.tags);
        await database.recipes.put(stored);
        return stored;
      });
    },

    /**
     * Per-portion macros for a list of recipes, over one read of the ingredients they
     * mention. Used by the library, which would otherwise do a lookup per card.
     */
    async recipeMacros(recipes: readonly Recipe[]): Promise<Map<string, Macros>> {
      const ids = recipes.flatMap((recipe) => recipe.items.map((item) => item.ingredientId));
      const rows = await database.ingredients.bulkGet([...new Set(ids)]);
      const lookup = ingredientLookup(
        rows
          .filter((row): row is IngredientRecord => row !== undefined)
          .map(fromIngredientRecord)
      );
      return new Map(recipes.map((recipe) => [recipe.id, recipePortionMacros(recipe, lookup)]));
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

    /**
     * Persist a new meal order. Takes ids rather than meals so nothing that has been through
     * a Svelte `$state` proxy can reach IndexedDB - see STATE.md decisions 56 and 77.
     */
    async setMealOrder(date: string, mealIds: readonly string[]): Promise<Day> {
      return database.transaction('rw', database.days, async () =>
        storeDay(orderMeals(await loadDay(date), mealIds))
      );
    },

    /** Change one meal's `cookingScale` or `portionsEaten`. Snapshots are never touched. */
    async updateMeal(date: string, mealId: string, changes: MealChanges): Promise<Day> {
      return database.transaction('rw', database.days, async () =>
        storeDay(updateMeal(await loadDay(date), mealId, changes))
      );
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
    },

    /**
     * PLAN.md's "cooking for 2 days": set the meal's `cookingScale` to 2 and put a copy of it
     * on `targetDate` eating one portion. The copy carries the source `macroSnapshot` over
     * verbatim, like every other copy, and `cookingScale` on the copy stays 1 - the second
     * day is not cooked again, it is eaten out of the same pot.
     */
    async cookAlsoOn(
      sourceDate: string,
      mealId: string,
      targetDate: string,
      options: { scale?: number; nextId?: IdFactory } = {}
    ): Promise<Day> {
      const nextId = options.nextId ?? newId;
      return database.transaction('rw', database.days, database.profile, async () => {
        const source = findMeal(await loadDay(sourceDate), mealId);
        if (source === undefined) throw new Error(`Unknown meal: ${mealId} on ${sourceDate}`);

        const scaled = updateMeal(await loadDay(sourceDate), mealId, {
          cookingScale: options.scale ?? 2
        });
        await storeDay(scaled);

        const copy = { ...clonePlannedMeal(source, nextId()), cookingScale: 1, portionsEaten: 1 };
        return storeDay(addMeals(await loadDay(targetDate), [copy], await currentGoals()));
      });
    },

    // ---- recipes vs. planned history -----------------------------------------------

    recipeUsage,

    /** Every recipe with its usage - exactly what the library screen lists. */
    async recipeLibrary(): Promise<RecipeListEntry[]> {
      const [recipes, usage] = await Promise.all([database.recipes.toArray(), recipeUsage()]);
      return recipes.map((recipe) => ({ recipe, usage: usage.get(recipe.id) ?? NO_USAGE }));
    },

    /**
     * Planned meals referring to `recipeId`, split into past and future. Drives both the
     * "update future days?" prompt on save and the warning on delete.
     */
    async recipeReferences(recipeId: string, today: string): Promise<RecipeReferences> {
      const counts: RecipeReferences = { past: 0, future: 0, total: 0 };

      for (const day of await database.days.toArray()) {
        const meals = countMealsFromRecipe(day, recipeId);
        if (meals === 0) continue;
        if (day.date < today) counts.past += meals;
        else counts.future += meals;
        counts.total += meals;
      }

      return counts;
    },

    /**
     * "Update future days": recompute the recipe's per-portion macros from what is stored
     * now and write them into every meal from `fromDate` onwards. This is the only path
     * that rewrites a `macroSnapshot`; days before `fromDate` are not even read for writing,
     * so history cannot change. `cookingScale` and `portionsEaten` are left untouched.
     */
    async refreshFutureSnapshots(recipeId: string, fromDate: string): Promise<SnapshotRefresh> {
      return database.transaction(
        'rw',
        database.days,
        database.recipes,
        database.ingredients,
        async () => {
          const recipe = await database.recipes.get(recipeId);
          if (recipe === undefined) throw new Error(`Unknown recipe: ${recipeId}`);

          const macros = recipePortionMacros(recipe, await lookupForRecipe(recipe));
          const refreshed: SnapshotRefresh = { days: 0, meals: 0, macros };

          const upcoming = await database.days.where('date').aboveOrEqual(fromDate).toArray();
          for (const day of upcoming) {
            const updated = resnapshotMeals(day, recipeId, macros);
            // `resnapshotMeals` returns the same object when nothing matched.
            if (updated === day) continue;
            refreshed.days += 1;
            refreshed.meals += countMealsFromRecipe(day, recipeId);
            await database.days.put(updated);
          }

          return refreshed;
        }
      );
    },

    // ---- sync (Phase 6) ------------------------------------------------------------

    /** Everything Drive sync reads, in one pass. Bundled USDA rows are deliberately absent. */
    async syncSnapshot(): Promise<SyncSnapshot> {
      const [profile, recipes, tags, ingredients, corrections, days, vaultFile] = await Promise.all([
        database.profile.get(PROFILE_KEY),
        database.recipes.toArray(),
        database.tags.toArray(),
        // Only what the user created: the USDA subset ships in the build and must never be
        // uploaded — it would be a few hundred kB of redundant public data per device.
        database.ingredients.where('source').equals('custom').toArray(),
        database.corrections.toArray(),
        database.days.toArray(),
        database.meta.get('vaultFile' satisfies MetaKey) as Promise<string | undefined>
      ]);

      return {
        profile: profile ?? DEFAULT_PROFILE,
        recipes,
        tags,
        customIngredients: ingredients.map(fromIngredientRecord),
        corrections,
        days,
        vaultFile
      };
    },

    /** The baseline hashes from the last successful sync, keyed as `merge.ts` expects. */
    async syncBaseline(): Promise<Map<string, string>> {
      const rows = await database.syncBaseline.toArray();
      return new Map(rows.map((row) => [row.key, row.hash]));
    },

    /** Replace the whole baseline. It only ever describes one consistent past sync. */
    async setSyncBaseline(baseline: ReadonlyMap<string, string>): Promise<void> {
      const rows: SyncBaselineRow[] = [...baseline].map(([key, hash]) => ({ key, hash }));
      await database.transaction('rw', database.syncBaseline, async () => {
        await database.syncBaseline.clear();
        await database.syncBaseline.bulkPut(rows);
      });
    },

    async driveFiles(): Promise<Map<string, DriveFileRow>> {
      const rows = await database.driveFiles.toArray();
      return new Map(rows.map((row) => [row.name, row]));
    },

    async setDriveFiles(rows: readonly DriveFileRow[]): Promise<void> {
      await database.transaction('rw', database.driveFiles, async () => {
        await database.driveFiles.clear();
        await database.driveFiles.bulkPut([...rows]);
      });
    },

    /**
     * Forget everything sync remembers, without touching a single row of user data. This is
     * what "connect a different account" does: the next sync then treats both sides as new.
     */
    async resetSyncState(): Promise<void> {
      await database.transaction('rw', database.syncBaseline, database.driveFiles, async () => {
        await database.syncBaseline.clear();
        await database.driveFiles.clear();
      });
    },

    async allCorrections(): Promise<IngredientCorrection[]> {
      return database.corrections.toArray();
    },

    async putCorrection(correction: IngredientCorrection): Promise<void> {
      await database.corrections.put(plain(correction));
    },

    /**
     * Write a merged dataset back. Each map that is present is the *complete* picture of its
     * collection, so anything local and missing from it was deleted elsewhere and goes too.
     * `days` is complete only for the months listed in `months` — a month nobody synced is
     * left entirely alone.
     */
    async applyMergedData(merged: MergedData): Promise<void> {
      // Six tables: the array form, because the variadic overload stops at five.
      await database.transaction(
        'rw',
        [
          database.profile,
          database.recipes,
          database.tags,
          database.ingredients,
          database.corrections,
          database.days
        ],
        async () => {
          if (merged.profile !== undefined) {
            await database.profile.put(merged.profile, PROFILE_KEY);
          }

          if (merged.recipes !== undefined) {
            const keep = merged.recipes;
            const existing = await database.recipes.toCollection().primaryKeys();
            const gone = existing.filter((id) => !keep.has(id));
            if (gone.length > 0) await database.recipes.bulkDelete(gone);
            await database.recipes.bulkPut([...keep.values()]);
          }

          if (merged.tags !== undefined) {
            const keep = merged.tags;
            const existing = await database.tags.toCollection().primaryKeys();
            const gone = existing.filter((key) => !keep.has(key));
            if (gone.length > 0) await database.tags.bulkDelete(gone);
            await database.tags.bulkPut([...keep.values()]);
          }

          if (merged.ingredients !== undefined) {
            const keep = merged.ingredients;
            // Scoped to `custom`: the bundled USDA rows are not part of the merge at all.
            const existing = await database.ingredients.where('source').equals('custom').primaryKeys();
            const gone = existing.filter((id) => !keep.has(id as string));
            if (gone.length > 0) await database.ingredients.bulkDelete(gone);
            await database.ingredients.bulkPut([...keep.values()].map(toIngredientRecord));
          }

          if (merged.corrections !== undefined) {
            const keep = merged.corrections;
            const existing = await database.corrections.toCollection().primaryKeys();
            const gone = existing.filter((key) => !keep.has(key));
            if (gone.length > 0) await database.corrections.bulkDelete(gone);
            await database.corrections.bulkPut([...keep.values()]);
          }

          if (merged.days !== undefined && merged.months !== undefined) {
            const keep = merged.days;
            const months = new Set(merged.months);
            const existing = await database.days.toCollection().primaryKeys();
            const gone = existing.filter((date) => months.has(monthOf(date)) && !keep.has(date));
            if (gone.length > 0) await database.days.bulkDelete(gone);
            // A day that merged down to no meals leaves no row, exactly as `storeDay` does.
            const rows = [...keep.values()].filter((day) => day.meals.length > 0);
            const emptied = [...keep.values()].filter((day) => day.meals.length === 0);
            if (emptied.length > 0) await database.days.bulkDelete(emptied.map((day) => day.date));
            await database.days.bulkPut(rows);
          }
        }
      );
    }
  };
}

/** Everything Drive sync reads out of IndexedDB. */
export interface SyncSnapshot {
  profile: Profile;
  recipes: Recipe[];
  tags: Tag[];
  /** `source: 'custom'` only — the bundled USDA subset never travels. */
  customIngredients: Ingredient[];
  corrections: IngredientCorrection[];
  days: Day[];
  /** Raw `vault.json` text, or `undefined` when this device has never seen one. */
  vaultFile: string | undefined;
}

/** A merged dataset on its way back into IndexedDB. Absent members are left untouched. */
export interface MergedData {
  profile?: Profile;
  recipes?: ReadonlyMap<string, Recipe>;
  tags?: ReadonlyMap<string, Tag>;
  ingredients?: ReadonlyMap<string, Ingredient>;
  corrections?: ReadonlyMap<string, IngredientCorrection>;
  days?: ReadonlyMap<string, Day>;
  /** Which months `days` is authoritative for. */
  months?: readonly string[];
}

export type Repository = ReturnType<typeof createRepository>;

/** The application-wide repository, bound to the application-wide database. */
export const repository = createRepository();
