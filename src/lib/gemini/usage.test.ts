import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from '../db';
import { createRepository, type Repository } from '../repository';
import { freshDb } from '../../test/fixtures';
import { geminiUsageByModel, mergeGeminiUsage, modelGeminiUsage, readGeminiUsage } from '../sync/documents';
import { addUsage, deviceId, quotaDay, recordGeminiUsage } from './usage';

describe('quotaDay', () => {
  it('follows Google’s reset zone, not the browser’s', () => {
    // 05:00 UTC on 2 September is 22:00 on 1 September in Los Angeles (PDT, UTC-7), so the
    // free-tier quota has not reset yet — while in Warsaw it is already 07:00 on the 2nd.
    // Bucketing by local date would show a fresh day against an exhausted window.
    expect(quotaDay(new Date('2026-09-02T05:00:00Z'))).toBe('2026-09-01');
    expect(quotaDay(new Date('2026-09-02T05:00:00Z'))).not.toBe('2026-09-02');
  });

  it('rolls over at Pacific midnight', () => {
    expect(quotaDay(new Date('2026-09-02T06:59:00Z'))).toBe('2026-09-01');
    expect(quotaDay(new Date('2026-09-02T07:01:00Z'))).toBe('2026-09-02');
  });
});

describe('addUsage', () => {
  const TODAY = '2026-09-01';
  const M = 'gemini-3.6-flash';

  it('starts a tally for a device that has spent nothing', () => {
    expect(addUsage(undefined, 'dev-a', { requests: 2, tokens: 900 }, TODAY, M)).toEqual({
      day: TODAY,
      models: { [M]: { 'dev-a': { requests: 2, tokens: 900 } } }
    });
  });

  it('adds to this device without touching another’s', () => {
    const before = {
      day: TODAY,
      models: { [M]: { 'dev-a': { requests: 2, tokens: 900 }, 'dev-b': { requests: 5, tokens: 10 } } }
    };

    expect(addUsage(before, 'dev-a', { requests: 3, tokens: 100 }, TODAY, M)).toEqual({
      day: TODAY,
      models: { [M]: { 'dev-a': { requests: 5, tokens: 1000 }, 'dev-b': { requests: 5, tokens: 10 } } }
    });
  });

  it('keeps models apart, because the quota is charged per model', () => {
    const before = { day: TODAY, models: { [M]: { 'dev-a': { requests: 20, tokens: 100 } } } };

    const after = addUsage(before, 'dev-a', { requests: 1, tokens: 5 }, TODAY, 'gemini-3.5-flash-lite');

    expect(modelGeminiUsage(after, M).requests).toBe(20);
    expect(modelGeminiUsage(after, 'gemini-3.5-flash-lite').requests).toBe(1);
  });

  it('drops yesterday’s tally rather than carrying it into a new window', () => {
    const yesterday = { day: '2026-08-31', models: { [M]: { 'dev-a': { requests: 19, tokens: 5000 } } } };

    expect(addUsage(yesterday, 'dev-a', { requests: 1, tokens: 20 }, TODAY, M)).toEqual({
      day: TODAY,
      models: { [M]: { 'dev-a': { requests: 1, tokens: 20 } } }
    });
  });
});

describe('mergeGeminiUsage', () => {
  const TODAY = '2026-09-01';
  const M = 'gemini-3.6-flash';

  it('sums two devices that each counted their own spend', () => {
    const a = { day: TODAY, models: { [M]: { 'dev-a': { requests: 3, tokens: 300 } } } };
    const b = { day: TODAY, models: { [M]: { 'dev-b': { requests: 4, tokens: 400 } } } };

    expect(modelGeminiUsage(mergeGeminiUsage(a, b), M)).toEqual({ requests: 7, tokens: 700 });
  });

  it('keeps a model only one side has heard of', () => {
    const a = { day: TODAY, models: { [M]: { 'dev-a': { requests: 3, tokens: 300 } } } };
    const b = { day: TODAY, models: { lite: { 'dev-b': { requests: 4, tokens: 400 } } } };

    const merged = mergeGeminiUsage(a, b);

    expect(modelGeminiUsage(merged, M).requests).toBe(3);
    expect(modelGeminiUsage(merged, 'lite').requests).toBe(4);
  });

  it('takes the larger count when both sides saw the same device', () => {
    // The counter only grows within a day, so the bigger number is the later one.
    const stale = { day: TODAY, models: { [M]: { 'dev-a': { requests: 2, tokens: 200 } } } };
    const fresh = { day: TODAY, models: { [M]: { 'dev-a': { requests: 5, tokens: 500 } } } };

    expect(mergeGeminiUsage(fresh, stale)).toEqual(fresh);
    expect(mergeGeminiUsage(stale, fresh)).toEqual(fresh);
  });

  it('never lets an older window overwrite a newer one', () => {
    const yesterday = { day: '2026-08-31', models: { [M]: { 'dev-a': { requests: 19, tokens: 1 } } } };
    const today = { day: TODAY, models: { [M]: { 'dev-b': { requests: 1, tokens: 1 } } } };

    expect(mergeGeminiUsage(yesterday, today)).toEqual(today);
    expect(mergeGeminiUsage(today, yesterday)).toEqual(today);
  });

  it('handles either side being absent', () => {
    const only = { day: TODAY, models: { [M]: { 'dev-a': { requests: 1, tokens: 1 } } } };
    expect(mergeGeminiUsage(undefined, only)).toEqual(only);
    expect(mergeGeminiUsage(only, undefined)).toEqual(only);
    expect(mergeGeminiUsage(undefined, undefined)).toBeUndefined();
  });
});

