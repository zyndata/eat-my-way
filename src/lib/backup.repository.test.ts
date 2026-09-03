import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from './repository';
import type { EatMyWayDb } from './db';
import { buildBackup, readBackup } from './backup';
import { chicken, egg, freshDb, ingredients, macros, makeRecipe } from '../test/fixtures';

/**
 * The round trip PLAN.md's Phase 8 acceptance asks for: an exported file read back into a
 * *fresh* profile, with nothing of the old database left behind.
 *
 * The two databases here are what "a different device" means for this app — nothing about a
 * backup depends on the machine it is restored on.
 */

let source: EatMyWayDb;
let target: EatMyWayDb;
let from: Repository;
let into: Repository;

beforeEach(async () => {
  source = freshDb();
  target = freshDb();
  await source.open();
  await target.open();
  from = createRepository(source);
  into = createRepository(target);
});

afterEach(async () => {
  await source.delete();
  await target.delete();
});

/** A database with a recipe, a planned day, a custom ingredient and a correction in it. */
async function seed(repo: Repository): Promise<void> {
  await repo.putIngredients(ingredients);
  await repo.putIngredient({
    id: 'custom:1',
    name: 'Twaróg półtłusty',
    aliases: ['twarog'],
    state: 'raw',
    per100g: macros(130, 18, 3, 4),
    source: 'custom'
  });
  await repo.saveRecipe(makeRecipe({ tags: ['sniadanie'] }), ['Śniadanie']);
  await repo.setGoals(macros(1800, 120, 180, 60));
  await repo.addRecipeToDay('2026-09-07', 'recipe-1');
  await repo.putCorrection({
    nameKey: 'twarog',
    ingredientId: 'custom:1',
    updatedAt: '2026-09-01T10:00:00.000Z'
  });
}

describe('export and restore', () => {
  it('re-creates the whole database in a fresh profile', async () => {
    await seed(from);
    await into.putIngredients(ingredients);

    const file = JSON.stringify(buildBackup(await from.backupInput()));
    await into.restoreBackup(readBackup(file));

    expect(await into.getProfile()).toEqual(await from.getProfile());
    expect(await into.allRecipes()).toEqual(await from.allRecipes());
    expect(await into.allTags()).toEqual(await from.allTags());
    expect(await into.allCorrections()).toEqual(await from.allCorrections());
    expect(await into.getDay('2026-09-07')).toEqual(await from.getDay('2026-09-07'));
  });

  it('keeps the restored meal on its frozen macros', async () => {
    await seed(from);
    await into.putIngredients(ingredients);

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    const original = (await from.getDay('2026-09-07')).meals.at(0);
    const restored = (await into.getDay('2026-09-07')).meals.at(0);
    expect(restored?.macroSnapshot).toEqual(original?.macroSnapshot);
    expect(restored?.macroSnapshot).toBeDefined();
  });

  it('replaces what the device already had rather than merging into it', async () => {
    await seed(from);
    // The target has a different recipe and a different day, and neither may survive.
    await into.putIngredients(ingredients);
    await into.saveRecipe(makeRecipe({ id: 'recipe-9', name: 'Coś innego' }));
    await into.addRecipeToDay('2026-08-20', 'recipe-9');

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    const recipes = await into.allRecipes();
    expect(recipes.map((recipe) => recipe.id)).toEqual(['recipe-1']);
    expect((await into.getDay('2026-08-20')).meals).toEqual([]);
  });

  it('carries the user\'s own ingredients and leaves the bundled ones alone', async () => {
    await seed(from);
    // A fresh install has the USDA subset; it ships in the build and is not in the file.
    await into.putIngredients([chicken, egg]);

    const backup = readBackup(JSON.stringify(buildBackup(await from.backupInput())));
    expect(backup.ingredients.map((ingredient) => ingredient.id)).toEqual(['custom:1']);

    await into.restoreBackup(backup);

    expect((await into.ingredientsByIds(['custom:1']))[0]?.name).toBe('Twaróg półtłusty');
    expect((await into.ingredientsByIds([chicken.id]))[0]?.name).toBe(chicken.name);
  });

  it('leaves no sync baseline behind, so the next sync unions instead of deleting', async () => {
    await seed(from);
    await into.setSyncBaseline(new Map([['recipe:recipe-9', 'stale-hash']]));

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    expect(await into.syncBaseline()).toEqual(new Map());
    expect(await into.driveFiles()).toEqual(new Map());
  });

  it('restores a recipe whose ingredients came from the bundle', async () => {
    await seed(from);
    await into.putIngredients(ingredients);

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    const restored = await into.getRecipe('recipe-1');
    expect(restored?.items.map((row) => row.ingredientId)).toEqual([chicken.id, egg.id]);
    expect(await into.recipeMacros([restored!])).toEqual(await from.recipeMacros([restored!]));
  });

  it('brings the vault and the list settings across, so nothing is left to retype', async () => {
    await seed(from);
    await from.setMeta('vaultFile', '{"v":1,"cipher":"sealed"}');
    await from.setMeta('recipeSort', 'kcal');
    await from.setMeta('recipeGrouped', true);
    await into.putIngredients(ingredients);

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    expect(await into.getMeta('vaultFile')).toBe('{"v":1,"cipher":"sealed"}');
    expect(await into.getMeta('recipeSort')).toBe('kcal');
    expect(await into.getMeta('recipeGrouped')).toBe(true);
  });

  it('swaps a vault rather than overwriting it, so the exchange can be undone', async () => {
    await seed(from);
    await from.setMeta('vaultFile', '{"v":1,"cipher":"z pliku"}');
    await into.putIngredients(ingredients);
    // The restoring device holds a vault of its own, possibly with another master password.
    await into.setMeta('vaultFile', '{"v":1,"cipher":"tutejszy"}');

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    expect(await into.getMeta('vaultFile')).toBe('{"v":1,"cipher":"z pliku"}');
    expect(await into.getMeta('vaultFileReplaced')).toBe('{"v":1,"cipher":"tutejszy"}');
  });

  it('leaves this device its own identity: googleSub, deviceId and the account label', async () => {
    await seed(from);
    await from.saveProfile({ ...(await from.getProfile()), googleSub: 'konto-A' });
    await into.putIngredients(ingredients);
    await into.saveProfile({ ...(await into.getProfile()), googleSub: 'konto-B' });
    await into.setMeta('deviceId', 'to-urzadzenie');
    await into.setMeta('driveAccountLabel', 'b@example.com');

    await into.restoreBackup(readBackup(JSON.stringify(buildBackup(await from.backupInput()))));

    // Otherwise a copy restored onto a machine connected elsewhere would fake the
    // wrong-account check, and two devices would share one Gemini tally key.
    expect((await into.getProfile()).googleSub).toBe('konto-B');
    expect(await into.getMeta('deviceId')).toBe('to-urzadzenie');
    expect(await into.getMeta('driveAccountLabel')).toBe('b@example.com');
  });

  it('does not resurrect an empty day as a row', async () => {
    await seed(from);
    const backup = readBackup(JSON.stringify(buildBackup(await from.backupInput())));
    backup.days.push({ date: '2026-09-08', meals: [] });

    await into.putIngredients(ingredients);
    await into.restoreBackup(backup);

    expect(await into.getDays('2026-09-08', '2026-09-08')).toEqual([]);
  });
});
