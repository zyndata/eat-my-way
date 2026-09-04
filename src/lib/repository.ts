import type {
  Day,
  Ingredient,
  Macros,
  MealPlanTemplate,
  PlannedMeal,
  Profile,
  Recipe,
  Tag
} from './types';
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
import type { BackupDocument, BackupInput } from './backup';
import {
  DEFAULT_GOALS,
  DEFAULT_PROFILE,
  PROFILE_KEY,
  SCHEMA_VERSION,
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
import { countTagUses, removeTagKey, replaceTagKey, resolveTags, tagKey } from './tags';
import {
  NO_USAGE,
  duplicateRecipe,
  usageWindowStart,
  type RecipeListEntry,
  type RecipeUsage
} from './recipes';
import type { PlanWrite } from './planner';
import type { SearchCandidate } from './search';
import {
  IngredientInUseError,
  NotCustomIngredientError,
  replaceIngredientInItems
} from './custom-ingredients';

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

/** Just enough of a recipe to name it and link to it. */
export interface RecipeRef {
  id: string;
  name: string;
}

/**
 * What stands in the way of changing one ingredient: the recipes that refer to it, and the
 * planned meals those recipes account for, split at „today" exactly as `RecipeReferences` is.
 *
 * The delete dialog names the recipes; the „update future days?" question counts the meals.
 */
export interface IngredientReferences {
  recipes: RecipeRef[];
  past: number;
  future: number;
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
   * Recompute `useCount` for every tag from the recipes themselves, and drop the counts of
   * tags no recipe carries to zero. Tag administration recomputes rather than patches
   * (PLAN.md Phase 9 task 2): a merge or a colliding rename changes counts by an amount only
   * counting can know. Must run inside a transaction that already holds both tables.
   */
  async function recountTags(): Promise<void> {
    const counts = countTagUses(await database.recipes.toArray());
    for (const tag of await database.tags.toArray()) {
      const useCount = counts.get(tag.key) ?? 0;
      if (tag.useCount !== useCount) await database.tags.put({ ...tag, useCount });
    }
  }

  /**
   * How much each recipe is used, gathered in one pass over the days table. `recipeId`
   * lives inside a meal array, so IndexedDB cannot index it - see STATE.md decision 48.
   *
   * The pass starts at `today` minus the usage window rather than at the first day ever
   * planned (decision 147): this runs on every „Dodaj posiłek", and a range query over the
   * primary key costs the window, not the history. Days planned ahead are all included.
   */
  async function recipeUsage(today: string): Promise<Map<string, RecipeUsage>> {
    const usage = new Map<string, RecipeUsage>();
    const window = await database.days.where('date').aboveOrEqual(usageWindowStart(today)).toArray();

    for (const day of window) {
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

    /**
     * The Phase 13 meal-plan template. Stored on the profile, so it rides the existing
     * `profile.json` path to Drive and needs no file, no table and no schema version.
     */
    async setMealPlan(mealPlan: MealPlanTemplate): Promise<Profile> {
      const current = (await database.profile.get(PROFILE_KEY)) ?? DEFAULT_PROFILE;
      const profile: Profile = plain({ ...current, mealPlan });
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

    /**
     * Whether this browser has genuinely never been used — the local trigger for the first-run
     * wizard (PLAN.md Phase 11 task 2, STATE.md decision 193).
     *
     * Narrow on purpose. „No recipes and no days" alone would also describe someone who deleted
     * everything, so the profile must still be *identical* to `DEFAULT_PROFILE` and there must
     * be no vault: together those say nothing has ever been set, not merely that the calendar is
     * empty. `googleSub` counts as a difference, so a device that has ever connected Drive is
     * never „never used".
     *
     * The bundled USDA ingredients are ignored — they arrive on first run without anyone doing
     * anything, so counting them would make every database look used.
     */
    async isNeverUsed(): Promise<boolean> {
      const [recipes, days, vaultFile, setupDone, profile] = await Promise.all([
        database.recipes.count(),
        database.days.count(),
        database.meta.get('vaultFile' satisfies MetaKey) as Promise<string | undefined>,
        database.meta.get('setupDone' satisfies MetaKey) as Promise<boolean | undefined>,
        database.profile.get(PROFILE_KEY)
      ]);

      if (recipes > 0 || days > 0) return false;
      if (vaultFile !== undefined || setupDone === true) return false;
      if (profile === undefined) return true;

      // Compared field by field rather than by serialising both: key order would decide the
      // answer, and nothing guarantees it.
      return (
        profile.googleSub === undefined &&
        profile.geminiUsage === undefined &&
        profile.geminiModel === DEFAULT_PROFILE.geminiModel &&
        profile.encryptVault === DEFAULT_PROFILE.encryptVault &&
        profile.locale === DEFAULT_PROFILE.locale &&
        profile.goals.kcal === DEFAULT_GOALS.kcal &&
        profile.goals.protein === DEFAULT_GOALS.protein &&
        profile.goals.carbs === DEFAULT_GOALS.carbs &&
        profile.goals.fat === DEFAULT_GOALS.fat
      );
    },

    // ---- ingredients ---------------------------------------------------------------

    async getIngredient(id: string): Promise<Ingredient | undefined> {
      const row = await database.ingredients.get(id);
      return row === undefined ? undefined : fromIngredientRecord(row);
    },

    async allIngredients(): Promise<Ingredient[]> {
      return (await database.ingredients.toArray()).map(fromIngredientRecord);
    },

    /**
     * The raw write, stamping nothing. Anything the *user* wrote goes through
     * `saveCustomIngredient` instead, which is what carries the `updatedAt` the merge needs.
     */
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

    /**
     * Write an ingredient the user owns, stamping the edit time the merge needs.
     *
     * Every write from Phase 10 goes through here, creation from the recipe editor included,
     * so no custom row leaves this app without an `updatedAt` (STATE.md decision 182). A
     * bundled row is refused rather than written: `importBundledNutrition` would overwrite it
     * at the next data refresh and `syncSnapshot` would never upload it (decision 176).
     */
    async saveCustomIngredient(
      ingredient: Ingredient,
      now: string = new Date().toISOString()
    ): Promise<Ingredient> {
      if (ingredient.source !== 'custom') throw new NotCustomIngredientError(ingredient.id);
      const row = plain({ ...ingredient, updatedAt: now });
      await database.ingredients.put(toIngredientRecord(row));
      return row;
    },

    /**
     * Everything one ingredient is tied to. Read in one pass over the recipes and one over
     * the days, which is the same cost `recipeReferences` pays for a single recipe.
     */
    async ingredientReferences(ingredientId: string, today: string): Promise<IngredientReferences> {
      const users = (await database.recipes.toArray()).filter((recipe) =>
        recipe.items.some((item) => item.ingredientId === ingredientId)
      );

      const references: IngredientReferences = {
        recipes: users.map((recipe) => ({ id: recipe.id, name: recipe.name })),
        past: 0,
        future: 0
      };
      if (users.length === 0) return references;

      const ids = new Set(users.map((recipe) => recipe.id));
      for (const day of await database.days.toArray()) {
        const meals = day.meals.filter((meal) => ids.has(meal.recipeId)).length;
        if (meals === 0) continue;
        if (day.date < today) references.past += meals;
        else references.future += meals;
      }

      return references;
    },

    /**
     * Delete an ingredient nobody uses, and the corrections that named it.
     *
     * The refusal is here rather than only in the dialog because the damage would be silent:
     * `itemPer100g` falls back to `ZERO_MACROS` for an id that no longer resolves, so a recipe
     * would lose its numbers with nothing to say so (STATE.md decision 180). A recipe still
     * using it means „replace it or leave it" — there is no third answer.
     *
     * Corrections go with it: `resolveName` returns a correction's id outright without
     * checking that it resolves, so one left behind would make the next Gemini import match a
     * name to nothing at all (decision 181).
     */
    async deleteIngredient(id: string): Promise<void> {
      await database.transaction(
        'rw',
        database.ingredients,
        database.recipes,
        database.corrections,
        async () => {
          const row = await database.ingredients.get(id);
          if (row !== undefined && row.source !== 'custom') throw new NotCustomIngredientError(id);

          const users = (await database.recipes.toArray()).filter((recipe) =>
            recipe.items.some((item) => item.ingredientId === id)
          );
          if (users.length > 0) {
            throw new IngredientInUseError(id, users.map((recipe) => recipe.name));
          }

          await database.ingredients.delete(id);
          const stale = (await database.corrections.toArray()).filter(
            (correction) => correction.ingredientId === id
          );
          if (stale.length > 0) {
            await database.corrections.bulkDelete(stale.map((correction) => correction.nameKey));
          }
        }
      );
    },

    /**
     * „Zastąp innym składnikiem": point every recipe item at `toId`, repoint every correction
     * that named `fromId`, and then delete it — one transaction, because a half-done swap is a
     * recipe pointing at an ingredient that no longer exists.
     *
     * Everything else on an item — `amount`, `unit`, `gramsPerUnit`, a manual `macroOverride`
     * — is left exactly as it was: only identity moves. Affected recipes get a new
     * `updatedAt` so the merge carries the swap, and the caller is expected to ask the
     * „update future days?" question afterwards, because the macros have moved.
     *
     * Returns the ids of the recipes it rewrote.
     */
    async replaceIngredient(
      fromId: string,
      toId: string,
      now: string = new Date().toISOString()
    ): Promise<string[]> {
      if (fromId === toId) throw new Error('An ingredient cannot replace itself');

      return database.transaction(
        'rw',
        database.ingredients,
        database.recipes,
        database.corrections,
        async () => {
          const row = await database.ingredients.get(fromId);
          if (row !== undefined && row.source !== 'custom') throw new NotCustomIngredientError(fromId);
          if ((await database.ingredients.get(toId)) === undefined) {
            throw new Error(`Unknown ingredient: ${toId}`);
          }

          const rewritten: string[] = [];
          for (const recipe of await database.recipes.toArray()) {
            const items = replaceIngredientInItems(recipe.items, fromId, toId);
            if (items === recipe.items) continue;
            await database.recipes.put(plain({ ...recipe, items, updatedAt: now }));
            rewritten.push(recipe.id);
          }

          for (const correction of await database.corrections.toArray()) {
            if (correction.ingredientId !== fromId) continue;
            await database.corrections.put({ ...correction, ingredientId: toId, updatedAt: now });
          }

          await database.ingredients.delete(fromId);
          return rewritten;
        }
      );
    },

    // ---- tags ----------------------------------------------------------------------

    /** Most-used first, then alphabetically - the order the tag chips are shown in. */
    async allTags(): Promise<Tag[]> {
      const tags = await database.tags.toArray();
      return tags.sort((a, b) => b.useCount - a.useCount || a.key.localeCompare(b.key));
    },

    /**
     * Rename a tag. When the new label normalizes to the key it already has, only the
     * spelling changes and no recipe is touched; when it normalizes to a different key, every
     * recipe carrying the old key is rewritten to the new one. A label that collides with
     * another tag's key is a merge and must be routed through `mergeTags` — `planTagRename`
     * in `tags.ts` is what tells the two apart before the user is asked.
     */
    async renameTag(key: string, label: string): Promise<void> {
      await database.transaction('rw', database.recipes, database.tags, async () => {
        const tag = await database.tags.get(key);
        if (tag === undefined) return;

        const trimmed = label.trim();
        const nextTagKey = tagKey(trimmed);
        if (nextTagKey === '') return;

        if (nextTagKey === key) {
          await database.tags.put({ ...tag, label: trimmed });
          return;
        }

        const clash = await database.tags.get(nextTagKey);
        if (clash !== undefined) throw new Error(`Tag ${nextTagKey} already exists`);

        for (const recipe of await database.recipes.toArray()) {
          if (!recipe.tags.includes(key)) continue;
          await database.recipes.put({ ...recipe, tags: replaceTagKey(recipe.tags, key, nextTagKey) });
        }

        await database.tags.delete(key);
        await database.tags.put({ key: nextTagKey, label: trimmed, useCount: 0 });
        await recountTags();
      });
    },

    /** Remove a tag from every recipe carrying it, then delete the tag itself. */
    async deleteTag(key: string): Promise<void> {
      await database.transaction('rw', database.recipes, database.tags, async () => {
        for (const recipe of await database.recipes.toArray()) {
          if (!recipe.tags.includes(key)) continue;
          await database.recipes.put({ ...recipe, tags: removeTagKey(recipe.tags, key) });
        }
        await database.tags.delete(key);
        await recountTags();
      });
    },

    /**
     * Fold `from` into `into`: every recipe carrying the first now carries the second, the
     * first is deleted, and `useCount` is recomputed — a recipe that already carried both
     * must not be counted twice, which is exactly what patching would do.
     */
    async mergeTags(from: string, into: string): Promise<void> {
      if (from === into) return;
      await database.transaction('rw', database.recipes, database.tags, async () => {
        if ((await database.tags.get(into)) === undefined) return;

        for (const recipe of await database.recipes.toArray()) {
          if (!recipe.tags.includes(from)) continue;
          await database.recipes.put({ ...recipe, tags: replaceTagKey(recipe.tags, from, into) });
        }

        await database.tags.delete(from);
        await recountTags();
      });
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

    /**
     * „Zapisz jako kopię": store an independent copy of a recipe. The copy carries the
     * original's tags, so each of them gains a user and `useCount` is bumped through the
     * usual delta — a second recipe really does carry the tag now (open question 8).
     *
     * Returns `undefined` when the id resolves to nothing, which is what a library screen
     * showing a recipe that was deleted on another device would hit.
     */
    async duplicateRecipe(id: string, nextId: IdFactory = newId): Promise<Recipe | undefined> {
      return database.transaction('rw', database.recipes, database.tags, async () => {
        const original = await database.recipes.get(id);
        if (original === undefined) return undefined;

        const copy = duplicateRecipe(original, { id: nextId(), now: new Date().toISOString() });
        await applyTagDelta([], copy.tags);
        await database.recipes.put(copy);
        return copy;
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

    /**
     * „Zastosuj" on the planner sheet — the only thing in Phase 13 that writes.
     *
     * Deliberately nothing new: each day goes through `copyMealsInto`, which is the same
     * function „Kopiuj dzień do…" uses, so `goalSnapshot` capture, the fresh ids, the
     * `macroSnapshot` copied by value and the sync bookkeeping all behave exactly as they do
     * for a meal added by hand. `append` is the default and `replace` is the choice the user
     * makes for a day that already has meals — the same `CopyMode` the copy screens model.
     *
     * One transaction over the whole range, so a week either lands or does not.
     */
    async applyPlan(
      writes: readonly PlanWrite[],
      mode: CopyMode = 'append',
      nextId: IdFactory = newId
    ): Promise<Day[]> {
      return database.transaction('rw', database.days, database.profile, async () => {
        const goals = await currentGoals();
        const written: Day[] = [];
        for (const write of writes) {
          const day = copyMealsInto(await loadDay(write.date), write.meals, mode, { nextId, goals });
          written.push(await storeDay(day));
        }
        return written;
      });
    },

    // ---- recipes vs. planned history -----------------------------------------------

    recipeUsage,

    /** Every recipe with its usage - exactly what the library screen lists. */
    async recipeLibrary(today: string): Promise<RecipeListEntry[]> {
      const [recipes, usage] = await Promise.all([
        database.recipes.toArray(),
        recipeUsage(today)
      ]);
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
    },

    // ---- backup (Phase 8) ----------------------------------------------------------

    /**
     * Everything the export file carries: the same reading as `syncSnapshot`, plus the vault
     * and the two per-device list settings (Phase 10 task 9). What it still leaves out —
     * `deviceId`, `driveAccountLabel`, the sync bookkeeping and the bundled rows — is listed
     * with its reasons in `backup.ts`.
     */
    async backupInput(): Promise<BackupInput> {
      const [
        profile,
        recipes,
        tags,
        ingredients,
        corrections,
        days,
        schemaVersion,
        vaultFile,
        recipeSort,
        recipeGrouped,
        theme
      ] = await Promise.all([
        database.profile.get(PROFILE_KEY),
        database.recipes.toArray(),
        database.tags.toArray(),
        database.ingredients.where('source').equals('custom').toArray(),
        database.corrections.toArray(),
        database.days.toArray(),
        database.meta.get('schemaVersion' satisfies MetaKey) as Promise<number | undefined>,
        database.meta.get('vaultFile' satisfies MetaKey) as Promise<string | undefined>,
        database.meta.get('recipeSort' satisfies MetaKey) as Promise<
          MetaValues['recipeSort'] | undefined
        >,
        database.meta.get('recipeGrouped' satisfies MetaKey) as Promise<boolean | undefined>,
        database.meta.get('theme' satisfies MetaKey) as Promise<MetaValues['theme'] | undefined>
      ]);

      return {
        profile: profile ?? DEFAULT_PROFILE,
        recipes,
        tags,
        customIngredients: ingredients.map(fromIngredientRecord),
        corrections,
        days,
        schemaVersion: schemaVersion ?? SCHEMA_VERSION,
        ...(vaultFile === undefined ? {} : { vaultFile }),
        settings: {
          ...(recipeSort === undefined ? {} : { recipeSort }),
          ...(recipeGrouped === undefined ? {} : { recipeGrouped }),
          ...(theme === undefined ? {} : { theme })
        }
      };
    },

    /**
     * Restore a backup, replacing the user's data wholesale. Not a merge: the file is a
     * complete picture of a database, and merging it into another one would silently keep
     * rows the user believes they replaced.
     *
     * The bundled USDA ingredients are untouched — they belong to the build, not to the user.
     * What sync remembers *is* cleared: after a restore this device's data no longer descends
     * from the last sync, and a stale baseline would let the merge read a restored row as a
     * deletion.
     *
     * Three things about the restore are deliberate:
     *
     * - **A vault in the file is swapped in, not written over.** The previous `vault.json` is
     *   kept in `vaultFileReplaced`, the same undo sync already uses (STATE.md decisions 93,
     *   150, 185) — and it matters here precisely because the restored vault may carry a
     *   different master password and then cannot be opened on this device at all.
     * - **`googleSub` from the file never displaces one this device already holds**, so
     *   restoring a copy onto a machine connected to another account does not fake the
     *   wrong-account check (decision 186).
     * - **`deviceId` and `driveAccountLabel` are not touched**, because they describe this
     *   device and this connection, not the data being restored.
     */
    async restoreBackup(backup: BackupDocument): Promise<void> {
      const rows = plain({
        profile: backup.profile,
        recipes: backup.recipes,
        tags: backup.tags,
        ingredients: backup.ingredients.map(toIngredientRecord),
        corrections: backup.corrections,
        // An empty day has no row anywhere else in this app; a backup does not reintroduce one.
        days: backup.days.filter((day) => day.meals.length > 0)
      });

      await database.transaction(
        'rw',
        [
          database.profile,
          database.recipes,
          database.tags,
          database.ingredients,
          database.corrections,
          database.days,
          database.syncBaseline,
          database.driveFiles,
          database.meta
        ],
        async () => {
          const current = await database.profile.get(PROFILE_KEY);
          const googleSub = current?.googleSub ?? rows.profile.googleSub;
          await database.profile.put(
            googleSub === undefined ? rows.profile : { ...rows.profile, googleSub },
            PROFILE_KEY
          );

          await database.recipes.clear();
          await database.recipes.bulkPut(rows.recipes);

          await database.tags.clear();
          await database.tags.bulkPut(rows.tags);

          const customIds = await database.ingredients.where('source').equals('custom').primaryKeys();
          if (customIds.length > 0) await database.ingredients.bulkDelete(customIds);
          await database.ingredients.bulkPut(rows.ingredients);

          await database.corrections.clear();
          await database.corrections.bulkPut(rows.corrections);

          await database.days.clear();
          await database.days.bulkPut(rows.days);

          const vault = backup.vault;
          if (vault !== undefined) {
            const held = (await database.meta.get('vaultFile' satisfies MetaKey)) as
              | string
              | undefined;
            if (held !== undefined && held !== vault) {
              await database.meta.put(held, 'vaultFileReplaced' satisfies MetaKey);
            }
            await database.meta.put(vault, 'vaultFile' satisfies MetaKey);
          }

          const { recipeSort, recipeGrouped, theme } = backup.settings;
          if (recipeSort !== undefined) {
            await database.meta.put(recipeSort, 'recipeSort' satisfies MetaKey);
          }
          if (recipeGrouped !== undefined) {
            await database.meta.put(recipeGrouped, 'recipeGrouped' satisfies MetaKey);
          }
          // The screen reloads after a restore, and `startTheme` re-reads this and re-mirrors
          // it into `localStorage`, so the restored choice is what the next paint uses.
          if (theme !== undefined) await database.meta.put(theme, 'theme' satisfies MetaKey);

          await database.syncBaseline.clear();
          await database.driveFiles.clear();
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
