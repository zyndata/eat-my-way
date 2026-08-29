import Dexie, { type Table, type Transaction } from 'dexie';
import type { Day, Ingredient, Macros, Profile, Recipe, Tag } from './types';
import { normalizeKey } from './text';

/**
 * IndexedDB is the source of truth (PLAN.md); Drive is a sync layer on top of it.
 *
 * Rows are stored in the exact wire shape from `types.ts`, with one exception:
 * ingredients also carry diacritic-normalized keys so IndexedDB can index them. Those are
 * derived on write and stripped on read, so nothing local leaks into the Drive JSON.
 */

export const DB_NAME = 'eat-my-way';

/** Latest schema version. Bump together with a new `version(n)` block below. */
export const SCHEMA_VERSION = 2;

/** The profile is a single row under a fixed outbound key. */
export const PROFILE_KEY = 1;

/** Defaults for a profile the user has not filled in yet (PLAN.md first-run wizard). */
export const DEFAULT_GOALS: Macros = { kcal: 2000, protein: 100, carbs: 250, fat: 70 };

/** Free-tier catalogs change, so this is a default, never a hardcoded assumption. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_PROFILE: Profile = {
  goals: DEFAULT_GOALS,
  geminiModel: DEFAULT_GEMINI_MODEL,
  encryptVault: true,
  locale: 'pl'
};

/** Bookkeeping keys of the meta key/value table. */
export interface MetaValues {
  /** Schema version last written by this app. */
  schemaVersion: number;
  /** When the local database was first created. */
  createdAt: string;
  /**
   * `dataVersion` of the bundled USDA subset last imported. Absent means "never imported";
   * a value below the bundle's version means the app must re-import it (Phase 3).
   */
  nutritionDataVersion: number;
  /** When that import finished. */
  nutritionImportedAt: string;
  /** Drive `modifiedTime` seen at the last successful sync (Phase 6). */
  driveModifiedTime: string;
  /** When the last successful sync finished (Phase 6). */
  lastSyncedAt: string;
}

export type MetaKey = keyof MetaValues;

/** An ingredient as stored locally: the wire shape plus its search index keys. */
export interface IngredientRecord extends Ingredient {
  /** `normalizeKey(name)` — indexed, so Phase 3 can prefix-search without diacritics. */
  nameKey: string;
  /** `normalizeKey` of every alias — a multi-entry index. */
  aliasKeys: string[];
}

/** Version 1: the base tables. `''` means an outbound key, passed to `put()` separately. */
export const SCHEMA_V1: Record<string, string> = {
  ingredients: 'id, name, source',
  recipes: 'id, name, updatedAt, *tags',
  tags: 'key, useCount',
  days: 'date',
  profile: '',
  meta: ''
};

/** Version 2 adds the normalized search index to ingredients. Only that table changes. */
export const SCHEMA_V2: Record<string, string> = {
  ingredients: 'id, name, source, nameKey, *aliasKeys'
};

/**
 * How many times each schema upgrade has run in this process. Exists so the migration test
 * can assert "exactly once" across repeated opens; the app itself never reads it.
 */
export const upgradesRun = new Map<number, number>();

function recordUpgrade(version: number): void {
  upgradesRun.set(version, (upgradesRun.get(version) ?? 0) + 1);
}

/** The normalized keys derived from an ingredient's name and aliases. */
export function ingredientIndexKeys(ingredient: Ingredient): Pick<
  IngredientRecord,
  'nameKey' | 'aliasKeys'
> {
  return {
    nameKey: normalizeKey(ingredient.name),
    aliasKeys: ingredient.aliases.map(normalizeKey).filter((key) => key.length > 0)
  };
}

/** Wire shape -> stored row. */
export function toIngredientRecord(ingredient: Ingredient): IngredientRecord {
  return { ...ingredient, ...ingredientIndexKeys(ingredient) };
}

/** Stored row -> wire shape, with the local-only index keys dropped. */
export function fromIngredientRecord(record: IngredientRecord): Ingredient {
  return {
    id: record.id,
    name: record.name,
    aliases: record.aliases,
    state: record.state,
    per100g: record.per100g,
    source: record.source
  };
}

export class EatMyWayDb extends Dexie {
  ingredients!: Table<IngredientRecord, string>;
  recipes!: Table<Recipe, string>;
  tags!: Table<Tag, string>;
  days!: Table<Day, string>;
  /** Single row, outbound key `PROFILE_KEY`. */
  profile!: Table<Profile, number>;
  /** Key/value bookkeeping, outbound keys from `MetaKey`. */
  meta!: Table<unknown, MetaKey>;

  constructor(name: string = DB_NAME) {
    super(name);

    this.version(1).stores(SCHEMA_V1);

    this.version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        recordUpgrade(2);
        // Backfill the new index keys for ingredients written under version 1.
        await tx
          .table<IngredientRecord>('ingredients')
          .toCollection()
          .modify((row) => {
            Object.assign(row, ingredientIndexKeys(row));
          });
        await tx.table('meta').put(2, 'schemaVersion' satisfies MetaKey);
      });

    // Runs only for a database created from scratch — never on an upgrade.
    this.on('populate', (tx: Transaction) => {
      tx.table('profile').put(DEFAULT_PROFILE, PROFILE_KEY);
      tx.table('meta').put(SCHEMA_VERSION, 'schemaVersion' satisfies MetaKey);
      tx.table('meta').put(new Date().toISOString(), 'createdAt' satisfies MetaKey);
    });
  }
}

/** The application-wide handle. Tests create their own instances instead. */
export const db = new EatMyWayDb();
