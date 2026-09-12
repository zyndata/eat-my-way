import { describe, expect, it } from 'vitest';
import {
  formatShoppingLine,
  formatShoppingList,
  groupByDepartment,
  shoppingLines,
  type ShoppingMeal
} from './shopping';
import { ingredientLookup } from './macros';
import { chicken, egg, garlic, ingredients, item, macros, makeRecipe, oil } from '../test/fixtures';
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
      {
        ingredientId: chicken.id,
        name: chicken.name,
        unit: 'g',
        amount: 400,
        grams: 400,
        department: 'mieso'
      }
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

describe('shoppingLines with a meal changed against its recipe', () => {
  // The list buys what is actually cooked (PLAN.md Phase 14 task 5): a list that keeps
  // buying the bread you replaced is the Phase 9 over-buying bug in a new hat.
  const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200), item(egg.id, 100)] });

  it('stops buying a skipped ingredient', () => {
    const scope: ShoppingMeal[] = [
      { meal: meal({ adjustments: [{ replaces: egg.id }] }), recipe }
    ];
    expect(shoppingLines(scope, lookup).map((line) => line.ingredientId)).toEqual([chicken.id]);
  });

  it('buys the swapped-in ingredient instead of the swapped-out one', () => {
    const scope: ShoppingMeal[] = [
      { meal: meal({ adjustments: [{ replaces: egg.id, item: item(oil.id, 20) }] }), recipe }
    ];
    expect(shoppingLines(scope, lookup)).toEqual([
      {
        ingredientId: chicken.id,
        name: chicken.name,
        unit: 'g',
        amount: 200,
        grams: 200,
        department: 'mieso'
      },
      { ingredientId: oil.id, name: oil.name, unit: 'g', amount: 20, grams: 20, department: 'inne' }
    ]);
  });

  it('buys an added ingredient', () => {
    const scope: ShoppingMeal[] = [
      { meal: meal({ adjustments: [{ item: item(oil.id, 10) }] }), recipe }
    ];
    // The order is the shop's since Phase 17, not the recipe's: egg (nabiał) before chicken
    // (mięso), and the oil last because it has no department at all (decision 329).
    expect(shoppingLines(scope, lookup).map((line) => line.ingredientId)).toEqual([
      egg.id,
      chicken.id,
      oil.id
    ]);
  });

  it('follows the changed amount through cookingScale', () => {
    const scope: ShoppingMeal[] = [
      {
        meal: meal({
          cookingScale: 2,
          adjustments: [{ replaces: chicken.id, item: item(chicken.id, 50) }]
        }),
        recipe
      }
    ];
    // Found by id rather than taken at [0]: the list is ordered by department since Phase 17,
    // and this test is about the amount, not about where the line sits.
    const line = shoppingLines(scope, lookup).find((one) => one.ingredientId === chicken.id);
    expect(line).toEqual({
      ingredientId: chicken.id,
      name: chicken.name,
      unit: 'g',
      amount: 100,
      grams: 100,
      department: 'mieso'
    });
  });

  it('still buys a two-day batch of a changed recipe exactly once', () => {
    // „Gotuję na 2 dni": scale 2 on the cooking day, a one-portion copy on the next, and the
    // copy carries the same layer. `cookedScales` suppresses the second day, so the changed
    // amounts are bought once — not three times.
    const layer = [{ replaces: egg.id, item: item(oil.id, 20) }];
    const scope: ShoppingMeal[] = [
      { meal: meal({ id: 'm1', cookingScale: 2, adjustments: layer }), recipe, date: '2026-09-10' },
      { meal: meal({ id: 'm2', adjustments: layer }), recipe, date: '2026-09-11' }
    ];

    expect(shoppingLines(scope, lookup)).toEqual([
      {
        ingredientId: chicken.id,
        name: chicken.name,
        unit: 'g',
        amount: 400,
        grams: 400,
        department: 'mieso'
      },
      // The oil fixture has no department at all, so it shops under „Inne" — which also puts
      // it last, because „Inne" is the end of the walk.
      { ingredientId: oil.id, name: oil.name, unit: 'g', amount: 40, grams: 40, department: 'inne' }
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
        grams: 174,
        department: 'nabial'
      })
    ).toBe('Jajko kurze — 3 szt. (174 g)');

    expect(
      formatShoppingLine({
        ingredientId: chicken.id,
        name: 'Pierś z kurczaka',
        unit: 'g',
        amount: 400,
        grams: 400,
        department: 'mieso'
      })
    ).toBe('Pierś z kurczaka — 400 g');
  });

  it('says so when there is nothing to buy', () => {
    expect(formatShoppingList('Lista zakupów — środa', [])).toContain('Brak składników');
  });
});

