import { describe, expect, it } from 'vitest';
import type { Ingredient } from './types';
import {
  canSaveDraft,
  draftForCopy,
  draftFromIngredient,
  draftProblem,
  draftSanity,
  draftToIngredient,
  emptyIngredientDraft,
  emptyMeasureDraft,
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

describe('household measures on a custom ingredient (Phase 16)', () => {
  function complete(): ReturnType<typeof emptyIngredientDraft> {
    return { ...emptyIngredientDraft('Twaróg'), kcal: 100, protein: 12, carbs: 3, fat: 4 };
  }

  it('is optional in every direction — an ingredient with no measures is complete', () => {
    const draft = complete();
    expect(draftProblem(draft)).toBeNull();
    expect(draftToIngredient(draft, { id: 'custom:1' })).not.toHaveProperty('measures');
  });

  it('writes the measures it was given, in order', () => {
    const draft = complete();
    draft.measures = [
      { id: 'm1', name: 'łyżka', grams: 28 },
      { id: 'm2', name: 'opakowanie', grams: 250 }
    ];

    expect(draftProblem(draft)).toBeNull();
    expect(draftToIngredient(draft, { id: 'custom:1' }).measures).toEqual([
      { name: 'łyżka', grams: 28 },
      { name: 'opakowanie', grams: 250 }
    ]);
  });

  it('refuses a measure that weighs nothing, and says why', () => {
    const draft = complete();
    draft.measures = [{ id: 'm1', name: 'łyżka', grams: null }];
    expect(draftProblem(draft)).toMatch(/więcej niż 0 g/);

    draft.measures = [{ id: 'm1', name: 'łyżka', grams: 0 }];
    expect(draftProblem(draft)).toMatch(/więcej niż 0 g/);
    expect(canSaveDraft(draft)).toBe(false);
  });

  it('refuses the same measure twice', () => {
    const draft = complete();
    draft.measures = [
      { id: 'm1', name: 'łyżka', grams: 28 },
      { id: 'm2', name: 'łyżka', grams: 30 }
    ];
    expect(draftProblem(draft)).toMatch(/tylko raz/);
  });

  it('loads an ingredient\u2019s measures into the form and carries them into a copy', () => {
    const stored: Ingredient = {
      id: 'usda:4',
      name: 'Czosnek',
      aliases: ['czosnek'],
      state: 'raw',
      per100g: { kcal: 149, protein: 6, carbs: 33, fat: 0.5 },
      source: 'usda',
      measures: [{ name: 'ząbek', grams: 5 }]
    };
    let n = 0;
    const nextId = (): string => `m${(n += 1)}`;

    expect(draftFromIngredient(stored, nextId).measures).toEqual([
      { id: 'm1', name: 'ząbek', grams: 5 }
    ]);
    const copy = draftForCopy(stored, nextId);
    expect(copy.measures).toEqual([{ id: 'm2', name: 'ząbek', grams: 5 }]);
    // Aliases still do not travel — decision 177 is untouched.
    expect(copy.aliases).toBe('');
  });

  it('offers the next unused name when a measure row is added', () => {
    const draft = complete();
    expect(emptyMeasureDraft(draft, 'm1').name).toBe('szt.');
    draft.measures = [{ id: 'm1', name: 'szt.', grams: 45 }];
    expect(emptyMeasureDraft(draft, 'm2').name).toBe('mała szt.');
  });

  it('drops the measure name when a row is swapped to another ingredient', () => {
    // A measure is a claim about the ingredient, not a measurement of the plate (decision 354).
    const items = [
      { ingredientId: 'usda:4', amount: 2, unit: 'szt' as const, gramsPerUnit: 5, measureName: 'ząbek' as const }
    ];
    expect(replaceIngredientInItems(items, 'usda:4', 'custom:9')).toEqual([
      { ingredientId: 'custom:9', amount: 2, unit: 'szt', gramsPerUnit: 5 }
    ]);
  });
});

describe('are these numbers even possible? (Phase 18 task A)', () => {
  const draft = (kcal: number, protein: number, carbs: number, fat: number) => ({
    ...emptyIngredientDraft('Coś'),
    kcal,
    protein,
    carbs,
    fat
  });

  it('warns when the three macronutrients weigh more than the food does', () => {
    const impossible = draft(520, 40, 40, 40);
    const sanity = draftSanity(impossible);
    expect(sanity?.rule).toBe('sum');
    expect(sanity?.message).toContain('120 g na 100 g');
    // The whole point of decision 331: it is a sentence, not a lock.
    expect(draftProblem(impossible)).toBeNull();
    expect(canSaveDraft(impossible)).toBe(true);
  });

  it('says nothing about a perfectly ordinary ingredient', () => {
    // Ryż biały, straight out of the bundled subset: 360 kcal against 359 implied.
    expect(draftSanity(draft(360, 7, 79, 1))).toBeNull();
    // Oil: 900 kcal of pure fat, the extreme end of the range and still fine.
    expect(draftSanity(draft(884, 0, 0, 100))).toBeNull();
  });

  it('warns when the stated energy cannot come from those macros, and still saves', () => {
    // A high-fibre bran: the label is right, Atwater is not. 360 implied against 200 stated.
    const bran = draft(200, 16, 65, 4);
    const sanity = draftSanity(bran);
    expect(sanity?.rule).toBe('energy');
    expect(sanity?.message).toContain('360 kcal');
    expect(sanity?.message).toContain('200');
    expect(canSaveDraft(bran)).toBe(true);
  });

  it('leaves a 15 kcal vegetable alone — the absolute floor, decision 332', () => {
    // Sałata: 19 kcal implied against 15 stated. 4 kcal is 27%, and under the 20 kcal floor.
    expect(draftSanity(draft(15, 1.4, 2.9, 0.2))).toBeNull();
  });

  it('catches a decimal point in the wrong place', () => {
    expect(draftSanity(draft(1000, 12, 3, 4))?.rule).toBe('energy');
    expect(draftSanity(draft(10, 12, 3, 4))?.rule).toBe('energy');
  });

  it('names the scanned fields it implicates, and only those', () => {
    const scanned = draftSanity(draft(520, 40, 40, 40), { protein: true, kcal: true });
    // Sum is about the three macronutrients — the scanned kcal is not one of them.
    expect(scanned?.message).toContain('pole odczytane ze zdjęcia: białko.');
    expect(scanned?.message).toContain('zapisz mimo to');

    const energy = draftSanity(draft(1000, 12, 3, 4), { kcal: true, fat: true });
    expect(energy?.message).toContain('pola odczytane ze zdjęcia: kcal, tłuszcz.');
  });

  it('falls back to a typo when nothing was scanned', () => {
    expect(draftSanity(draft(520, 40, 40, 40))?.message).toContain('literówki');
  });

  it('stays silent while `draftProblem` still has something to say', () => {
    // Missing and negative values are the save rule's business; two sentences arguing about
    // one field help nobody.
    expect(draftSanity({ ...emptyIngredientDraft('Coś'), kcal: 900, protein: 40, carbs: 40 })).toBeNull();
    expect(draftSanity(draft(900, -40, 40, 40))).toBeNull();
  });
});
