import { afterEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from '../db';
import { createRepository, type Repository } from '../repository';
import { createSyncEngine, type DayConflict, type SyncEngine } from './engine';
import { FakeDrive, fakeBackend } from '../../test/fake-drive';
import { freshDb, macros, makeRecipe } from '../../test/fixtures';
import type { Day, PlannedMeal } from '../types';
import {
  INGREDIENTS_FILE,
  PROFILE_FILE,
  RECIPES_FILE,
  daysFileName,
  modelGeminiUsage
} from './documents';

/**
 * Two `Device`s over one `FakeDrive` are the two browsers PLAN.md's first acceptance
 * criterion talks about: same account, same folder, independent IndexedDB.
 */
interface Device {
  db: EatMyWayDb;
  repository: Repository;
  engine: SyncEngine;
  reads: string[];
}

const open: EatMyWayDb[] = [];

function device(drive: FakeDrive): Device {
  const db = freshDb();
  open.push(db);
  const repository = createRepository(db);
  const reads: string[] = [];
  return { db, repository, engine: createSyncEngine(fakeBackend(drive, { reads }), repository), reads };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.delete();
});

function meal(id: string, kcal: number): PlannedMeal {
  return {
    id,
    recipeId: 'recipe-1',
    cookingScale: 1,
    portionsEaten: 1,
    macroSnapshot: macros(kcal, 10, 10, 10)
  };
}

const day = (date: string, ...meals: PlannedMeal[]): Day => ({ date, meals });

/** Fails the test if the engine ever asks — used where no prompt is expected. */
const neverAsks = async (conflicts: DayConflict[]): Promise<null> => {
  throw new Error(`Unexpected conflict prompt for ${conflicts.map((c) => c.date).join(', ')}`);
};

describe('first sync', () => {
  it('uploads a local dataset into an empty folder', async () => {
    const drive = new FakeDrive();
    const a = device(drive);

    await a.repository.saveRecipe(makeRecipe());
    await a.repository.saveDay(day('2026-09-03', meal('m1', 400)));

    const outcome = await a.engine.sync();
    expect(outcome).toMatchObject({ status: 'ok', freshFolder: true });

    expect(Object.keys(drive.snapshot()).sort()).toEqual([
      daysFileName('2026-09'),
      INGREDIENTS_FILE,
      PROFILE_FILE,
      RECIPES_FILE
    ]);
    expect(drive.snapshot()[daysFileName('2026-09')]).toEqual({
      '2026-09-03': day('2026-09-03', meal('m1', 400))
    });
  });

  it('names the two waits in order, so a button can say which one it is in', async () => {
    // Drive reports no totals, so the stage names are the only progress there is to report
    // (STATE.md decision 194) — and „waiting on Google" must come before „reading your files",
    // or the label would be wrong for the whole of the longest wait the app ever has.
    const drive = new FakeDrive();
    const a = device(drive);
    const stages: string[] = [];

    await a.engine.sync({ onstage: (stage) => stages.push(stage) });

    expect(stages).toEqual(['authenticating', 'transferring']);
  });

  it('pulls the whole dataset onto a fresh device', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.saveRecipe(makeRecipe());
    await a.repository.saveDay(day('2026-09-03', meal('m1', 400)));
    await a.engine.sync();

    const b = device(drive);
    expect(await b.engine.sync()).toMatchObject({ status: 'ok', pulled: true, freshFolder: false });

    expect(await b.repository.getDay('2026-09-03')).toEqual(day('2026-09-03', meal('m1', 400)));
    expect((await b.repository.allRecipes()).map((recipe) => recipe.name)).toEqual([
      'Kurczak z jajkiem'
    ]);
  });

  /**
   * Reported after a cleared site: everything came back except the daily goals. A device
   * always holds a profile — the database seeds `DEFAULT_PROFILE` when it is created — so on
   * an empty baseline the untouched defaults read as „this side edited it too" and `localWins`
   * handed the account's real goals to a document nobody had written (STATE.md decision 227).
   */
  it('takes the goals from Drive onto a device that has only its defaults', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    const profile = await a.repository.getProfile();
    await a.repository.saveProfile({ ...profile, goals: macros(2600, 180, 240, 80) });
    await a.engine.sync();

    const b = device(drive);
    await b.engine.sync();

    expect((await b.repository.getProfile()).goals).toEqual(macros(2600, 180, 240, 80));
    // And the defaults must not have been pushed over the account's own goals on the way.
    expect((drive.snapshot()[PROFILE_FILE] as { goals: unknown }).goals).toEqual(
      macros(2600, 180, 240, 80)
    );
  });

  /** The other side of the same rule: goals this device's user actually set are not given up. */
  it('keeps goals the device set itself when the account has different ones', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    const profile = await a.repository.getProfile();
    await a.repository.saveProfile({ ...profile, goals: macros(2600, 180, 240, 80) });
    await a.engine.sync();

    // A second browser that planned on its own before ever connecting this account.
    const b = device(drive);
    const own = await b.repository.getProfile();
    await b.repository.saveProfile({ ...own, goals: macros(1800, 120, 150, 50) });
    await b.engine.sync();

    expect((await b.repository.getProfile()).goals).toEqual(macros(1800, 120, 150, 50));
  });

  it('is a no-op the second time, and downloads nothing that did not move', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.saveDay(day('2026-09-03', meal('m1', 400)));
    await a.engine.sync();

    a.reads.length = 0;
    expect(await a.engine.sync()).toMatchObject({ status: 'ok', pulled: false, pushed: false });
    expect(a.reads).toEqual([]);
  });
});

