import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from '../db';
import { DEFAULT_GEMINI_MODEL, PREVIOUS_DEFAULT_GEMINI_MODEL } from '../db';
import { createRepository, type Repository } from '../repository';
import { freshDb } from '../../test/fixtures';
import { migrateRetiredDefaultModel } from './migrate';

let db: EatMyWayDb;
let repo: Repository;

beforeEach(async () => {
  db = freshDb();
  await db.open();
  repo = createRepository(db);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('the retired-default migration', () => {
  it('replaces the default this app itself shipped', async () => {
    const profile = await repo.getProfile();
    await repo.saveProfile({ ...profile, geminiModel: PREVIOUS_DEFAULT_GEMINI_MODEL });

    expect(await migrateRetiredDefaultModel(repo)).toBe(true);
    expect((await repo.getProfile()).geminiModel).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('leaves a model the user typed alone, even a 2.5 one', async () => {
    const profile = await repo.getProfile();
    await repo.saveProfile({ ...profile, geminiModel: 'gemini-2.5-pro' });

    expect(await migrateRetiredDefaultModel(repo)).toBe(false);
    expect((await repo.getProfile()).geminiModel).toBe('gemini-2.5-pro');
  });

  it('changes nothing on a profile that is already current', async () => {
    expect(await migrateRetiredDefaultModel(repo)).toBe(false);
    expect((await repo.getProfile()).geminiModel).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('touches nothing else in the profile', async () => {
    const goals = { kcal: 1800, protein: 140, carbs: 180, fat: 55 };
    await repo.saveProfile({
      goals,
      geminiModel: PREVIOUS_DEFAULT_GEMINI_MODEL,
      encryptVault: false,
      locale: 'pl',
      googleSub: 'sub-42'
    });

    await migrateRetiredDefaultModel(repo);

    const after = await repo.getProfile();
    expect(after.goals).toEqual(goals);
    expect(after.encryptVault).toBe(false);
    expect(after.googleSub).toBe('sub-42');
  });

  it('is idempotent', async () => {
    const profile = await repo.getProfile();
    await repo.saveProfile({ ...profile, geminiModel: PREVIOUS_DEFAULT_GEMINI_MODEL });

    expect(await migrateRetiredDefaultModel(repo)).toBe(true);
    expect(await migrateRetiredDefaultModel(repo)).toBe(false);
  });
});
