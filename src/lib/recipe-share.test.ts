import { describe, expect, it } from 'vitest';
import { formatRecipeIngredient, formatRecipeShare } from './recipe-share';
import { ingredientLookup } from './macros';
import { chicken, egg, garlic, ingredients, item, makeRecipe, oil } from '../test/fixtures';

/**
 * „Przepis dla kogoś" — PLAN.md Phase 22 task 1. Every rule under „What is shared": the
 * recipe's own order, amounts through the measure vocabulary, grams after `szt` rows only,
 * instructions verbatim and unscaled, and nothing in the text but what someone cooking needs
 * (STATE.md decisions 411–414).
 */

const lookup = ingredientLookup(ingredients);

/** „1 ząbek (5 g)" — the row the acceptance criteria are written against. */
const clove = item(garlic.id, 1, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' });

describe('formatRecipeIngredient', () => {
  it('declines a household measure and puts its grams in brackets', () => {
    expect(formatRecipeIngredient(clove, 1, lookup)).toBe('Czosnek — 1 ząbek (5 g)');
    expect(formatRecipeIngredient(clove, 2, lookup)).toBe('Czosnek — 2 ząbki (10 g)');
    expect(formatRecipeIngredient(clove, 1.5, lookup)).toBe('Czosnek — 1,5 ząbka (8 g)');
  });

  it('puts grams after a plain „szt." row too', () => {
    const eggs = item(egg.id, 1, 'szt', { gramsPerUnit: 150 });
    expect(formatRecipeIngredient(eggs, 3, lookup)).toBe('Jajko — 3 szt. (450 g)');
  });

  it('prints no brackets after a gram row or a millilitre row', () => {
    expect(formatRecipeIngredient(item(chicken.id, 100), 3, lookup)).toBe('Pierś z kurczaka — 300 g');
    expect(formatRecipeIngredient(item(oil.id, 200, 'ml'), 3, lookup)).toBe(
      'Oliwa z oliwek — 600 ml'
    );
  });

  it('prints no brackets for a „szt." row with no weight to give', () => {
    expect(formatRecipeIngredient(item(egg.id, 2, 'szt'), 1, lookup)).toBe('Jajko — 2 szt.');
  });

  it('names a row whose ingredient is gone the way the meal screen does', () => {
    expect(formatRecipeIngredient(item('usda:999', 50), 1, lookup)).toBe('Nieznany składnik — 50 g');
  });
});

describe('formatRecipeShare', () => {
  it('writes name, portions and time, ingredients in order, and the instructions verbatim', () => {
    const recipe = { name: 'Leczo', prepMinutes: 40, instructions: 'Pokrój.\nDodaj 200 g mąki.' };
    // Dairy before meat, and the same ingredient twice: a shopping list would sort the first
    // and merge the second. This does neither (decision 411).
    const items = [
      item(egg.id, 1, 'szt', { gramsPerUnit: 150 }),
      item(chicken.id, 100),
      clove,
      item(oil.id, 200, 'ml'),
      item(chicken.id, 20)
    ];

    expect(formatRecipeShare(recipe, items, 3, lookup)).toBe(
      'Leczo\n' +
        '3 porcje · 40 min\n' +
        '\n' +
        'Składniki:\n' +
        '• Jajko — 3 szt. (450 g)\n' +
        '• Pierś z kurczaka — 300 g\n' +
        '• Czosnek — 3 ząbki (15 g)\n' +
        '• Oliwa z oliwek — 600 ml\n' +
        '• Pierś z kurczaka — 60 g\n' +
        '\n' +
        'Przygotowanie:\n' +
        // Not scaled: „200 g" is free text, not an amount the app knows (decision 413).
        'Pokrój.\n' +
        'Dodaj 200 g mąki.\n'
    );
  });

  it('leaves the time out for a recipe nobody has timed', () => {
    const text = formatRecipeShare({ name: 'Owsianka', instructions: '' }, [clove], 1, lookup);
    expect(text.split('\n')[1]).toBe('1 porcja');
    expect(text).not.toContain('min');
  });

  it('says a fractional count in the genitive', () => {
    const text = formatRecipeShare({ name: 'Owsianka', instructions: '' }, [clove], 1.5, lookup);
    expect(text.split('\n')[1]).toBe('1,5 porcji');
  });

  it('leaves out „Przygotowanie" when there are no instructions', () => {
    for (const instructions of ['', '  \n ']) {
      const text = formatRecipeShare({ name: 'Owsianka', instructions }, [clove], 2, lookup);
      expect(text).not.toContain('Przygotowanie');
      expect(text.endsWith('• Czosnek — 2 ząbki (10 g)\n')).toBe(true);
    }
  });

  it('skips a row that was never filled in, and says so when nothing is left', () => {
    const blank = item('', 100);
    expect(formatRecipeShare({ name: 'X', instructions: '' }, [blank, clove], 1, lookup)).toBe(
      'X\n1 porcja\n\nSkładniki:\n• Czosnek — 1 ząbek (5 g)\n'
    );
    expect(formatRecipeShare({ name: 'X', instructions: '' }, [blank], 1, lookup)).toContain(
      'Składniki:\nBrak składników.'
    );
    expect(formatRecipeShare({ name: 'X', instructions: '' }, [], 1, lookup)).toContain(
      'Brak składników.'
    );
  });

  it('carries no macros, no source link, no footer and no markup', () => {
    // A whole stored recipe, source link and all — the text picks out what it needs.
    const recipe = makeRecipe({ sourceUrl: 'https://example.com/leczo', prepMinutes: 25 });
    const text = formatRecipeShare(recipe, recipe.items, 2, lookup);

    expect(text).not.toMatch(/kcal|Białko|Węglowodany|Tłuszcz|B \d/);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('http');
    expect(text).not.toContain('Eat My Way');
    expect(text).not.toContain('*');
    expect(text.endsWith('Przygotowanie:\nUsmaż.\n')).toBe(true);
  });
});
