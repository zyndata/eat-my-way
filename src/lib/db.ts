import Dexie, { type Table, type Transaction } from 'dexie';
import type { Day, Ingredient, Macros, Profile, Recipe, Tag } from './types';
import type { IngredientCorrection } from './sync/documents';
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
export const SCHEMA_VERSION = 3;

/** The profile is a single row under a fixed outbound key. */
export const PROFILE_KEY = 1;

/** Defaults for a profile the user has not filled in yet (PLAN.md first-run wizard). */
export const DEFAULT_GOALS: Macros = { kcal: 2000, protein: 100, carbs: 250, fat: 70 };

/**
 * Free-tier catalogs change, so this is a default, never a hardcoded assumption — and it has
 * already changed once. PLAN.md named `gemini-2.5-flash`; against a key issued now, that model
 * is still listed by `models.list` but `generateContent` answers 404 „no longer available to
 * new users", so the import failed every time (STATE.md decision 120). Settings still override
 * it, and `client.ts` reads Google's own replacement out of a 404 and names it to the user.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

/**
 * The default this app shipped before `gemini-3.6-flash`, and the only model name it will ever
 * overwrite on its own (STATE.md decision 123).
 *
 * A profile created by an earlier build stores `gemini-2.5-flash` because *this app* put it
 * there, not because anyone chose it — and it now 404s, so that profile can never import
 * anything until someone edits the field by hand. Migrating exactly this one value is a fix to
 * our own bad default; a model the user actually typed is never touched, and no catalogue of
 * Google's retired models is hardcoded anywhere (PLAN.md: „free-tier catalogs change").
 */
export const PREVIOUS_DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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
  /**
   * The raw text of `vault.json` as this device last saw it. The vault is opaque to the rest
   * of the app and must be readable offline, so it is cached here verbatim rather than being
   * unpacked into rows.
   */
  vaultFile: string;
  /**
   * The `vault.json` this device held just before sync adopted Drive's copy (STATE.md
   * decision 93), kept so the swap can be undone — the two files may have different master
   * passwords, in which case the adopted one cannot be opened here at all (decision 150).
   * Absent whenever there is nothing to undo. It never leaves the device.
   */
  vaultFileReplaced: string;
  /** Display name of the connected Drive account. Identity itself lives in `Profile.googleSub`. */
  driveAccountLabel: string;
  /**
   * Random id for this device, minted on first use and never sent anywhere except into this
   * account's own `profile.json`, as the key of its Gemini usage tally. It identifies a browser
   * profile to its own owner and nothing else — no fingerprinting, no cross-account meaning.
   */
  deviceId: string;
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
 * Version 3 adds what sync needs (Phase 6): the per-entity baseline hashes the three-way
 * merge compares against, the Drive version of each file, and the Polish-name corrections
 * that travel in `ingredients.json`.
 */
export const SCHEMA_V3: Record<string, string> = {
  syncBaseline: 'key',
  driveFiles: 'name',
  corrections: 'nameKey'
};

/** One entity's content hash as of the last successful sync. See `sync/merge.ts`. */
export interface SyncBaselineRow {
  /** Namespaced: `day:2026-09-03`, `recipe:<id>`, `profile`, … */
  key: string;
  hash: string;
}

/** The Drive identity and version of one logical file. */
export interface DriveFileRow {
  /** Logical name, e.g. `days/2026-09.json`. */
  name: string;
  fileId: string;
  modifiedTime: string;
}

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
  /** Content hashes at the last successful sync — the baseline of the three-way merge. */
  syncBaseline!: Table<SyncBaselineRow, string>;
  /** Drive file ids and `modifiedTime`s, so a sync knows what it last saw. */
  driveFiles!: Table<DriveFileRow, string>;
  /** Polish name -> ingredient id, taught by the user (Phase 7, synced from Phase 6). */
  corrections!: Table<IngredientCorrection, string>;

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

    this.version(3)
      .stores(SCHEMA_V3)
      .upgrade(async (tx) => {
        recordUpgrade(3);
        // The new tables start empty: an unsynced device has no baseline, which is exactly
        // "nothing has ever been synced" and makes the first merge take both sides.
        await tx.table('meta').put(3, 'schemaVersion' satisfies MetaKey);
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
