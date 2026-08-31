import { describe, expect, it } from 'vitest';
import {
  activityDate,
  canSaveDraft,
  draftFromRecipe,
  draftMacros,
  draftToRecipe,
  emptyDraftItem,
  filterByBudget,
  filterByTags,
  incompleteDrafts,
  isDraftComplete,
  overrideSeed,
  searchRecipes,
  sortRecipes,
  toRecipeItem,
  toRecipeItems,
  type DraftItem,
  type RecipeListEntry
} from './recipes';
import { ingredientLookup } from './macros';
import { chicken, egg, ingredients, item, macros, makeRecipe } from '../test/fixtures';

const lookup = ingredientLookup(ingredients);

function entry(
  name: string,
  updatedAt: string,
  usage: { plannedCount: number; lastPlannedDate?: string } = { plannedCount: 0 },
  tags: string[] = []
): RecipeListEntry {
  return {
    recipe: makeRecipe({ id: `r-${name}`, name, updatedAt, tags }),
    usage
  };
}

function draft(overrides: Partial<DraftItem> = {}): DraftItem {
  return { ...emptyDraftItem('k1'), ingredientId: chicken.id, amount: 100, ...overrides };
}

describe('activityDate', () => {
  it('takes the later of the edit date and the last planned day', () => {
    expect(
      activityDate(entry('a', '2026-08-01T09:00:00.000Z', { plannedCount: 2, lastPlannedDate: '2026-09-10' }))
    ).toBe('2026-09-10');
    expect(
      activityDate(entry('b', '2026-09-20T09:00:00.000Z', { plannedCount: 2, lastPlannedDate: '2026-09-10' }))
    ).toBe('2026-09-20');
  });

  it('falls back to the edit date when the recipe was never planned', () => {
    expect(activityDate(entry('c', '2026-08-05T09:00:00.000Z'))).toBe('2026-08-05');
  });
});

describe('sortRecipes', () => {
  it('puts the most recent activity first, whether that was an edit or a plan', () => {
    const staple = entry('Staple', '2026-01-01T09:00:00.000Z', {
      plannedCount: 40,
      lastPlannedDate: '2026-09-12'
    });
    const brandNew = entry('Nowy', '2026-09-13T09:00:00.000Z');
    const forgotten = entry('Stary', '2026-02-01T09:00:00.000Z', { plannedCount: 3, lastPlannedDate: '2026-02-02' });

    expect(sortRecipes([forgotten, staple, brandNew]).map((row) => row.recipe.name)).toEqual([
      'Nowy',
      'Staple',
      'Stary'
    ]);
  });

  it('breaks a same-day tie on how often the recipe is planned', () => {
    const rare = entry('Rzadki', '2026-09-13T09:00:00.000Z', { plannedCount: 1 });
    const often = entry('Częsty', '2026-09-13T08:00:00.000Z', { plannedCount: 9 });

    expect(sortRecipes([rare, often]).map((row) => row.recipe.name)).toEqual(['Częsty', 'Rzadki']);
  });

  it('does not mutate the input', () => {
    const list = [entry('B', '2026-09-01T09:00:00.000Z'), entry('A', '2026-09-02T09:00:00.000Z')];
    sortRecipes(list);
    expect(list.map((row) => row.recipe.name)).toEqual(['B', 'A']);
  });
});

describe('filterByTags', () => {
  const list = [
    entry('Obiad', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['obiad', 'szybkie']),
    entry('Kolacja', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['kolacja'])
  ];

  it('keeps everything when nothing is selected', () => {
    expect(filterByTags(list, [])).toHaveLength(2);
  });

  it('requires every selected tag, not any of them', () => {
    expect(filterByTags(list, ['obiad', 'szybkie']).map((row) => row.recipe.name)).toEqual(['Obiad']);
    expect(filterByTags(list, ['obiad', 'kolacja'])).toEqual([]);
  });
});

describe('searchRecipes', () => {
  const list = [
    entry('Zupa pomidorowa', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['obiad']),
    entry('Pomidory z mozzarellą', '2026-09-02T09:00:00.000Z', { plannedCount: 0 }, ['obiad']),
    entry('Naleśniki', '2026-09-03T09:00:00.000Z', { plannedCount: 0 }, ['deser'])
  ];

  it('ranks a prefix match above an infix one', () => {
    expect(searchRecipes(list, 'pomidor').map((row) => row.recipe.name)).toEqual([
      'Pomidory z mozzarellą',
      'Zupa pomidorowa'
    ]);
  });

  it('matches without Polish letters', () => {
    expect(searchRecipes(list, 'nalesniki').map((row) => row.recipe.name)).toEqual(['Naleśniki']);
  });

  it('applies the tag filter before searching', () => {
    expect(searchRecipes(list, 'pomidor', ['deser'])).toEqual([]);
  });

  it('falls back to the default order for a blank query', () => {
    expect(searchRecipes(list, '   ').map((row) => row.recipe.name)).toEqual([
      'Naleśniki',
      'Pomidory z mozzarellą',
      'Zupa pomidorowa'
    ]);
  });
});

