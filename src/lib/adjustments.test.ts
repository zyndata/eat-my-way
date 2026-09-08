import { describe, expect, it } from 'vitest';
import {
  addRow,
  adjustedPortionMacros,
  adjustedRows,
  adjustmentKey,
  adjustmentSummary,
  changeRow,
  cloneAdjustments,
  clearAdjustments,
  effectiveItems,
  isAdjusted,
  keepOnlyRow,
  normalizeAdjustments,
  restoreRow,
  skipRow,
  type MealAdjustment
} from './adjustments';
import { ingredientLookup } from './macros';
import { chicken, egg, ingredients, item, macros, makeRecipe, oil } from '../test/fixtures';

const lookup = ingredientLookup(ingredients);

/** 200 g chicken (200 kcal) + 1 egg of 50 g (100 kcal) = 300 kcal per portion. */
const recipe = makeRecipe();

const chickenRow = `r:${chicken.id}`;
const eggRow = `r:${egg.id}`;

const ids = (adjustments: readonly MealAdjustment[] | undefined): string[] =>
  effectiveItems(recipe, adjustments).map((row) => row.ingredientId);

describe('normalizeAdjustments', () => {
  it('drops a change that says nothing', () => {
    expect(normalizeAdjustments([{}, { replaces: chicken.id }, {}])).toEqual([
      { replaces: chicken.id }
    ]);
  });

  it('treats an absent layer as no changes', () => {
    expect(normalizeAdjustments(undefined)).toEqual([]);
  });
});

describe('effectiveItems', () => {
  it('is the recipe itself when there is no layer', () => {
    expect(effectiveItems(recipe, undefined)).toEqual(recipe.items);
  });

  it('skips the row a bare `replaces` names', () => {
    expect(ids([{ replaces: chicken.id }])).toEqual([egg.id]);
  });

  it('changes the amount when the item names the same ingredient', () => {
    const [row] = effectiveItems(recipe, [{ replaces: chicken.id, item: item(chicken.id, 50) }]);
    expect(row).toEqual(item(chicken.id, 50));
  });

  it('swaps the row for another ingredient, in place', () => {
    expect(ids([{ replaces: chicken.id, item: item(oil.id, 10) }])).toEqual([oil.id, egg.id]);
  });

  it('appends an addition at the end of the list', () => {
    expect(ids([{ item: item(oil.id, 10) }])).toEqual([chicken.id, egg.id, oil.id]);
  });

  it('applies changes in array order', () => {
    // The chicken becomes oil, and the oil is then skipped: nothing of that row survives.
    const layer: MealAdjustment[] = [
      { replaces: chicken.id, item: item(oil.id, 10) },
      { replaces: oil.id }
    ];
    expect(ids(layer)).toEqual([egg.id]);
  });

  it('matches every row carrying that ingredient', () => {
    const twiceOiled = makeRecipe({
      items: [item(oil.id, 10), item(chicken.id, 200), item(oil.id, 5)]
    });
    expect(effectiveItems(twiceOiled, [{ replaces: oil.id }])).toEqual([item(chicken.id, 200)]);
  });

  it('goes inert, not deleted, when the recipe no longer has the row', () => {
    // A recipe edit took the oil out; the change naming it now applies to nothing.
    const layer: MealAdjustment[] = [{ replaces: oil.id, item: item(chicken.id, 30) }];
    expect(ids(layer)).toEqual([chicken.id, egg.id]);
    expect(effectiveItems(recipe, layer)).toEqual(recipe.items);

    // A later edit brings the row back, and the change wakes up with it.
    const withOil = makeRecipe({ items: [...recipe.items, item(oil.id, 10)] });
    expect(effectiveItems(withOil, layer)).toEqual([...recipe.items, item(chicken.id, 30)]);
  });

  it('ignores an empty change', () => {
    expect(effectiveItems(recipe, [{}])).toEqual(recipe.items);
  });
});