describe('two devices', () => {
  /** Both devices start from the same synced state. */
  async function paired(): Promise<[Device, Device, FakeDrive]> {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.saveRecipe(makeRecipe());
    await a.repository.saveDay(day('2026-09-03', meal('m1', 400)));
    await a.engine.sync();

    const b = device(drive);
    await b.engine.sync();
    return [a, b, drive];
  }

  it('merges edits to different days without any prompt', async () => {
    const [a, b] = await paired();

    await a.repository.saveDay(day('2026-09-04', meal('m2', 500)));
    await b.repository.saveDay(day('2026-09-05', meal('m3', 600)));

    expect(await a.engine.sync({ resolveConflicts: neverAsks })).toMatchObject({ status: 'ok' });
    expect(await b.engine.sync({ resolveConflicts: neverAsks })).toMatchObject({ status: 'ok' });
    // A second pass brings B's day back to A.
    expect(await a.engine.sync({ resolveConflicts: neverAsks })).toMatchObject({ status: 'ok' });

    for (const held of [a, b]) {
      expect((await held.repository.getDay('2026-09-04')).meals).toHaveLength(1);
      expect((await held.repository.getDay('2026-09-05')).meals).toHaveLength(1);
      expect((await held.repository.getDay('2026-09-03')).meals).toHaveLength(1);
    }
  });

  it('merges edits to days in different months without a prompt', async () => {
    const [a, b] = await paired();

    await a.repository.saveDay(day('2026-10-01', meal('m2', 500)));
    await b.repository.saveDay(day('2026-11-01', meal('m3', 600)));

    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });
    await a.engine.sync({ resolveConflicts: neverAsks });

    expect((await a.repository.getDay('2026-11-01')).meals).toHaveLength(1);
    expect((await b.repository.getDay('2026-10-01')).meals).toHaveLength(1);
  });

  it('prompts on the same day and honours "keep mine"', async () => {
    const [a, b] = await paired();

    await a.repository.saveDay(day('2026-09-03', meal('m1', 400), meal('mine', 111)));
    await a.engine.sync({ resolveConflicts: neverAsks });

    await b.repository.saveDay(day('2026-09-03', meal('m1', 400), meal('theirs', 222)));

    const asked: DayConflict[] = [];
    const outcome = await b.engine.sync({
      resolveConflicts: async (conflicts) => {
        asked.push(...conflicts);
        return new Map(conflicts.map((conflict) => [conflict.date, 'local' as const]));
      }
    });

    expect(outcome.status).toBe('ok');
    expect(asked.map((conflict) => conflict.date)).toEqual(['2026-09-03']);
    expect(asked[0]?.local?.meals.map((m) => m.id)).toEqual(['m1', 'theirs']);
    expect(asked[0]?.remote?.meals.map((m) => m.id)).toEqual(['m1', 'mine']);

    expect((await b.repository.getDay('2026-09-03')).meals.map((m) => m.id)).toEqual(['m1', 'theirs']);
    // The choice reached Drive, so A picks it up too.
    await a.engine.sync({ resolveConflicts: neverAsks });
    expect((await a.repository.getDay('2026-09-03')).meals.map((m) => m.id)).toEqual(['m1', 'theirs']);
  });

  it('honours "take the Drive version" and uploads nothing', async () => {
    const [a, b, drive] = await paired();

    await a.repository.saveDay(day('2026-09-03', meal('m1', 400), meal('mine', 111)));
    await a.engine.sync({ resolveConflicts: neverAsks });
    const afterA = drive.version(daysFileName('2026-09'))?.modifiedTime;

    await b.repository.saveDay(day('2026-09-03', meal('m1', 400), meal('theirs', 222)));
    await b.engine.sync({
      resolveConflicts: async (conflicts) =>
        new Map(conflicts.map((conflict) => [conflict.date, 'remote' as const]))
    });

    expect((await b.repository.getDay('2026-09-03')).meals.map((m) => m.id)).toEqual(['m1', 'mine']);
    expect(drive.version(daysFileName('2026-09'))?.modifiedTime).toBe(afterA);
  });

  it('writes nothing at all when the prompt is dismissed', async () => {
    const [a, b, drive] = await paired();

    await a.repository.saveDay(day('2026-09-03', meal('m1', 400), meal('mine', 111)));
    await a.engine.sync({ resolveConflicts: neverAsks });

    await b.repository.saveDay(day('2026-09-03', meal('theirs', 222)));
    const before = drive.snapshot();

    expect(await b.engine.sync({ resolveConflicts: async () => null })).toEqual({ status: 'cancelled' });

    expect(drive.snapshot()).toEqual(before);
    expect((await b.repository.getDay('2026-09-03')).meals.map((m) => m.id)).toEqual(['theirs']);
  });

  it('propagates a cleared day rather than resurrecting it', async () => {
    const [a, b] = await paired();

    await a.repository.clearDay('2026-09-03');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    expect((await b.repository.getDay('2026-09-03')).meals).toEqual([]);
  });

  it('resolves a recipe edited on both sides by its updatedAt, without asking', async () => {
    const [a, b] = await paired();

    await a.repository.saveRecipe(
      makeRecipe({ name: 'Wersja A', updatedAt: '2026-09-10T00:00:00.000Z' })
    );
    await a.engine.sync({ resolveConflicts: neverAsks });

    await b.repository.saveRecipe(
      makeRecipe({ name: 'Wersja B', updatedAt: '2026-09-11T00:00:00.000Z' })
    );
    await b.engine.sync({ resolveConflicts: neverAsks });

    await a.engine.sync({ resolveConflicts: neverAsks });
    expect((await a.repository.getRecipe('recipe-1'))?.name).toBe('Wersja B');
  });

  it('uploads only the ingredients the user created, never the bundled USDA rows', async () => {
    const [a, b, drive] = await paired();

    await a.repository.putIngredient({
      id: 'usda:999',
      name: 'Marchew',
      aliases: [],
      state: 'raw',
      per100g: macros(41, 1, 10, 0),
      source: 'usda'
    });
    await a.repository.putIngredient({
      id: 'custom:1',
      name: 'Sos babci',
      aliases: [],
      state: 'cooked',
      per100g: macros(300, 2, 5, 30),
      source: 'custom'
    });
    await a.engine.sync({ resolveConflicts: neverAsks });

    const uploaded = drive.snapshot()[INGREDIENTS_FILE] as { ingredients: { id: string }[] };
    expect(uploaded.ingredients.map((ingredient) => ingredient.id)).toEqual(['custom:1']);

    // The other device gains the custom ingredient and keeps its own bundled rows untouched.
    await b.engine.sync({ resolveConflicts: neverAsks });
    expect((await b.repository.getIngredient('custom:1'))?.name).toBe('Sos babci');
    expect(await b.repository.getIngredient('usda:999')).toBeUndefined();
  });

  it('converges on the newer edit of a custom ingredient, not on the local one', async () => {
    const [a, b] = await paired();

    const base = {
      id: 'custom:1',
      name: 'Twarog poltlusty',
      aliases: [],
      state: 'raw' as const,
      per100g: macros(130, 18, 3, 4),
      source: 'custom' as const
    };
    await a.repository.saveCustomIngredient(base, '2026-09-10T08:00:00.000Z');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    // Both devices correct the same row; B's edit is the later one.
    await a.repository.saveCustomIngredient(
      { ...base, name: 'Twaróg półtłusty' },
      '2026-09-11T08:00:00.000Z'
    );
    await b.repository.saveCustomIngredient(
      { ...base, name: 'Twaróg półtłusty 3%' },
      '2026-09-12T08:00:00.000Z'
    );

    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });
    await a.engine.sync({ resolveConflicts: neverAsks });

    expect((await a.repository.getIngredient('custom:1'))?.name).toBe('Twaróg półtłusty 3%');
    expect((await b.repository.getIngredient('custom:1'))?.name).toBe('Twaróg półtłusty 3%');
  });

  it('propagates a deleted custom ingredient rather than resurrecting it', async () => {
    const [a, b] = await paired();

    await a.repository.saveCustomIngredient({
      id: 'custom:1',
      name: 'Sos babci',
      aliases: [],
      state: 'cooked',
      per100g: macros(300, 2, 5, 30),
      source: 'custom'
    });
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });
    expect(await b.repository.getIngredient('custom:1')).toBeDefined();

    await a.repository.deleteIngredient('custom:1');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    // B still held the row, and must not push it back onto A.
    expect(await b.repository.getIngredient('custom:1')).toBeUndefined();
    await a.engine.sync({ resolveConflicts: neverAsks });
    expect(await a.repository.getIngredient('custom:1')).toBeUndefined();
  });

  it('carries a replacement across as a recipe change and a deletion in one sync', async () => {
    const [a, b] = await paired();

    for (const ingredient of [
      { id: 'custom:1', name: 'Twarog' },
      { id: 'custom:2', name: 'Twaróg półtłusty' }
    ]) {
      await a.repository.saveCustomIngredient({
        ...ingredient,
        aliases: [],
        state: 'raw',
        per100g: macros(130, 18, 3, 4),
        source: 'custom'
      });
    }
    await a.repository.saveRecipe(
      makeRecipe({ items: [{ ingredientId: 'custom:1', amount: 200, unit: 'g' }] })
    );
    await a.repository.putCorrection({
      nameKey: 'twarog',
      ingredientId: 'custom:1',
      updatedAt: '2026-09-01T10:00:00.000Z'
    });
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    await a.repository.replaceIngredient('custom:1', 'custom:2', '2026-09-12T08:00:00.000Z');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    expect(await b.repository.getIngredient('custom:1')).toBeUndefined();
    expect((await b.repository.getRecipe('recipe-1'))?.items[0]?.ingredientId).toBe('custom:2');
    expect((await b.repository.allCorrections())[0]?.ingredientId).toBe('custom:2');
  });

  /**
   * A rename that only changes the spelling touches no recipe, and the upload used to be gated
   * on recipes alone — so it never left the device; and the other device discarded the remote
   * label anyway. The two disagreed for good (STATE.md decision 229).
   */
  it('carries a tag rename to the other device', async () => {
    const [a, b] = await paired();

    await a.repository.saveRecipe(makeRecipe({ tags: ['obiad'] }));
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    await a.repository.renameTag('obiad', 'Obiad');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    expect((await b.repository.allTags())[0]?.label).toBe('Obiad');
    // And it stays renamed: B must not push its old spelling back over A's.
    await a.engine.sync({ resolveConflicts: neverAsks });
    expect((await a.repository.allTags())[0]?.label).toBe('Obiad');
  });

  it('carries a tag deletion, and leaves a tag no recipe uses alone', async () => {
    const [a, b] = await paired();

    await a.repository.saveRecipe(makeRecipe({ tags: ['obiad', 'szybkie'] }));
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    await a.repository.deleteTag('szybkie');
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    expect((await b.repository.allTags()).map((tag) => tag.key)).toEqual(['obiad']);

    // Taking a tag off the last recipe that carried it is not deleting it: the row stays, at
    // zero uses, and a sync must not quietly finish the job the user did not ask for.
    await a.repository.saveRecipe(makeRecipe({ tags: [] }));
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    for (const target of [a, b]) {
      expect((await target.repository.allTags()).map((tag) => tag.key)).toEqual(['obiad']);
    }
  });

  it('sums the Gemini tally from both devices instead of letting one overwrite the other', async () => {
    const [a, b] = await paired();
    const day = '2026-09-01';

    // Each device counts only its own spend, which is what makes the union safe.
    const spend = async (device: typeof a, id: string, requests: number, tokens: number) => {
      const profile = await device.repository.getProfile();
      await device.repository.saveProfile({
        ...profile,
        geminiUsage: { day, models: { 'gemini-3.6-flash': { [id]: { requests, tokens } } } }
      });
    };

    await spend(a, 'dev-a', 3, 300);
    await spend(b, 'dev-b', 4, 400);

    // Both edited the profile, so this is exactly the conflict `localWins` would resolve by
    // discarding one side's count.
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });
    await a.engine.sync({ resolveConflicts: neverAsks });

    for (const device of [a, b]) {
      const usage = (await device.repository.getProfile()).geminiUsage;
      expect(modelGeminiUsage(usage, 'gemini-3.6-flash')).toEqual({ requests: 7, tokens: 700 });
    }
  });

  it('does not resurrect a tally from a closed quota day', async () => {
    const [a, b] = await paired();

    const stale = await a.repository.getProfile();
    await a.repository.saveProfile({
      ...stale,
      geminiUsage: { day: '2026-08-31', models: { m: { 'dev-a': { requests: 19, tokens: 9000 } } } }
    });
    await a.engine.sync({ resolveConflicts: neverAsks });

    const fresh = await b.repository.getProfile();
    await b.repository.saveProfile({
      ...fresh,
      geminiUsage: { day: '2026-09-01', models: { m: { 'dev-b': { requests: 2, tokens: 200 } } } }
    });
    await b.engine.sync({ resolveConflicts: neverAsks });
    await a.engine.sync({ resolveConflicts: neverAsks });

    const usage = (await a.repository.getProfile()).geminiUsage;
    expect(usage?.day).toBe('2026-09-01');
    expect(modelGeminiUsage(usage, 'm')).toEqual({ requests: 2, tokens: 200 });
  });

  it('carries a name correction across, so a repeat import matches the same way', async () => {
    const [a, b] = await paired();

    await a.repository.putCorrection({
      nameKey: 'papryka czerwona',
      ingredientId: 'usda:11821',
      updatedAt: '2026-09-04T10:00:00.000Z'
    });
    await a.engine.sync({ resolveConflicts: neverAsks });
    await b.engine.sync({ resolveConflicts: neverAsks });

    expect(await b.repository.allCorrections()).toEqual([
      { nameKey: 'papryka czerwona', ingredientId: 'usda:11821', updatedAt: '2026-09-04T10:00:00.000Z' }
    ]);
  });
});

