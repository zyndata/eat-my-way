import { describe, expect, it } from 'vitest';
import { formatShoppingLine, formatShoppingList, shoppingLines, type ShoppingMeal } from './shopping';
import { ingredientLookup } from './macros';
import { chicken, egg, ingredients, item, macros, makeRecipe } from '../test/fixtures';
import type { PlannedMeal } from './types';

const lookup = ingredientLookup(ingredients);

function meal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
  return {
    id: 'm1',
    recipeId: 'r1',
    cookingScale: 1,
    portionsEaten: 1,
    macroSnapshot: macros(300, 45, 1, 9),
    ...overrides
  };
}

describe('shoppingLines', () => {
  it('sums the same ingredient across meals in the scope', () => {
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1' }), recipe },
      { meal: meal({ id: 'm2' }), recipe }
    ];

    expect(shoppingLines(scope, lookup)).toEqual([
      { ingredientId: chicken.id, name: chicken.name, unit: 'g', amount: 400, grams: 400 }
    ]);
  });

  it('follows cookingScale and ignores portionsEaten', () => {
    // The list is what has to be bought and cooked. Eating a quarter of a triple batch still
    // means buying the triple batch.
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ cookingScale: 3, portionsEaten: 0.25 }), recipe }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(600);
  });

  it('keeps different units of one ingredient apart', () => {
    // 2 szt and 100 g cannot be added into a number anyone can shop by.
    const scope: ShoppingMeal[] = [
      {
        meal: meal(),
        recipe: makeRecipe({
          id: 'r1',
          items: [item(egg.id, 2, 'szt', { gramsPerUnit: 50 }), item(egg.id, 100)]
        })
      }
    ];

    const lines = shoppingLines(scope, lookup);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.unit, line.amount, line.grams])).toEqual([
      ['szt', 2, 100],
      ['g', 100, 100]
    ]);
  });

  it('a meal whose recipe was deleted contributes nothing', () => {
    const scope: ShoppingMeal[] = [{ meal: meal(), recipe: undefined }];
    expect(shoppingLines(scope, lookup)).toEqual([]);
  });

  it('names an ingredient that is gone from the database rather than dropping the line', () => {
    const scope: ShoppingMeal[] = [
      { meal: meal(), recipe: makeRecipe({ id: 'r1', items: [item('usda:404', 50)] }) }
    ];
    expect(shoppingLines(scope, lookup)[0]?.name).toBe('Nieznany składnik');
  });

  it('keeps the order the ingredients were first met in', () => {
    const scope: ShoppingMeal[] = [
      {
        meal: meal(),
        recipe: makeRecipe({ id: 'r1', items: [item(egg.id, 1, 'szt', { gramsPerUnit: 50 })] })
      },
      { meal: meal({ id: 'm2' }), recipe: makeRecipe({ id: 'r2', items: [item(chicken.id, 100)] }) }
    ];
    expect(shoppingLines(scope, lookup).map((line) => line.ingredientId)).toEqual([
      egg.id,
      chicken.id
    ]);
  });
});

describe('formatting', () => {
  it('prints grams alongside a piece count, and not for a gram row', () => {
    expect(
      formatShoppingLine({
        ingredientId: egg.id,
        name: 'Jajko kurze',
        unit: 'szt',
        amount: 3,
        grams: 174
      })
    ).toBe('Jajko kurze — 3 szt. (174 g)');

    expect(
      formatShoppingLine({
        ingredientId: chicken.id,
        name: 'Pierś z kurczaka',
        unit: 'g',
        amount: 400,
        grams: 400
      })
    ).toBe('Pierś z kurczaka — 400 g');
  });

  it('says so when there is nothing to buy', () => {
    expect(formatShoppingList('Lista zakupów — środa', [])).toContain('Brak składników');
  });
});