describe('adjustedRows', () => {
  it('keeps a skipped row in the list, marked, with its original', () => {
    const rows = adjustedRows(recipe, [{ replaces: chicken.id }]);

    expect(rows.map((row) => row.kind)).toEqual(['skipped', 'plain']);
    expect(rows[0]?.original).toEqual(item(chicken.id, 200));
  });

  it('tells an amount change from a swap', () => {
    const amount = adjustedRows(recipe, [{ replaces: chicken.id, item: item(chicken.id, 50) }]);
    const swap = adjustedRows(recipe, [{ replaces: chicken.id, item: item(oil.id, 10) }]);

    expect(amount[0]?.kind).toBe('amount');
    expect(swap[0]?.kind).toBe('swap');
    expect(swap[0]?.original).toEqual(item(chicken.id, 200));
  });

  it('keeps the first original across a second change to the same row', () => {
    const rows = adjustedRows(recipe, [
      { replaces: chicken.id, item: item(oil.id, 10) },
      { replaces: oil.id }
    ]);
    expect(rows[0]?.kind).toBe('skipped');
    expect(rows[0]?.original).toEqual(item(chicken.id, 200));
  });

  it('addresses a recipe row and an addition of the same ingredient separately', () => {
    const rows = adjustedRows(recipe, [{ item: item(chicken.id, 30) }]);
    expect(rows.map((row) => row.key)).toEqual([chickenRow, eggRow, `a:${chicken.id}`]);
  });
});

describe('isAdjusted', () => {
  it('is false without a layer, and false for a layer of nothing', () => {
    expect(isAdjusted({})).toBe(false);
    expect(isAdjusted({ adjustments: [] })).toBe(false);
    expect(isAdjusted({ adjustments: [{}] })).toBe(false);
  });

  it('is true once anything is changed', () => {
    expect(isAdjusted({ adjustments: [{ replaces: chicken.id }] })).toBe(true);
  });
});

describe('adjustedPortionMacros', () => {
  it('is the plain recipe without a layer', () => {
    expect(adjustedPortionMacros(recipe, undefined, lookup)).toEqual(macros(300, 45, 1, 9));
  });

  it('falls by exactly the skipped row', () => {
    expect(adjustedPortionMacros(recipe, [{ replaces: chicken.id }], lookup)).toEqual(
      macros(100, 5, 1, 5)
    );
  });

  it('rises by an added row', () => {
    expect(
      adjustedPortionMacros(recipe, [{ item: item(oil.id, 10) }], lookup).kcal
    ).toBeCloseTo(390);
  });

  it('is the cucumber case: one ingredient of the recipe, and nothing else', () => {
    const layer = keepOnlyRow(recipe, undefined, eggRow);
    expect(adjustedPortionMacros(recipe, layer, lookup)).toEqual(macros(100, 5, 1, 5));
  });
});

describe('adjustmentSummary', () => {
  it('says nothing about an unchanged meal', () => {
    expect(adjustmentSummary(recipe, undefined, lookup)).toEqual([]);
  });

  it('names each change in Polish', () => {
    const layer: MealAdjustment[] = [
      { replaces: chicken.id },
      { replaces: egg.id, item: item(egg.id, 2, 'szt', { gramsPerUnit: 50 }) },
      { item: item(oil.id, 10) }
    ];
    expect(adjustmentSummary(recipe, layer, lookup)).toEqual([
      '− Pierś z kurczaka',
      'Jajko → 2 szt.',
      '+ Oliwa z oliwek 10 g'
    ]);
  });

  it('names both sides of a swap', () => {
    const layer: MealAdjustment[] = [{ replaces: chicken.id, item: item(oil.id, 10) }];
    expect(adjustmentSummary(recipe, layer, lookup)).toEqual([
      'Pierś z kurczaka → Oliwa z oliwek'
    ]);
  });

  it('falls back to the placeholder for an ingredient that is gone', () => {
    const layer: MealAdjustment[] = [{ item: item('usda:404', 10) }];
    expect(adjustmentSummary(recipe, layer, lookup)).toEqual(['+ Nieznany składnik 10 g']);
  });
});