describe('geminiUsageByModel', () => {
  it('lists the models spent on, heaviest first', () => {
    const usage = {
      day: '2026-09-01',
      models: {
        light: { 'dev-a': { requests: 1, tokens: 10 } },
        heavy: { 'dev-a': { requests: 9, tokens: 90 }, 'dev-b': { requests: 2, tokens: 20 } }
      }
    };

    expect(geminiUsageByModel(usage)).toEqual([
      { model: 'heavy', usage: { requests: 11, tokens: 110 } },
      { model: 'light', usage: { requests: 1, tokens: 10 } }
    ]);
  });
});

describe('readGeminiUsage', () => {
  it('drops a tally that is not one', () => {
    expect(readGeminiUsage(null)).toBeUndefined();
    expect(readGeminiUsage({ models: {} })).toBeUndefined();
    expect(readGeminiUsage({ day: '2026-09-01' })).toBeUndefined();
  });

  it('skips a device row with negative counts and keeps the rest', () => {
    const usage = readGeminiUsage({
      day: '2026-09-01',
      models: { m: { good: { requests: 2, tokens: 5 }, bad: { requests: -1, tokens: 5 }, junk: 'nope' } }
    });

    expect(usage).toEqual({ day: '2026-09-01', models: { m: { good: { requests: 2, tokens: 5 } } } });
  });

  it('ignores the pre-model shape rather than importing it as a model named "devices"', () => {
    // Shipped briefly on `dev` before the quota turned out to be per model. Worst case a
    // device loses one day of its own counting, which is not data anyone can miss.
    expect(readGeminiUsage({ day: '2026-09-01', devices: { 'dev-a': { requests: 3, tokens: 3 } } }))
      .toBeUndefined();
  });
});

describe('recordGeminiUsage', () => {
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

  it('writes this device’s spend into the profile', async () => {
    const now = new Date('2026-09-01T18:00:00Z');
    await recordGeminiUsage({ requests: 3, tokens: 1200 }, 'gemini-3.6-flash', { repository: repo, now });

    const usage = (await repo.getProfile()).geminiUsage;
    expect(usage?.day).toBe('2026-09-01');
    expect(modelGeminiUsage(usage, 'gemini-3.6-flash')).toEqual({ requests: 3, tokens: 1200 });
  });

  it('accumulates across imports under one device id', async () => {
    const now = new Date('2026-09-01T18:00:00Z');
    await recordGeminiUsage({ requests: 3, tokens: 1000 }, 'gemini-3.6-flash', { repository: repo, now });
    await recordGeminiUsage({ requests: 2, tokens: 500 }, 'gemini-3.6-flash', { repository: repo, now });

    const usage = (await repo.getProfile()).geminiUsage;
    expect(Object.keys(usage?.models['gemini-3.6-flash'] ?? {})).toHaveLength(1);
    expect(modelGeminiUsage(usage, 'gemini-3.6-flash')).toEqual({ requests: 5, tokens: 1500 });
  });

  it('records nothing when no request was answered', async () => {
    expect(await recordGeminiUsage({ requests: 0, tokens: 0 }, 'm', { repository: repo })).toBeUndefined();
    expect(await recordGeminiUsage({ requests: 2, tokens: 5 }, '  ', { repository: repo })).toBeUndefined();
    expect((await repo.getProfile()).geminiUsage).toBeUndefined();
  });

  it('keeps the same device id across calls', async () => {
    const first = await deviceId(repo);
    expect(await deviceId(repo)).toBe(first);
  });

  it('leaves the rest of the profile alone', async () => {
    const goals = { kcal: 1800, protein: 140, carbs: 180, fat: 55 };
    await repo.saveProfile({ goals, geminiModel: 'moj-model', encryptVault: false, locale: 'pl' });

    await recordGeminiUsage({ requests: 1, tokens: 10 }, 'moj-model', { repository: repo });

    const after = await repo.getProfile();
    expect(after.goals).toEqual(goals);
    expect(after.geminiModel).toBe('moj-model');
    expect(after.encryptVault).toBe(false);
  });
});