describe('account safety', () => {
  it('refuses to sync into a different Google account', async () => {
    const drive = new FakeDrive();
    const db = freshDb();
    open.push(db);
    const repository = createRepository(db);

    await repository.saveProfile({ ...(await repository.getProfile()), googleSub: 'account-old' });
    const engine = createSyncEngine(fakeBackend(drive, { account: { id: 'account-new' } }), repository);

    expect(await engine.sync()).toEqual({
      status: 'foreign-account',
      account: { id: 'account-new' },
      storedSub: 'account-old'
    });
    // Nothing was read or written on either side.
    expect(drive.files.size).toBe(0);
  });

  it('proceeds once the user accepts the new account, keeping local data', async () => {
    const drive = new FakeDrive();
    const db = freshDb();
    open.push(db);
    const repository = createRepository(db);

    await repository.saveProfile({ ...(await repository.getProfile()), googleSub: 'account-old' });
    await repository.saveDay(day('2026-09-03', meal('m1', 400)));
    const engine = createSyncEngine(fakeBackend(drive, { account: { id: 'account-1' } }), repository);

    expect(await engine.sync({ acceptAccount: true })).toMatchObject({ status: 'ok' });
    expect((await repository.getProfile()).googleSub).toBe('account-1');
    expect((await repository.getDay('2026-09-03')).meals).toHaveLength(1);
  });
});

