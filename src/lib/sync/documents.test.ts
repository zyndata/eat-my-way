import { describe, expect, it } from 'vitest';
import {
  readDaysDocument,
  readIngredientsDocument,
  readMealPlan,
  readProfileDocument,
  readRecipesDocument
} from './documents';
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

/** The Phase 19 body data, which needs a reader here for exactly the same reason. */
describe('body data in profile.json', () => {
  const body = {
    sex: 'male' as const,
    age: 40,
    height: 180,
    weight: 80,
    activity: 'sedentary' as const,
    split: { protein: 40, carbs: 30, fat: 30 }
  };

  it('survives a round trip through the document', () => {
    const written = JSON.parse(JSON.stringify({ ...PROFILE_JSON, body }));
    expect(readProfileDocument(written, DEFAULT_PROFILE).body).toEqual(body);
  });

  it('keeps the body this device holds when the remote document has none', () => {
    const { split: _ignored, ...plain } = body;
    const local = { ...DEFAULT_PROFILE, body: plain };
    expect(readProfileDocument(PROFILE_JSON, local).body).toEqual(local.body);
    expect(readProfileDocument(PROFILE_JSON, DEFAULT_PROFILE)).not.toHaveProperty('body');
  });

  it('ignores a damaged body rather than importing half of one', () => {
    const local = { ...DEFAULT_PROFILE, body: { ...body } };
    const damaged = { ...PROFILE_JSON, body: { sex: 'male', age: 40 } };
    expect(readProfileDocument(damaged, local).body).toEqual(local.body);
    expect(readProfileDocument(damaged, DEFAULT_PROFILE)).not.toHaveProperty('body');
  });
});

describe('readDaysDocument', () => {
  /**
   * The days document is spread through rather than rebuilt field by field, which is what
   * lets an optional addition like Phase 14's `adjustments` cross Drive with no schema
   * version and no migration (STATE.md decision 309).
   */
  const day = {
    date: '2026-09-10',
    meals: [
      {
        id: 'meal-1',
        recipeId: 'recipe-1',
        cookingScale: 1,
        portionsEaten: 1,
        macroSnapshot: { kcal: 100, protein: 5, carbs: 10, fat: 2 },
        adjustments: [
          { replaces: 'usda:1' },
          { item: { ingredientId: 'usda:3', amount: 10, unit: 'g' } }
        ]
      }
    ]
  };

  it('round-trips a meal changed against its recipe', () => {
    const read = readDaysDocument(JSON.parse(JSON.stringify({ '2026-09-10': day })));
    expect(read['2026-09-10']).toEqual(day);
  });

  it('leaves a meal without the field alone', () => {
    const meal = {
      id: 'meal-1',
      recipeId: 'recipe-1',
      cookingScale: 1,
      portionsEaten: 1,
      macroSnapshot: { kcal: 100, protein: 5, carbs: 10, fat: 2 }
    };

    const read = readDaysDocument({ '2026-09-10': { ...day, meals: [meal] } });
    expect(read['2026-09-10']?.meals[0]).not.toHaveProperty('adjustments');
  });
});

describe('household measures in the Drive documents (Phase 16)', () => {
  it('keeps an ingredient\u2019s measures, because the reader keeps the fields it does not know', () => {
    const document = {
      ingredients: [
        {
          id: 'custom:1',
          name: 'Twaróg',
          aliases: [],
          state: 'raw',
          per100g: { kcal: 100, protein: 5, carbs: 10, fat: 2 },
          source: 'custom',
          measures: [{ name: 'łyżka', grams: 28 }]
        }
      ],
      corrections: []
    };

    const read = readIngredientsDocument(JSON.parse(JSON.stringify(document)));
    expect(read.ingredients[0]?.measures).toEqual([{ name: 'łyżka', grams: 28 }]);
  });

  it('keeps a recipe item\u2019s measureName', () => {
    const document = {
      recipes: [
        {
          id: 'recipe-1',
          name: 'Czosnkowa',
          items: [
            { ingredientId: 'usda:4', amount: 2, unit: 'szt', gramsPerUnit: 5, measureName: 'ząbek' }
          ],
          tags: [],
          instructions: '',
          createdAt: '2026-09-11T10:00:00.000Z',
          updatedAt: '2026-09-11T10:00:00.000Z'
        }
      ],
      tags: []
    };

    const read = readRecipesDocument(JSON.parse(JSON.stringify(document)));
    expect(read.recipes[0]?.items[0]?.measureName).toBe('ząbek');
  });

  it('reads a document written before measures existed, unchanged', () => {
    const read = readIngredientsDocument({
      ingredients: [
        {
          id: 'custom:1',
          name: 'Twaróg',
          aliases: [],
          state: 'raw',
          per100g: { kcal: 100, protein: 5, carbs: 10, fat: 2 },
          source: 'custom'
        }
      ],
      corrections: []
    });
    expect(read.ingredients[0]?.measures).toBeUndefined();
  });
});

describe('the shopping department in the Drive documents (Phase 17)', () => {
  it('keeps an ingredient’s department, with no schema version and no migration', () => {
    const document = {
      ingredients: [
        {
          id: 'custom:1',
          name: 'Twaróg',
          aliases: [],
          state: 'raw',
          per100g: { kcal: 100, protein: 5, carbs: 10, fat: 2 },
          source: 'custom',
          department: 'nabial'
        }
      ],
      corrections: []
    };

    const read = readIngredientsDocument(JSON.parse(JSON.stringify(document)));
    expect(read.ingredients[0]?.department).toBe('nabial');
  });

  it('reads a document written before departments existed, unchanged', () => {
    const read = readIngredientsDocument({
      ingredients: [
        {
          id: 'custom:1',
          name: 'Twaróg',
          aliases: [],
          state: 'raw',
          per100g: { kcal: 100, protein: 5, carbs: 10, fat: 2 },
          source: 'custom'
        }
      ],
      corrections: []
    });
    expect(read.ingredients[0]).not.toHaveProperty('department');
  });
});
