import { describe, expect, it } from 'vitest';
import type { Ingredient } from './types';
import {
  canSaveDraft,
  draftForCopy,
  draftFromIngredient,
  draftProblem,
  draftToIngredient,
  emptyIngredientDraft,
  macrosDiffer,
  parseAliases,
  replaceIngredientInItems
} from './custom-ingredients';
import { item, macros, seqIds } from '../test/fixtures';

const rice: Ingredient = {
  id: 'usda:7',
  name: 'Ryż biały',
  aliases: ['ryz', 'ryz bialy'],
  state: 'raw',
  per100g: macros(360, 7, 79, 1),
  source: 'usda'
};

describe('the save rule', () => {
  it('refuses a draft with no name', () => {
    const draft = { ...emptyIngredientDraft(), kcal: 1, protein: 1, carbs: 1, fat: 1 };
    expect(draftProblem(draft)).toBe('Składnik musi mieć nazwę.');
    expect(canSaveDraft(draft)).toBe(false);
  });

  it('refuses a draft with any macro left blank', () => {
    const draft = { ...emptyIngredientDraft('Twaróg'), kcal: 100, protein: 18, carbs: 3 };
    expect(canSaveDraft(draft)).toBe(false);
    expect(draftProblem(draft)).toContain('wpisz 0');
  });

  it('accepts an explicit zero — that is the whole point of `number | null`', () => {
    const draft = { ...emptyIngredientDraft('Woda'), kcal: 0, protein: 0, carbs: 0, fat: 0 };
    expect(draftProblem(draft)).toBeNull();
    expect(draftToIngredient(draft, { nextId: seqIds('u') }).per100g).toEqual(macros(0, 0, 0, 0));
  });

  it('refuses a negative value', () => {
    const draft = { ...emptyIngredientDraft('Coś'), kcal: -1, protein: 0, carbs: 0, fat: 0 };
    expect(draftProblem(draft)).toContain('ujemne');
  });
});

describe('building the ingredient', () => {
  it('mints a namespaced custom id and trims the name', () => {
    const draft = { ...emptyIngredientDraft('  Sos babci  '), kcal: 1, protein: 1, carbs: 1, fat: 1 };
    const built = draftToIngredient(draft, { nextId: seqIds('u') });

    expect(built.id).toBe('custom:u-1');
    expect(built.name).toBe('Sos babci');
    expect(built.source).toBe('custom');
  });

  it('keeps the id it was given, so an edit rewrites the same row', () => {
    const draft = draftFromIngredient({ ...rice, id: 'custom:1', source: 'custom' });
    expect(draftToIngredient(draft, { id: 'custom:1' }).id).toBe('custom:1');
  });

  it('splits aliases on commas, dropping blanks and duplicates', () => {
    expect(parseAliases(' twarog , , twarog, twarożek ')).toEqual(['twarog', 'twarożek']);
  });
});

describe('copying a bundled row', () => {
  it('takes the values and the state, adds the copy suffix and drops the aliases', () => {
    const draft = draftForCopy(rice);

    expect(draft.name).toBe('Ryż biały (kopia)');
    expect(draft.aliases).toBe('');
    expect(draft.state).toBe('raw');
    expect(draft.kcal).toBe(360);

    // And the result is a `custom:*` row, never a second `usda:*` one.
    expect(draftToIngredient(draft, { nextId: seqIds('u') }).source).toBe('custom');
  });
});

describe('macrosDiffer', () => {
  it('is false for the same four numbers and true for any change', () => {
    expect(macrosDiffer(macros(1, 2, 3, 4), macros(1, 2, 3, 4))).toBe(false);
    expect(macrosDiffer(macros(1, 2, 3, 4), macros(1, 2, 3, 5))).toBe(true);
  });
});

describe('replacing an ingredient inside recipe items', () => {
  it('moves only the identity, leaving every measurement alone', () => {
    const items = [
      item('custom:1', 2, 'szt', { gramsPerUnit: 55, macroOverride: macros(9, 9, 9, 9) }),
      item('usda:2', 100)
    ];

    const rewritten = replaceIngredientInItems(items, 'custom:1', 'custom:2');

    expect(rewritten[0]).toEqual({
      ingredientId: 'custom:2',
      amount: 2,
      unit: 'szt',
      gramsPerUnit: 55,
      macroOverride: macros(9, 9, 9, 9)
    });
    expect(rewritten[1]).toEqual(items[1]);
  });

  it('returns the same array when nothing referred to the old id', () => {
    const items = [item('usda:2', 100)];
    expect(replaceIngredientInItems(items, 'custom:1', 'custom:2')).toBe(items);
  });
});
