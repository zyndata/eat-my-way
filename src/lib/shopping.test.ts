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

  it('buys a pot cooked for two days once, not twice', () => {
    // What „Gotuję na 2 dni" writes, and what the planner writes: scale 2 on the cooking day,
    // a `cookingScale: 1` copy on the next. Before this, the week's list bought three
    // portions for a two-day cook (STATE.md decision 275).
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 2, portionsEaten: 1 }), recipe, date: '2026-09-07' },
      { meal: meal({ id: 'm2', cookingScale: 1, portionsEaten: 1 }), recipe, date: '2026-09-08' }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(400);
  });

  it('still counts both plates when one recipe is served twice on the same day', () => {
    // Not leftovers: the same day is two servings, and the list has always followed the
    // batch rather than the plate (Phase 9). Only a *later* day comes out of the pot.
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 3, portionsEaten: 0.25 }), recipe, date: '2026-09-07' },
      { meal: meal({ id: 'm2', cookingScale: 1, portionsEaten: 1 }), recipe, date: '2026-09-07' }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(800);
  });

  it('buys a planner batch at the portions it really holds', () => {
    // 1.25 portions a day for three days is 3.75 in the pot — the invariant that would
    // otherwise surface only as a list that under-buys (STATE.md decision 268).
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 3.75, portionsEaten: 1.25 }), recipe, date: '2026-09-07' },
      { meal: meal({ id: 'm2', cookingScale: 1, portionsEaten: 1.25 }), recipe, date: '2026-09-08' },
      { meal: meal({ id: 'm3', cookingScale: 1, portionsEaten: 1.25 }), recipe, date: '2026-09-09' }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(750);
  });

  it('still buys twice for the same recipe cooked fresh on two days', () => {
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 1, portionsEaten: 1 }), recipe, date: '2026-09-07' },
      { meal: meal({ id: 'm2', cookingScale: 1, portionsEaten: 1 }), recipe, date: '2026-09-08' }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(400);
  });

  it('buys a pot nobody eats on the day it is cooked', () => {
    // `portionsEaten: 0` is cooked-and-not-eaten, not leftovers: it still has to be bought.
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 2, portionsEaten: 0 }), recipe }
    ];

    expect(shoppingLines(scope, lookup)[0]?.amount).toBe(400);
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