describe('builders', () => {
  it('skip and restore are each other, and neither stacks', () => {
    const once = skipRow(undefined, chickenRow);
    const twice = skipRow(once, chickenRow);

    expect(twice).toEqual([{ replaces: chicken.id }]);
    expect(restoreRow(twice, chickenRow)).toEqual([]);
  });

  it('collapses a second change to the same row, keeping its position', () => {
    const layer = changeRow(skipRow(undefined, eggRow), chickenRow, item(chicken.id, 50));
    const again = changeRow(layer, chickenRow, item(chicken.id, 20));

    expect(again).toEqual([
      { replaces: egg.id },
      { replaces: chicken.id, item: item(chicken.id, 20) }
    ]);
  });

  it('swap is the same write as an amount change', () => {
    expect(changeRow(undefined, chickenRow, item(oil.id, 10))).toEqual([
      { replaces: chicken.id, item: item(oil.id, 10) }
    ]);
  });

  it('adds a row at the end, and collapses a second add of the same ingredient', () => {
    const once = addRow(undefined, item(oil.id, 10));
    const twice = addRow(once, item(oil.id, 25));

    expect(twice).toEqual([{ item: item(oil.id, 25) }]);
    expect(ids(twice)).toEqual([chicken.id, egg.id, oil.id]);
  });

  it('skipping an added row drops the addition rather than striking it through', () => {
    const added = addRow(undefined, item(oil.id, 10));
    expect(skipRow(added, `a:${oil.id}`)).toEqual([]);
  });

  it('re-keys an added row edited into a different ingredient', () => {
    const added = addRow(undefined, item(oil.id, 10));
    const changed = changeRow(added, `a:${oil.id}`, item(chicken.id, 30));

    expect(changed).toEqual([{ item: item(chicken.id, 30) }]);
  });

  it('never mutates the array it was handed', () => {
    const layer: MealAdjustment[] = [{ replaces: chicken.id }];
    skipRow(layer, eggRow);
    restoreRow(layer, chickenRow);
    addRow(layer, item(oil.id, 10));

    expect(layer).toEqual([{ replaces: chicken.id }]);
  });

  it('„Przywróć oryginał" empties the layer', () => {
    expect(clearAdjustments()).toEqual([]);
  });
});

describe('keepOnlyRow', () => {
  it('skips every other recipe row', () => {
    const layer = keepOnlyRow(recipe, undefined, eggRow);

    expect(layer).toEqual([{ replaces: chicken.id }]);
    expect(ids(layer)).toEqual([egg.id]);
  });

  it('keeps a change already made to the row it is keeping', () => {
    const smaller = changeRow(undefined, eggRow, item(egg.id, 2, 'szt', { gramsPerUnit: 50 }));
    const layer = keepOnlyRow(recipe, smaller, eggRow);

    expect(effectiveItems(recipe, layer)).toEqual([item(egg.id, 2, 'szt', { gramsPerUnit: 50 })]);
  });

  it('drops changes made to rows it is skipping', () => {
    const swapped = changeRow(undefined, chickenRow, item(oil.id, 10));
    expect(keepOnlyRow(recipe, swapped, eggRow)).toEqual([{ replaces: chicken.id }]);
  });

  it('keeps an added row and skips the whole recipe', () => {
    const added = addRow(undefined, item(oil.id, 10));
    const layer = keepOnlyRow(recipe, added, `a:${oil.id}`);

    expect(ids(layer)).toEqual([oil.id]);
  });

  it('counts a repeated ingredient once', () => {
    const twiceOiled = makeRecipe({
      items: [item(oil.id, 10), item(chicken.id, 200), item(oil.id, 5)]
    });
    expect(keepOnlyRow(twiceOiled, undefined, chickenRow)).toEqual([{ replaces: oil.id }]);
  });
});

describe('cloneAdjustments', () => {
  it('deep-copies the item and its override, and drops empty changes', () => {
    const layer: MealAdjustment[] = [
      {},
      { replaces: chicken.id, item: item(oil.id, 10, 'g', { macroOverride: macros(1, 2, 3, 4) }) }
    ];
    const copy = cloneAdjustments(layer);

    expect(copy).toEqual([layer[1]]);
    expect(copy[0]).not.toBe(layer[1]);
    expect(copy[0]?.item).not.toBe(layer[1]?.item);
    expect(copy[0]?.item?.macroOverride).not.toBe(layer[1]?.item?.macroOverride);
  });

  it('leaves optional fields absent rather than writing undefined', () => {
    expect(Object.keys(cloneAdjustments([{ replaces: chicken.id }])[0] ?? {})).toEqual([
      'replaces'
    ]);
  });
});

describe('adjustmentKey', () => {
  it('separates a replacement from an addition of the same ingredient', () => {
    expect(adjustmentKey({ replaces: chicken.id })).toBe(chickenRow);
    expect(adjustmentKey({ item: item(chicken.id, 10) })).toBe(`a:${chicken.id}`);
  });
});
