import { describe, expect, it } from 'vitest';
import { readMealPlan, readProfileDocument } from './documents';
import { DEFAULT_PROFILE } from '../db';

/**
 * The `profile.json` reader, and the Phase 13 field it had to learn.
 *
 * `readProfileDocument` enumerates the profile's fields rather than passing the object
 * through, so every optional addition needs a reader of its own or it is silently dropped on
 * the next sync (STATE.md decision 274).
 */

const PROFILE_JSON = {
  goals: { kcal: 2000, protein: 120, carbs: 220, fat: 70 },
  geminiModel: 'gemini-2.5-flash',
  encryptVault: false,
  locale: 'pl'
};

describe('readMealPlan', () => {
  it('reads a template back exactly as it was written', () => {
    const plan = {
      slots: [{ id: 'obiad', label: 'Obiad', tagKeys: ['wege'], share: 0.4, batchDays: 2 }],
      cookDays: { 6: 3 }
    };
    expect(readMealPlan(plan)).toEqual(plan);
    expect(
      readProfileDocument({ ...PROFILE_JSON, mealPlan: plan }, DEFAULT_PROFILE).mealPlan
    ).toEqual(plan);
  });

  it('degrades a damaged template to nothing rather than to half a template', () => {
    expect(readMealPlan(undefined)).toBeUndefined();
    expect(readMealPlan({ slots: 'nie' })).toBeUndefined();
    // A row with no id, or no label, is not a row.
    expect(readMealPlan({ slots: [{ label: 'Obiad' }, { id: 'x' }] })).toBeUndefined();
  });

  it('drops a weekday outside the week, and a run length that is not a number', () => {
    expect(
      readMealPlan({ slots: [{ id: 'a', label: 'A' }], cookDays: { 6: 3, 9: 2, 1: 'dużo' } })
    ).toEqual({
      slots: [{ id: 'a', label: 'A', tagKeys: [], share: 0, batchDays: 1 }],
      cookDays: { 6: 3 }
    });
  });

  it('keeps the local template when the remote document has none', () => {
    const local = {
      ...DEFAULT_PROFILE,
      mealPlan: { slots: [{ id: 'a', label: 'A', tagKeys: [], share: 1, batchDays: 1 }] }
    };
    expect(readProfileDocument(PROFILE_JSON, local).mealPlan).toEqual(local.mealPlan);
    // …and a profile that has never had one stays without one, rather than gaining `{}`.
    expect(readProfileDocument(PROFILE_JSON, DEFAULT_PROFILE)).not.toHaveProperty('mealPlan');
  });
});