describe('the vault', () => {
  it('uploads a locally created vault and hands it to the other device', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.setMeta('vaultFile', '{"v":1,"kdf":"none","data":{"geminiApiKey":"k"}}');
    await a.engine.sync();

    const b = device(drive);
    expect(await b.engine.sync()).toMatchObject({ status: 'ok', vaultAdopted: true });
    expect(await b.repository.getMeta('vaultFile')).toContain('geminiApiKey');
  });

  it('lets the Drive copy win when both sides changed it', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.setMeta('vaultFile', '{"v":1,"kdf":"none","data":{"geminiApiKey":"first"}}');
    await a.engine.sync();

    const b = device(drive);
    await b.engine.sync();

    await a.repository.setMeta('vaultFile', '{"v":1,"kdf":"none","data":{"geminiApiKey":"from-a"}}');
    await a.engine.sync();
    await b.repository.setMeta('vaultFile', '{"v":1,"kdf":"none","data":{"geminiApiKey":"from-b"}}');

    expect(await b.engine.sync()).toMatchObject({ status: 'ok', vaultAdopted: true });
    expect(await b.repository.getMeta('vaultFile')).toContain('from-a');
    // Decision 150: what the adoption overwrote is kept locally so the swap can be undone.
    expect(await b.repository.getMeta('vaultFileReplaced')).toContain('from-b');
  });

  it('keeps nothing to undo when the device had no vault of its own', async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.repository.setMeta('vaultFile', '{"v":1,"kdf":"none","data":{"geminiApiKey":"k"}}');
    await a.engine.sync();

    const b = device(drive);
    expect(await b.engine.sync()).toMatchObject({ status: 'ok', vaultAdopted: true });
    expect(await b.repository.getMeta('vaultFileReplaced')).toBeUndefined();
  });
});
