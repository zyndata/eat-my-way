import { describe, expect, it } from 'vitest';
import {
  activityDate,
  canSaveDraft,
  draftFromRecipe,
  draftMacros,
  draftToRecipe,
  budgetFit,
  duplicateRecipe,
  emptyDraftItem,
  filterByTags,
  fitToBudget,
  groupByTag,
  incompleteDrafts,
  isDraftComplete,
  isRecipeSort,
  overrideSeed,
  searchRecipes,
  sortRecipes,
  toRecipeItem,
  toRecipeItems,
  type DraftItem,
  type RecipeListEntry
} from './recipes';
import type { Macros, Tag } from './types';
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
    expect(toRecipeItems([emptyDraftItem('a'), draft({ id: 'b' })])).toHaveLength(1);
  });

  it('flags a piece row with no weight per piece but still converts it', () => {
    const row = draft({ unit: 'szt', amount: 1, gramsPerUnit: null });
    expect(isDraftComplete(row)).toBe(false);
    expect(incompleteDrafts([row])).toHaveLength(1);
    expect(toRecipeItem(row).amount).toBe(1);
  });

  it('sums the same values as the Phase 2 pure functions', () => {
    const rows = [
      draft({ id: 'a', ingredientId: chicken.id, amount: 200 }),
      draft({ id: 'b', ingredientId: egg.id, amount: 1, unit: 'szt', gramsPerUnit: 50 })
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

describe('fitToBudget', () => {
  const entries: RecipeListEntry[] = [
    { recipe: makeRecipe({ id: 'light', name: 'Sałatka' }), usage: { plannedCount: 0 } },
    { recipe: makeRecipe({ id: 'heavy', name: 'Zapiekanka' }), usage: { plannedCount: 0 } },
    { recipe: makeRecipe({ id: 'unknown', name: 'Bez wartości' }), usage: { plannedCount: 0 } }
  ];
  const portions = new Map<string, Macros>([
    ['light', macros(300, 20, 10, 5)],
    ['heavy', macros(900, 30, 80, 40)]
  ]);

  const ids = (rows: ReadonlyArray<{ entry: RecipeListEntry }>): string[] =>
    rows.map((row) => row.entry.recipe.id);

  it('marks a recipe that fits whole as full', () => {
    const fitted = fitToBudget(entries, portions, 620);
    expect(fitted.find((row) => row.entry.recipe.id === 'light')?.fit).toBe('full');
    expect(fitted.find((row) => row.entry.recipe.id === 'unknown')?.fit).toBe('full');
  });

  it('a portion exactly on the limit still fits whole', () => {
    const fitted = fitToBudget(entries, portions, 300);
    expect(fitted.find((row) => row.entry.recipe.id === 'light')?.fit).toBe('full');
  });

  it('offers half a portion for a recipe that does not fit whole', () => {
    // 900 kcal against 500 left: half of it is 450, which fits.
    const fitted = fitToBudget(entries, portions, 500);
    expect(fitted.find((row) => row.entry.recipe.id === 'heavy')?.fit).toBe('half');
  });

  it('does not offer anything below half a portion', () => {
    // 900 kcal against 400 left: half is 450, still too much, so the recipe is gone.
    expect(ids(fitToBudget(entries, portions, 400))).not.toContain('heavy');
  });

  it('never hides a recipe whose macros are unknown', () => {
    // Hiding it would be a guess, and a recipe silently missing from the picker is the one
    // failure this filter must not have.
    expect(ids(fitToBudget(entries, portions, 10))).toEqual(['unknown']);
  });

  it('only removes rows — it never reorders them', () => {
    expect(ids(fitToBudget(entries, portions, 5000))).toEqual(['light', 'heavy', 'unknown']);
    // And with the heavy one demoted to half, the order is still the input order.
    expect(ids(fitToBudget(entries, portions, 500))).toEqual(['light', 'heavy', 'unknown']);
  });
});

describe('budgetFit', () => {
  it('reports how one recipe stands, without a list', () => {
    expect(budgetFit(macros(300, 0, 0, 0), 620)).toBe('full');
    expect(budgetFit(macros(900, 0, 0, 0), 500)).toBe('half');
    expect(budgetFit(macros(900, 0, 0, 0), 400)).toBeUndefined();
    expect(budgetFit(undefined, 400)).toBeUndefined();
  });
});

describe('sortRecipes', () => {
  const list: RecipeListEntry[] = [
    entry('Zupa', '2026-09-01T00:00:00.000Z', { plannedCount: 1 }),
    entry('Ananas', '2026-08-01T00:00:00.000Z', { plannedCount: 5 }),
    entry('Śledź', '2026-08-15T00:00:00.000Z', { plannedCount: 0 })
  ];
  const portions = new Map<string, Macros>([
    ['r-Zupa', macros(120, 5, 10, 2)],
    ['r-Ananas', macros(400, 5, 10, 2)]
  ]);

  const names = (rows: readonly RecipeListEntry[]): string[] => rows.map((row) => row.recipe.name);

  it('defaults to recent activity', () => {
    expect(names(sortRecipes(list))).toEqual(['Zupa', 'Śledź', 'Ananas']);
  });

  it('sorts by name using the Polish alphabet', () => {
    expect(names(sortRecipes(list, 'name'))).toEqual(['Ananas', 'Śledź', 'Zupa']);
  });

  it('sorts by kcal per portion, lightest first, unknown last', () => {
    expect(names(sortRecipes(list, 'kcal', portions))).toEqual(['Zupa', 'Ananas', 'Śledź']);
  });

  it('recognizes a stored order and rejects anything else', () => {
    expect(isRecipeSort('kcal')).toBe(true);
    expect(isRecipeSort('kalorie')).toBe(false);
    expect(isRecipeSort(undefined)).toBe(false);
  });

  it('a typed query overrides the chosen order', () => {
    const found = searchRecipes(list, 'zup', [], { sort: 'name' });
    expect(names(found)).toEqual(['Zupa']);
  });
});

describe('groupByTag', () => {
  const tag = (key: string, label: string, useCount: number): Tag => ({ key, label, useCount });
  const tags = [tag('obiad', 'Obiad', 3), tag('szybkie', 'Szybkie', 2), tag('pusty', 'Pusty', 0)];

  const list: RecipeListEntry[] = [
    entry('Kotlet', '2026-09-01T00:00:00.000Z', { plannedCount: 0 }, ['obiad']),
    entry('Omlet', '2026-08-01T00:00:00.000Z', { plannedCount: 0 }, ['obiad', 'szybkie']),
    entry('Kanapka', '2026-07-01T00:00:00.000Z', { plannedCount: 0 }, [])
  ];

  it('lists every recipe at least once and a multi-tagged one under each of its tags', () => {
    const groups = groupByTag(list, tags);
    expect(groups.map((group) => group.label)).toEqual(['Obiad', 'Szybkie', 'Bez tagu']);
    expect(groups[0]?.entries.map((row) => row.recipe.name)).toEqual(['Kotlet', 'Omlet']);
    expect(groups[1]?.entries.map((row) => row.recipe.name)).toEqual(['Omlet']);

    // Nothing is lost: every recipe appears somewhere.
    const seen = new Set(groups.flatMap((group) => group.entries.map((row) => row.recipe.id)));
    expect(seen.size).toBe(list.length);
  });

  it('untagged recipes get their own section, last', () => {
    const groups = groupByTag(list, tags);
    expect(groups.at(-1)?.label).toBe('Bez tagu');
    expect(groups.at(-1)?.entries.map((row) => row.recipe.name)).toEqual(['Kanapka']);
  });

  it('the counts sum to more than the library holds — a recipe is in each of its sections', () => {
    const total = groupByTag(list, tags).reduce((sum, group) => sum + group.entries.length, 0);
    expect(total).toBe(4);
    expect(total).toBeGreaterThan(list.length);
  });

  it('a tag no visible recipe carries produces no section', () => {
    expect(groupByTag(list, tags).map((group) => group.key)).not.toContain('pusty');
  });

  it('keeps the order it was handed inside each section', () => {
    const byName = sortRecipes(list, 'name');
    const groups = groupByTag(byName, tags);
    expect(groups[0]?.entries.map((row) => row.recipe.name)).toEqual(['Kotlet', 'Omlet']);
  });
});

describe('duplicateRecipe', () => {
  it('is a deep, independent copy that carries the tags', () => {
    const original = makeRecipe({
      id: 'r1',
      name: 'Ryż z warzywami',
      tags: ['obiad'],
      items: [item(chicken.id, 200), item(egg.id, 1, 'szt', { gramsPerUnit: 50 })],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const copy = duplicateRecipe(original, { id: 'r2', now: '2026-09-02T10:00:00.000Z' });

    expect(copy.id).toBe('r2');
    expect(copy.name).toBe('Ryż z warzywami (kopia)');
    expect(copy.tags).toEqual(['obiad']);
    expect(copy.items).toEqual(original.items);
    expect(copy.createdAt).toBe('2026-09-02T10:00:00.000Z');
    expect(copy.updatedAt).toBe('2026-09-02T10:00:00.000Z');

    // Editing the copy must not reach the original — the whole point of the feature.
    copy.items[0]!.amount = 999;
    copy.tags.push('kolacja');
    expect(original.items[0]?.amount).toBe(200);
    expect(original.tags).toEqual(['obiad']);
  });

  it('copies a per-item override by value', () => {
    const original = makeRecipe({
      items: [item(chicken.id, 100, 'g', { macroOverride: macros(500, 1, 2, 3) })]
    });
    const copy = duplicateRecipe(original, { id: 'r2', now: '2026-09-02T10:00:00.000Z' });

    copy.items[0]!.macroOverride!.kcal = 1;
    expect(original.items[0]?.macroOverride?.kcal).toBe(500);
  });

  it('does not carry the photo over — two recipes must not own one Drive file', () => {
    const original = { ...makeRecipe({ id: 'r1' }), photoFileId: 'drive-1' };
    expect(duplicateRecipe(original, { id: 'r2', now: 'x' })).not.toHaveProperty('photoFileId');
  });
});
