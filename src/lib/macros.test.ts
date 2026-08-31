import { describe, expect, it } from 'vitest';
import {
  ZERO_MACROS,
  addMacros,
  dayTotals,
  displayedAmount,
  displayedGrams,
  gramsPerUnit,
  ingredientLookup,
  isRecipeItemComplete,
  itemGrams,
  itemMacros,
  itemPer100g,
  mealMacros,
  recipePortionMacros,
  remainingMacros,
  roundMacros,
  scaleMacros,
  sumMacros
} from './macros';
import type { Day, PlannedMeal } from './types';
import { chicken, egg, ingredients, item, macros, makeRecipe, oil } from '../test/fixtures';

const lookup = ingredientLookup(ingredients);

describe('unit conversion', () => {
  it('treats grams as grams', () => {
    expect(itemGrams(item(chicken.id, 200))).toBe(200);
  });

  it('converts szt through gramsPerUnit', () => {
    expect(itemGrams(item(egg.id, 3, 'szt', { gramsPerUnit: 58 }))).toBe(174);
  });

  it('defaults ml to 1 g/ml and lets gramsPerUnit act as a density', () => {
    expect(itemGrams(item(oil.id, 10, 'ml'))).toBe(10);
    expect(itemGrams(item(oil.id, 10, 'ml', { gramsPerUnit: 0.9 }))).toBeCloseTo(9);
  });

  it('weighs an unfilled szt item as nothing instead of throwing', () => {
    const incomplete = item(egg.id, 2, 'szt');
    expect(isRecipeItemComplete(incomplete)).toBe(false);
    expect(itemGrams(incomplete)).toBe(0);
    expect(itemMacros(incomplete, egg)).toEqual(ZERO_MACROS);
  });

  it('accepts a szt item once gramsPerUnit is filled in', () => {
    expect(isRecipeItemComplete(item(egg.id, 2, 'szt', { gramsPerUnit: 50 }))).toBe(true);
  });
});

describe('item macros', () => {
  it('scales the ingredient per100g by the item weight', () => {
    expect(itemMacros(item(chicken.id, 200), chicken)).toEqual(macros(200, 40, 0, 4));
  });

  it('lets macroOverride win over the ingredient per100g', () => {
    const overridden = item(chicken.id, 100, 'g', { macroOverride: macros(500, 1, 2, 3) });
    expect(itemMacros(overridden, chicken)).toEqual(macros(500, 1, 2, 3));
  });

  it('applies macroOverride even when the ingredient is unknown', () => {
    const overridden = item('custom:missing', 50, 'g', { macroOverride: macros(400, 10, 20, 30) });
    expect(itemMacros(overridden, undefined)).toEqual(macros(200, 5, 10, 15));
  });

  it('is zero for an unknown ingredient with no override', () => {
    expect(itemMacros(item('custom:missing', 100), undefined)).toEqual(ZERO_MACROS);
  });
});

describe('recipe macros', () => {
  it('sums the items of one portion', () => {
    // 200 g chicken = 200 kcal, 1 egg of 50 g = 100 kcal.
    expect(recipePortionMacros(makeRecipe(), lookup)).toEqual(macros(300, 45, 1, 9));
  });

  it('is zero for a recipe with no items', () => {
    expect(recipePortionMacros(makeRecipe({ items: [] }), lookup)).toEqual(ZERO_MACROS);
  });
});

describe('cookingScale', () => {
  const recipe = makeRecipe();
  const first = recipe.items[0]!;

  it('scales the displayed amount', () => {
    expect(displayedAmount(first, 1)).toBe(200);
    expect(displayedAmount(first, 2.5)).toBe(500);
    expect(displayedGrams(first, 2)).toBe(400);
  });

  it('never touches macros', () => {
    const snapshot = recipePortionMacros(recipe, lookup);
    const single: PlannedMeal = {
      id: 'a',
      recipeId: recipe.id,
      cookingScale: 1,
      portionsEaten: 1,
      macroSnapshot: snapshot
    };
    const batch: PlannedMeal = { ...single, id: 'b', cookingScale: 4 };

    expect(mealMacros(batch)).toEqual(mealMacros(single));
  });
});

describe('meal and day totals', () => {
  const meal = (id: string, kcal: number, portionsEaten: number): PlannedMeal => ({
    id,
    recipeId: 'recipe-1',
    cookingScale: 3,
    portionsEaten,
    macroSnapshot: macros(kcal, 10, 20, 5)
  });

  it('multiplies the frozen snapshot by portionsEaten', () => {
    expect(mealMacros(meal('a', 300, 2))).toEqual(macros(600, 20, 40, 10));
    expect(mealMacros(meal('b', 300, 0.5))).toEqual(macros(150, 5, 10, 2.5));
  });

  it('totals a day as the sum of its meals', () => {
    const day: Day = { date: '2026-09-03', meals: [meal('a', 300, 2), meal('b', 100, 1)] };
    expect(dayTotals(day)).toEqual(macros(700, 30, 60, 15));
  });

  it('totals an empty day as zero', () => {
    expect(dayTotals({ date: '2026-09-03', meals: [] })).toEqual(ZERO_MACROS);
  });
});

describe('arithmetic helpers', () => {
  it('adds field by field', () => {
    expect(addMacros(macros(100, 10, 20, 5), macros(1, 2, 3, 4))).toEqual(macros(101, 12, 23, 9));
  });

  it('reports grams per unit for each unit', () => {
    expect(gramsPerUnit(item(chicken.id, 1))).toBe(1);
    expect(gramsPerUnit(item(oil.id, 1, 'ml'))).toBe(1);
    expect(gramsPerUnit(item(oil.id, 1, 'ml', { gramsPerUnit: 0.9 }))).toBe(0.9);
    expect(gramsPerUnit(item(egg.id, 1, 'szt', { gramsPerUnit: 58 }))).toBe(58);
    expect(gramsPerUnit(item(egg.id, 1, 'szt'))).toBe(0);
  });

  it('picks the per-100 g source: override, then ingredient, then zero', () => {
    expect(itemPer100g(item(chicken.id, 100), chicken)).toEqual(chicken.per100g);
    expect(itemPer100g(item(chicken.id, 100), undefined)).toEqual(ZERO_MACROS);
    const overridden = item(chicken.id, 100, 'g', { macroOverride: macros(1, 2, 3, 4) });
    expect(itemPer100g(overridden, chicken)).toEqual(macros(1, 2, 3, 4));
  });

  it('sums an empty list to zero without mutating ZERO_MACROS', () => {
    expect(sumMacros([])).toEqual(ZERO_MACROS);
    sumMacros([macros(1, 1, 1, 1)]);
    expect(ZERO_MACROS).toEqual(macros(0, 0, 0, 0));
  });

  it('scales every field', () => {
    expect(scaleMacros(macros(100, 10, 20, 5), 0.5)).toEqual(macros(50, 5, 10, 2.5));
  });

  it('reports the remainder against a goal, negative when exceeded', () => {
    expect(remainingMacros(macros(2000, 100, 250, 70), macros(2200, 80, 250, 70))).toEqual(
      macros(-200, 20, 0, 0)
    );
  });

  it('rounds only for display: whole kcal, one decimal on grams', () => {
    expect(roundMacros(macros(1846.7, 100.44, 250.06, 69.96))).toEqual(
      macros(1847, 100.4, 250.1, 70)
    );
  });
});
