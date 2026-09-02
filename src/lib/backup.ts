import type { Day, Ingredient, Macros, Profile, Recipe, Tag } from './types';
import type { IngredientCorrection } from './sync/documents';
import { DEFAULT_PROFILE } from './db';

/**
 * „Zapisz kopię" / „Wczytaj kopię" — the whole local database as one JSON file (PLAN.md
 * Phase 8 task 6).
 *
 * This is the way out for a user who does not use Drive: without it, the only copy of a year
 * of planning lives in one browser profile. It is also the only export format this app has,
 * so it is written to be read by a human and by a future version of this app, not to be
 * clever — one flat document, every field named as it is named everywhere else.
 *
 * Two things are deliberately **not** in it:
 *
 * - **The vault.** It holds the Gemini API key, and when the user turned encryption off it
 *   holds it in the clear. A backup is a file that ends up in Downloads, in a mail attachment
 *   and in someone's cloud drive; the key does not travel that way. The key is re-entered
 *   after a restore, which takes a minute (STATE.md decision 137).
 * - **The bundled USDA ingredients.** They ship inside the app and are re-imported on first
 *   run, so a backup that carried them would be a few hundred kB of the same public data.
 *   Only ingredients the user wrote themselves are exported.
 */

/** Bumped only when an older file would be read wrongly rather than merely incompletely. */
export const BACKUP_VERSION = 1;

/** Identifies our own files, so a stray JSON is refused instead of half-imported. */
export const BACKUP_KIND = 'eat-my-way-backup';

export interface BackupDocument {
  kind: typeof BACKUP_KIND;
  version: number;
  /** ISO timestamp — informational; nothing depends on it. */
  exportedAt: string;
  /** IndexedDB schema version the file was written from, for a future migration to read. */
  schemaVersion: number;
  profile: Profile;
  recipes: Recipe[];
  tags: Tag[];
  /** `source: 'custom'` only. */
  ingredients: Ingredient[];
  corrections: IngredientCorrection[];
  days: Day[];
}

/** Everything a backup is built from — exactly what the repository reads out of IndexedDB. */
export interface BackupInput {
  profile: Profile;
  recipes: Recipe[];
  tags: Tag[];
  customIngredients: Ingredient[];
  corrections: IngredientCorrection[];
  days: Day[];
  schemaVersion: number;
}

export function buildBackup(input: BackupInput, now: Date = new Date()): BackupDocument {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    schemaVersion: input.schemaVersion,
    profile: input.profile,
    recipes: input.recipes,
    tags: input.tags,
    ingredients: input.customIngredients,
    corrections: input.corrections,
    days: input.days
  };
}

/** `eat-my-way-2026-09-01.json` — sorts by date and says what it is. */
export function backupFileName(now: Date = new Date()): string {
  return `eat-my-way-${now.toISOString().slice(0, 10)}.json`;
}

/** What a restore is about to do, in the numbers the confirmation dialog shows. */
export interface BackupSummary {
  recipes: number;
  days: number;
  meals: number;
  ingredients: number;
  exportedAt: string;
}

export function summarizeBackup(backup: BackupDocument): BackupSummary {
  return {
    recipes: backup.recipes.length,
    days: backup.days.length,
    meals: backup.days.reduce((total, day) => total + day.meals.length, 0),
    ingredients: backup.ingredients.length,
    exportedAt: backup.exportedAt
  };
}

/** Thrown by `readBackup` with a Polish sentence the settings screen shows verbatim. */
export class BackupError extends Error {}

function isMacros(value: unknown): value is Macros {
  if (typeof value !== 'object' || value === null) return false;
  const macros = value as Record<string, unknown>;
  return (['kcal', 'protein', 'carbs', 'fat'] as const).every(
    (key) => typeof macros[key] === 'number' && Number.isFinite(macros[key])
  );
}

function array<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new BackupError(`Plik kopii jest uszkodzony: brakuje sekcji „${what}".`);
  return value as T[];
}

/**
 * Parse and check a file the user picked.
 *
 * The checks are the ones that stop a bad file from becoming a broken database — an id that
 * is not a string, a day with no date, macros that are not numbers. Everything beyond that is
 * left alone: a recipe carrying a field this version does not know about keeps it, so an
 * older build restoring a newer file loses nothing it could have preserved.
 */
export function readBackup(text: string): BackupDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('To nie jest plik JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupError('Plik kopii jest pusty albo uszkodzony.');
  }

  const document = parsed as Partial<BackupDocument>;
  if (document.kind !== BACKUP_KIND) {
    throw new BackupError('To nie jest kopia danych Eat My Way.');
  }
  if (typeof document.version !== 'number' || document.version > BACKUP_VERSION) {
    throw new BackupError('Ta kopia pochodzi z nowszej wersji aplikacji. Zaktualizuj aplikację i spróbuj ponownie.');
  }

  const recipes = array<Recipe>(document.recipes, 'przepisy');
  const days = array<Day>(document.days, 'dni');
  const tags = array<Tag>(document.tags, 'tagi');
  const ingredients = array<Ingredient>(document.ingredients, 'składniki');
  const corrections = array<IngredientCorrection>(document.corrections, 'poprawki nazw');

  for (const recipe of recipes) {
    if (typeof recipe?.id !== 'string' || typeof recipe.name !== 'string' || !Array.isArray(recipe.items)) {
      throw new BackupError('Plik kopii zawiera przepis w nieznanym formacie.');
    }
  }
  for (const day of days) {
    if (typeof day?.date !== 'string' || !Array.isArray(day.meals)) {
      throw new BackupError('Plik kopii zawiera dzień w nieznanym formacie.');
    }
    for (const meal of day.meals) {
      if (typeof meal?.id !== 'string' || !isMacros(meal.macroSnapshot)) {
        throw new BackupError('Plik kopii zawiera posiłek bez zapisanych wartości odżywczych.');
      }
    }
  }
  for (const ingredient of ingredients) {
    if (typeof ingredient?.id !== 'string' || !isMacros(ingredient.per100g)) {
      throw new BackupError('Plik kopii zawiera składnik w nieznanym formacie.');
    }
  }

  const profile =
    typeof document.profile === 'object' && document.profile !== null
      ? { ...DEFAULT_PROFILE, ...document.profile }
      : DEFAULT_PROFILE;

  return {
    kind: BACKUP_KIND,
    version: document.version,
    exportedAt: typeof document.exportedAt === 'string' ? document.exportedAt : '',
    schemaVersion: typeof document.schemaVersion === 'number' ? document.schemaVersion : 0,
    profile,
    recipes,
    tags,
    ingredients,
    corrections,
    days
  };
}