describe('household measures on a shopping line (Phase 16)', () => {
  it('prints the measure and keeps the grams parenthesis', () => {
    const recipe = makeRecipe({
      id: 'r1',
      items: [item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })]
    });

    const [line] = shoppingLines([{ meal: meal(), recipe }], lookup);
    expect(line).toEqual({
      ingredientId: garlic.id,
      name: garlic.name,
      unit: 'szt',
      amount: 2,
      grams: 10,
      measureName: 'ząbek',
      department: 'warzywa'
    });
    expect(formatShoppingLine(line!)).toBe('Czosnek — 2 ząbki (10 g)');
  });

  it('sums two recipes that agree on the measure and keeps the label', () => {
    const one = makeRecipe({
      id: 'r1',
      items: [item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })]
    });
    const two = makeRecipe({
      id: 'r2',
      items: [item(garlic.id, 3, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })]
    });

    const [line] = shoppingLines(
      [
        { meal: meal({ id: 'm1', recipeId: 'r1' }), recipe: one },
        { meal: meal({ id: 'm2', recipeId: 'r2' }), recipe: two }
      ],
      lookup
    );
    expect(formatShoppingLine(line!)).toBe('Czosnek — 5 ząbków (25 g)');
  });

  it('drops the label when the rows disagree, rather than claiming one of them', () => {
    // Keyed by `ingredientId + unit`, so these merge — and neither label is true of both.
    const cloves = makeRecipe({
      id: 'r1',
      items: [item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })]
    });
    const heads = makeRecipe({ id: 'r2', items: [item(garlic.id, 1, 'szt', { gramsPerUnit: 45 })] });

    const [line] = shoppingLines(
      [
        { meal: meal({ id: 'm1', recipeId: 'r1' }), recipe: cloves },
        { meal: meal({ id: 'm2', recipeId: 'r2' }), recipe: heads }
      ],
      lookup
    );
    expect(line?.measureName).toBeUndefined();
    expect(formatShoppingLine(line!)).toBe('Czosnek — 3 szt. (55 g)');
  });

  it('leaves a line without a measure exactly as it was', () => {
    expect(
      formatShoppingLine({
        ingredientId: egg.id,
        name: 'Jajko',
        unit: 'szt',
        amount: 3,
        grams: 174,
        department: 'nabial'
      })
    ).toBe('Jajko — 3 szt. (174 g)');
  });
});

describe('shop departments (Phase 17)', () => {
  it('orders the lines by department, in the order a shop is walked', () => {
    // Written in the reverse of the walk order on purpose: oil (no department -> „Inne"),
    // then chicken (mięso), then garlic (warzywa). The list comes back the other way round.
    const recipe = makeRecipe({
      id: 'r1',
      items: [
        item(oil.id, 10),
        item(chicken.id, 200),
        item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })
      ]
    });

    expect(shoppingLines([{ meal: meal(), recipe }], lookup).map((line) => line.department)).toEqual(
      ['warzywa', 'mieso', 'inne']
    );
  });

  it('keeps the order the ingredients were first met inside one department', () => {
    // Two rows of one department, met second and first respectively. Grouping must not
    // reshuffle them: a department still reads the way the whole list used to (decision 329).
    const recipe = makeRecipe({
      id: 'r1',
      items: [item(egg.id, 2, 'szt', { gramsPerUnit: 58 }), item(chicken.id, 200)]
    });
    const second = makeRecipe({ id: 'r2', items: [item(egg.id, 1, 'szt', { gramsPerUnit: 58 })] });

    const lines = shoppingLines(
      [
        { meal: meal({ id: 'm1', recipeId: 'r1' }), recipe },
        { meal: meal({ id: 'm2', recipeId: 'r2' }), recipe: second }
      ],
      lookup
    );
    expect(lines.map((line) => line.name)).toEqual([egg.name, chicken.name]);
  });

  it('files an ingredient with no department, and a deleted one, under „Inne"', () => {
    const recipe = makeRecipe({ id: 'r1', items: [item(oil.id, 10), item('usda:gone', 50)] });
    const lines = shoppingLines([{ meal: meal(), recipe }], lookup);

    expect(lines.map((line) => line.department)).toEqual(['inne', 'inne']);
    expect(lines[1]?.name).toBe('Nieznany składnik');
  });

  it('groups under nine headings in shop order, with the empty ones absent', () => {
    const recipe = makeRecipe({
      id: 'r1',
      items: [
        item(chicken.id, 200),
        item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' }),
        item(oil.id, 10)
      ]
    });

    const groups = groupByDepartment(shoppingLines([{ meal: meal(), recipe }], lookup));
    expect(groups.map((group) => group.label)).toEqual([
      'Warzywa i owoce',
      'Mięso, ryby i wędliny',
      'Inne'
    ]);
    expect(groups.every((group) => group.lines.length > 0)).toBe(true);
  });

  it('prints one heading for a list that touches one department only', () => {
    const recipe = makeRecipe({ id: 'r1', items: [item(chicken.id, 200)] });
    const lines = shoppingLines([{ meal: meal(), recipe }], lookup);

    expect(groupByDepartment(lines)).toHaveLength(1);
    expect(formatShoppingList('Lista zakupów — środa', lines)).toBe(
      'Lista zakupów — środa\n\nMięso, ryby i wędliny\n• Pierś z kurczaka — 200 g\n'
    );
  });

  it('prints the headings in the shared text, blank line between departments', () => {
    const recipe = makeRecipe({
      id: 'r1',
      items: [
        item(chicken.id, 200),
        item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })
      ]
    });

    expect(
      formatShoppingList('Lista zakupów — tydzień', shoppingLines([{ meal: meal(), recipe }], lookup))
    ).toBe(
      'Lista zakupów — tydzień\n\n' +
        'Warzywa i owoce\n• Czosnek — 2 ząbki (10 g)\n\n' +
        'Mięso, ryby i wędliny\n• Pierś z kurczaka — 200 g\n'
    );
  });

  it('still says so when there is nothing to buy, with no headings at all', () => {
    expect(formatShoppingList('Lista zakupów — środa', [])).toBe(
      'Lista zakupów — środa\n\nBrak składników do kupienia.\n'
    );
  });
});
