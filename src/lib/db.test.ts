import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import {
  DEFAULT_PROFILE,
  EatMyWayDb,
  PROFILE_KEY,
  SCHEMA_V1,
  SCHEMA_VERSION,
  fromIngredientRecord,
  toIngredientRecord,
  upgradesRun
} from './db';
import type { Ingredient } from './types';
import { freshDb, macros } from '../test/fixtures';

const salmon: Ingredient = {
  id: 'usda:9',
  name: 'Łosoś wędzony',
  aliases: ['ryba wędzona'],
  state: 'raw',
  per100g: macros(200, 20, 0, 13),
  source: 'usda'
};

beforeEach(() => {
  upgradesRun.clear();
});

describe('a database created from scratch', () => {
  it('opens at the latest schema version', async () => {
    const db = freshDb();
    await db.open();

    expect(db.verno).toBe(SCHEMA_VERSION);
    await db.delete();
  });

  it('seeds the default profile and the schema bookkeeping', async () => {
    const db = freshDb();
    await db.open();

    expect(await db.profile.get(PROFILE_KEY)).toEqual(DEFAULT_PROFILE);
    expect(await db.meta.get('schemaVersion')).toBe(SCHEMA_VERSION);
    expect(await db.meta.get('createdAt')).toEqual(expect.any(String));
    await db.delete();
  });

  it('runs no upgrade at all — populate is not a migration', async () => {
    const db = freshDb();
    await db.open();

    expect(upgradesRun.size).toBe(0);
    await db.delete();
  });
});

describe('the version 2 migration', () => {
  /** A database as version 1 left it: ingredients with no normalized index keys. */
  async function createLegacyDatabase(name: string): Promise<void> {
    const legacy = new Dexie(name);
    legacy.version(1).stores(SCHEMA_V1);
    await legacy.open();
    await legacy.table('ingredients').put(salmon);
    legacy.close();
  }

  it('runs exactly once, no matter how often the database is reopened', async () => {
    const name = `test-${crypto.randomUUID()}`;
    await createLegacyDatabase(name);

    const upgraded = new EatMyWayDb(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(2);
    expect(upgradesRun.get(2)).toBe(1);
    upgraded.close();

    const reopened = new EatMyWayDb(name);
    await reopened.open();
    expect(reopened.verno).toBe(2);
    expect(upgradesRun.get(2)).toBe(1);

    const thirdOpen = new EatMyWayDb(name);
    await thirdOpen.open();
    expect(upgradesRun.get(2)).toBe(1);

    reopened.close();
    await thirdOpen.delete();
  });

  it('backfills the normalized keys of rows written under version 1', async () => {
    const name = `test-${crypto.randomUUID()}`;
    await createLegacyDatabase(name);

    const db = new EatMyWayDb(name);
    await db.open();
    const row = await db.ingredients.get(salmon.id);

    expect(row?.nameKey).toBe('losos wedzony');
    expect(row?.aliasKeys).toEqual(['ryba wedzona']);
    expect(await db.meta.get('schemaVersion')).toBe(2);
    await db.delete();
  });

  it('makes the backfilled key searchable without diacritics', async () => {
    const name = `test-${crypto.randomUUID()}`;
    await createLegacyDatabase(name);

    const db = new EatMyWayDb(name);
    await db.open();
    const hits = await db.ingredients.where('nameKey').startsWith('loso').toArray();

    expect(hits.map((row) => row.id)).toEqual([salmon.id]);
    await db.delete();
  });
});

describe('ingredient records', () => {
  it('add index keys on write and drop them again on read', async () => {
    const db = freshDb();
    await db.open();
    await db.ingredients.put(toIngredientRecord(salmon));

    const stored = await db.ingredients.get(salmon.id);
    expect(stored?.nameKey).toBe('losos wedzony');
    // What goes to Drive in Phase 6 must be the spec shape, index keys stripped.
    expect(fromIngredientRecord(stored!)).toEqual(salmon);

    await db.delete();
  });

  it('index an alias list into a multi-entry index', async () => {
    const db = freshDb();
    await db.open();
    await db.ingredients.put(toIngredientRecord(salmon));

    const hits = await db.ingredients.where('aliasKeys').equals('ryba wedzona').toArray();
    expect(hits).toHaveLength(1);

    await db.delete();
  });
});