describe('draft items', () => {
  it('omits gramsPerUnit on a gram row and keeps it on a piece row', () => {
    expect(toRecipeItem(draft({ unit: 'g', gramsPerUnit: 58 }))).toEqual({
      ingredientId: chicken.id,
      amount: 100,
      unit: 'g'
    });
    expect(toRecipeItem(draft({ unit: 'szt', amount: 2, gramsPerUnit: 58 }))).toEqual({
      ingredientId: chicken.id,
      amount: 2,
      unit: 'szt',
      gramsPerUnit: 58
    });
  });

  it('treats an emptied number field as zero', () => {
    expect(toRecipeItem(draft({ amount: null }))).toEqual({
      ingredientId: chicken.id,
      amount: 0,
      unit: 'g'
    });
  });

  it('writes an override only when one was typed', () => {
    expect(toRecipeItem(draft())).not.toHaveProperty('macroOverride');
    expect(toRecipeItem(draft({ macroOverride: macros(50, 1, 2, 3) })).macroOverride).toEqual(
      macros(50, 1, 2, 3)
    );
  });

  it('drops rows that never got an ingredient', () => {
    expect(toRecipeItems([emptyDraftItem('a'), draft({ key: 'b' })])).toHaveLength(1);
  });

  it('flags a piece row with no weight per piece but still converts it', () => {
    const row = draft({ unit: 'szt', amount: 1, gramsPerUnit: null });
    expect(isDraftComplete(row)).toBe(false);
    expect(incompleteDrafts([row])).toHaveLength(1);
    expect(toRecipeItem(row).amount).toBe(1);
  });

  it('sums the same values as the Phase 2 pure functions', () => {
    const rows = [
      draft({ key: 'a', ingredientId: chicken.id, amount: 200 }),
      draft({ key: 'b', ingredientId: egg.id, amount: 1, unit: 'szt', gramsPerUnit: 50 })
    ];
    // 200 g chicken = 200 kcal, 50 g egg = 100 kcal.
    expect(draftMacros(rows, lookup)).toEqual(macros(300, 45, 1, 9));
  });

  it('an override replaces the database values in the sum', () => {
    const rows = [draft({ amount: 100, macroOverride: macros(500, 0, 0, 0) })];
    expect(draftMacros(rows, lookup).kcal).toBe(500);
  });

  it('seeds an override from the ingredient, and from zeros when there is none', () => {
    expect(overrideSeed(chicken)).toEqual(chicken.per100g);
    expect(overrideSeed(undefined)).toEqual(macros(0, 0, 0, 0));
  });
});

describe('draftToRecipe', () => {
  it('trims, normalizes tag labels to keys and keeps createdAt on an edit', () => {
    const recipe = draftToRecipe(
      {
        name: '  Jajecznica  ',
        instructions: '  Usmaż.  ',
        tagLabels: ['Śniadanie', 'sniadanie', ' '],
        items: [draft()]
      },
      { id: 'r1', createdAt: '2026-01-01T00:00:00.000Z', now: '2026-09-01T00:00:00.000Z' }
    );

    expect(recipe.name).toBe('Jajecznica');
    expect(recipe.instructions).toBe('Usmaż.');
    expect(recipe.tags).toEqual(['sniadanie']);
    expect(recipe.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(recipe.updatedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('stamps createdAt for a new recipe', () => {
    const recipe = draftToRecipe(
      { name: 'Nowy', instructions: '', tagLabels: [], items: [] },
      { id: 'r2', now: '2026-09-01T00:00:00.000Z' }
    );
    expect(recipe.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('only a blank name blocks saving', () => {
    expect(canSaveDraft({ name: ' ', instructions: '', tagLabels: [], items: [] })).toBe(false);
    expect(canSaveDraft({ name: 'X', instructions: '', tagLabels: [], items: [] })).toBe(true);
  });
});

describe('draftFromRecipe', () => {
  it('round-trips a stored recipe through the editor without changing it', () => {
    const recipe = makeRecipe({ items: [item(chicken.id, 200), item(egg.id, 1, 'szt', { gramsPerUnit: 50 })] });
    let n = 0;
    const loaded = draftFromRecipe(recipe, ['Obiad'], () => `k${++n}`);

    expect(loaded.tagLabels).toEqual(['Obiad']);
    expect(toRecipeItems(loaded.items)).toEqual(recipe.items);
  });
});

describe('filterByBudget', () => {
  const entries: RecipeListEntry[] = [
    { recipe: makeRecipe({ id: 'light', name: 'Sałatka' }), usage: { plannedCount: 0 } },
    { recipe: makeRecipe({ id: 'heavy', name: 'Zapiekanka' }), usage: { plannedCount: 0 } },
    { recipe: makeRecipe({ id: 'unknown', name: 'Bez wartości' }), usage: { plannedCount: 0 } }
  ];
  const portions = new Map([
    ['light', macros(300, 20, 10, 5)],
    ['heavy', macros(900, 30, 80, 40)]
  ]);

  it('keeps the recipes whose single portion fits', () => {
    const fitting = filterByBudget(entries, portions, 620);
    expect(fitting.map((entry) => entry.recipe.id)).toEqual(['light', 'unknown']);
  });

  it('a portion exactly on the limit still fits', () => {
    expect(filterByBudget(entries, portions, 300).map((entry) => entry.recipe.id)).toContain(
      'light'
    );
  });

  it('never hides a recipe whose macros are unknown', () => {
    // Hiding it would be a guess, and a recipe silently missing from the picker is the one
    // failure this filter must not have.
    expect(filterByBudget(entries, portions, 10).map((entry) => entry.recipe.id)).toEqual([
      'unknown'
    ]);
  });

  it('leaves the ranking to searchRecipes — it only removes rows', () => {
    const filtered = filterByBudget(entries, portions, 5000);
    expect(filtered.map((entry) => entry.recipe.id)).toEqual(['light', 'heavy', 'unknown']);
  });
});
