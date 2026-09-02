import { describe, expect, it } from 'vitest';
import { at } from '../../test/fixtures';
import {
  PARSE_SYSTEM,
  RECIPE_SCHEMA,
  looksLikeUrl,
  normalizeUrl,
  readParsedRecipe,
  readUnit,
  toSinglePortion
} from './parse';

describe('the import schema and prompt', () => {
  it('has nowhere to put a nutrition number', () => {
    const fields = JSON.stringify(RECIPE_SCHEMA);
    for (const forbidden of ['kcal', 'calor', 'protein', 'bialko', 'carb', 'fat']) {
      expect(fields.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('forbids nutrition values and demands quantified fats in words too', () => {
    expect(PARSE_SYSTEM).toContain('NIGDY nie podawaj wartości odżywczych');
    expect(PARSE_SYSTEM).toContain('odrobina oliwy');
    expect(PARSE_SYSTEM).toContain('Tłuszcze');
  });

  it('drops water, which a live import showed arriving as a macro-free row', () => {
    expect(PARSE_SYSTEM).toContain('Pomiń wodę');
  });
});

describe('readParsedRecipe', () => {
  const base = {
    name: 'Jajecznica',
    portions: 2,
    instructions: 'Usmaż.',
    ingredients: [
      { name: 'jajko kurze', amount: 4, unit: 'szt', state: 'raw', gramsPerUnit: 55 },
      { name: 'masło', amount: 20, unit: 'g', state: 'raw' }
    ]
  };

  it('reads a well-formed answer', () => {
    expect(readParsedRecipe(base)).toEqual({
      name: 'Jajecznica',
      portions: 2,
      instructions: 'Usmaż.',
      ingredients: [
        { name: 'jajko kurze', amount: 4, unit: 'szt', state: 'raw', gramsPerUnit: 55 },
        { name: 'masło', amount: 20, unit: 'g', state: 'raw' }
      ]
    });
  });

  it('ignores nutrition numbers a model volunteers anyway', () => {
    const parsed = readParsedRecipe({
      ...base,
      kcal: 640,
      ingredients: [{ ...base.ingredients[1], kcal: 149, protein: 0.2, fat: 16.6 }]
    });

    expect(JSON.stringify(parsed)).not.toContain('149');
    expect(parsed.ingredients[0]).toEqual({ name: 'masło', amount: 20, unit: 'g', state: 'raw' });
  });

  it('drops a row with no quantity rather than importing it as zero', () => {
    const parsed = readParsedRecipe({
      ...base,
      ingredients: [
        { name: 'oliwa', amount: 'odrobina', unit: 'g', state: 'raw' },
        { name: 'sól', amount: 0, unit: 'g', state: 'raw' },
        ...base.ingredients
      ]
    });

    expect(parsed.ingredients.map((row) => row.name)).toEqual(['jajko kurze', 'masło']);
  });

  it('converts the metric units the enum did not ask for', () => {
    const parsed = readParsedRecipe({
      ...base,
      ingredients: [
        { name: 'mąka', amount: 0.5, unit: 'kg', state: 'raw' },
        { name: 'mleko', amount: 1, unit: 'l', state: 'raw' }
      ]
    });

    expect(parsed.ingredients).toEqual([
      { name: 'mąka', amount: 500, unit: 'g', state: 'raw' },
      { name: 'mleko', amount: 1000, unit: 'ml', state: 'raw' }
    ]);
  });

  it('accepts a decimal comma, which a Polish answer sometimes uses', () => {
    const parsed = readParsedRecipe({
      ...base,
      ingredients: [{ name: 'oliwa', amount: '12,5', unit: 'g', state: 'raw' }]
    });
    expect(at(parsed.ingredients).amount).toBe(12.5);
  });

  it('drops a row whose unit means nothing to the app', () => {
    const parsed = readParsedRecipe({
      ...base,
      ingredients: [{ name: 'oliwa', amount: 2, unit: 'łyżki', state: 'raw' }]
    });
    expect(parsed.ingredients).toEqual([]);
  });

  it('defaults a missing portion count to one and state to raw', () => {
    const parsed = readParsedRecipe({
      ingredients: [{ name: 'ryż', amount: 100, unit: 'g' }]
    });
    expect(parsed.portions).toBe(1);
    expect(at(parsed.ingredients).state).toBe('raw');
  });

  it('survives rubbish without throwing', () => {
    expect(readParsedRecipe(null).ingredients).toEqual([]);
    expect(readParsedRecipe('nope').ingredients).toEqual([]);
    expect(readParsedRecipe({ ingredients: 'nope' }).ingredients).toEqual([]);
  });

  it('keeps gramsPerUnit only where it means something', () => {
    const parsed = readParsedRecipe({
      ...base,
      ingredients: [{ name: 'masło', amount: 20, unit: 'g', state: 'raw', gramsPerUnit: 55 }]
    });
    expect(at(parsed.ingredients).gramsPerUnit).toBeUndefined();
  });
});

describe('readUnit', () => {
  it('is case- and dot-insensitive', () => {
    expect(readUnit('SZT.')).toEqual({ unit: 'szt', factor: 1 });
  });

  it('rejects what it cannot convert', () => {
    expect(readUnit('szklanka')).toBeUndefined();
    expect(readUnit(7)).toBeUndefined();
  });
});

describe('toSinglePortion', () => {
  it('divides the amounts down to one portion', () => {
    const single = toSinglePortion({
      name: 'x',
      portions: 4,
      instructions: '',
      ingredients: [
        { name: 'ryż', amount: 400, unit: 'g', state: 'raw' },
        { name: 'jajko', amount: 2, unit: 'szt', state: 'raw', gramsPerUnit: 55 }
      ]
    });

    expect(single.portions).toBe(1);
    expect(single.ingredients.map((row) => row.amount)).toEqual([100, 0.5]);
  });

  it('leaves a one-portion recipe alone', () => {
    const recipe = {
      name: 'x',
      portions: 1,
      instructions: '',
      ingredients: [{ name: 'ryż', amount: 100, unit: 'g' as const, state: 'raw' as const }]
    };
    expect(toSinglePortion(recipe)).toEqual(recipe);
  });
});

describe('looksLikeUrl', () => {
  it('recognizes what a user pastes as a link', () => {
    expect(looksLikeUrl('https://kwestiasmaku.com/przepis/zurek')).toBe(true);
    expect(looksLikeUrl('  kwestiasmaku.com/przepis/zurek ')).toBe(true);
  });

  it('does not mistake a recipe for a link', () => {
    expect(looksLikeUrl('Żurek\n\n2 l wody\n300 g białej kiełbasy')).toBe(false);
    expect(looksLikeUrl('zupa pomidorowa')).toBe(false);
    // A bare domain with no path is far more likely to be a typo than a recipe page.
    expect(looksLikeUrl('kwestiasmaku')).toBe(false);
  });

  it('adds the scheme a user leaves out', () => {
    expect(normalizeUrl('kwestiasmaku.com/a')).toBe('https://kwestiasmaku.com/a');
    expect(normalizeUrl('http://kwestiasmaku.com/a')).toBe('http://kwestiasmaku.com/a');
  });
});
