import type { Day, Ingredient, Profile, Recipe, Tag } from '../types';

/**
 * The `appDataFolder` file layout from PLAN.md, and the JSON that goes inside each file.
 *
 * These are wire shapes: exactly what another device (or a future version) will read back.
 * Nothing local-only ever reaches them — no Dexie index columns, no sync bookkeeping.
 */

export const VAULT_FILE = 'vault.json';
export const PROFILE_FILE = 'profile.json';
export const RECIPES_FILE = 'recipes.json';
export const INGREDIENTS_FILE = 'ingredients.json';

/** `days/2026-09.json`. Drive names are flat strings, so the slash is part of the name. */
export function daysFileName(month: string): string {
  return `days/${month}.json`;
}

/** The `YYYY-MM` a `YYYY-MM-DD` belongs to. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

const DAYS_FILE = /^days\/(\d{4}-\d{2})\.json$/;

/** The month a `days/*.json` name holds, or `undefined` for any other file. */
export function monthFromDaysFileName(name: string): string | undefined {
  return DAYS_FILE.exec(name)?.[1];
}

/** A Polish name the user has bound to a specific ingredient id (PLAN.md Phase 7). */
export interface IngredientCorrection {
  /** `normalizeKey` of the name as the parser produced it. */
  nameKey: string;
  ingredientId: string;
  updatedAt: string;
}

/** `recipes.json`. Tags travel with the recipes that use them — they have no file of their own. */
export interface RecipesDocument {
  recipes: Recipe[];
  tags: Tag[];
}

/** `ingredients.json`. The bundled USDA rows are never written here — they ship in the build. */
export interface IngredientsDocument {
  ingredients: Ingredient[];
  corrections: IngredientCorrection[];
}

/** `days/YYYY-MM.json`, keyed by date exactly as PLAN.md shows. */
export type DaysDocument = Record<string, Day>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Readers are forgiving in one direction only: a missing or malformed *section* degrades to
 * empty, but a value that is present and has the wrong shape is dropped rather than merged in.
 * Sync must never turn a damaged file into damaged local data.
 */
export function readRecipesDocument(value: unknown): RecipesDocument {
  const doc = (typeof value === 'object' && value !== null ? value : {}) as Partial<RecipesDocument>;
  return {
    recipes: asArray<Recipe>(doc.recipes).filter((recipe) => typeof recipe?.id === 'string'),
    tags: asArray<Tag>(doc.tags).filter((tag) => typeof tag?.key === 'string')
  };
}

export function readIngredientsDocument(value: unknown): IngredientsDocument {
  const doc = (typeof value === 'object' && value !== null ? value : {}) as Partial<IngredientsDocument>;
  return {
    ingredients: asArray<Ingredient>(doc.ingredients).filter(
      (ingredient) => typeof ingredient?.id === 'string'
    ),
    corrections: asArray<IngredientCorrection>(doc.corrections).filter(
      (correction) =>
        typeof correction?.nameKey === 'string' && typeof correction?.ingredientId === 'string'
    )
  };
}

export function readDaysDocument(value: unknown): DaysDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const days: DaysDocument = {};
  for (const [date, day] of Object.entries(value as Record<string, unknown>)) {
    const candidate = day as Day | null;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (!Array.isArray(candidate.meals)) continue;
    // The key is authoritative: a file whose inner `date` drifted still lands on the right day.
    days[date] = { ...candidate, date };
  }
  return days;
}

/** `profile.json`. Unknown or missing fields fall back to what the caller already had. */
export function readProfileDocument(value: unknown, fallback: Profile): Profile {
  if (typeof value !== 'object' || value === null) return fallback;
  const doc = value as Partial<Profile>;
  return {
    goals:
      typeof doc.goals === 'object' && doc.goals !== null
        ? { ...fallback.goals, ...doc.goals }
        : fallback.goals,
    geminiModel: typeof doc.geminiModel === 'string' ? doc.geminiModel : fallback.geminiModel,
    encryptVault:
      typeof doc.encryptVault === 'boolean' ? doc.encryptVault : fallback.encryptVault,
    locale: 'pl',
    ...(typeof doc.googleSub === 'string' ? { googleSub: doc.googleSub } : {})
  };
}
