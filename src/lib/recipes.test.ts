import { describe, expect, it } from 'vitest';
import {
  activityDate,
  applyMeasure,
  canSaveDraft,
  draftFromRecipe,
  draftFromRecipeItem,
  draftMacros,
  draftToRecipe,
  budgetFit,
  duplicateRecipe,
  emptyDraft,
  emptyDraftItem,
  countWithoutPrepMinutes,
  filterByPrepMinutes,
  filterByTags,
  fitToBudget,
  groupByTag,
  incompleteDrafts,
  isDraftComplete,
  isPrepMinutesValid,
  isRecipeSort,
  measureChoices,
  readPrepMinutes,
  overrideSeed,
  searchRecipes,
  sortRecipes,
  toRecipeItem,
  toRecipeItems,
  type DraftItem,
  type RecipeDraft,
  type RecipeListEntry
} from './recipes';
import type { Macros, Tag } from './types';
import { ingredientLookup, itemGrams, itemMacros } from './macros';
import { chicken, egg, garlic, ingredients, item, macros, makeRecipe } from '../test/fixtures';

const lookup = ingredientLookup(ingredients);

function entry(
  name: string,
  updatedAt: string,
  usage: { plannedCount: number; lastPlannedDate?: string } = { plannedCount: 0 },
  tags: string[] = [],
  prepMinutes?: number
): RecipeListEntry {
  return {
    recipe: makeRecipe({
      id: `r-${name}`,
      name,
      updatedAt,
      tags,
      ...(prepMinutes === undefined ? {} : { prepMinutes })
    }),
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

describe('preparation time', () => {
  const quick = entry('Jajecznica', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['obiad'], 10);
  const medium = entry('Gulasz', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['obiad'], 30);
  const untimed = entry('Rosół', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['obiad']);
  const list = [quick, medium, untimed];

  it('reads only a whole number of minutes above zero', () => {
    expect(readPrepMinutes(20)).toBe(20);
    expect(readPrepMinutes(null)).toBeUndefined();
    expect(readPrepMinutes(undefined)).toBeUndefined();
    expect(readPrepMinutes(0)).toBeUndefined();
    expect(readPrepMinutes(-5)).toBeUndefined();
    expect(readPrepMinutes(12.5)).toBeUndefined();
    expect(readPrepMinutes(Number.NaN)).toBeUndefined();
    expect(readPrepMinutes(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('accepts an empty field but not a zero or a negative', () => {
    expect(isPrepMinutesValid(null)).toBe(true);
    expect(isPrepMinutesValid(20)).toBe(true);
    expect(isPrepMinutesValid(0)).toBe(false);
    expect(isPrepMinutesValid(-1)).toBe(false);
  });

  it('keeps everything when the filter is off', () => {
    expect(filterByPrepMinutes(list)).toHaveLength(3);
  });

  it('keeps what fits the ceiling and hides what has no time at all', () => {
    expect(filterByPrepMinutes(list, 15).map((row) => row.recipe.name)).toEqual(['Jajecznica']);
    // 30 is „do 30 min", inclusively — and the untimed recipe is out either way.
    expect(filterByPrepMinutes(list, 30).map((row) => row.recipe.name)).toEqual([
      'Jajecznica',
      'Gulasz'
    ]);
  });

  it('counts what the filter hides, so the empty state can say so', () => {
    expect(countWithoutPrepMinutes(list)).toBe(1);
    expect(countWithoutPrepMinutes([quick, medium])).toBe(0);
  });

  it('combines with the tag chips and with the query', () => {
    const tagged = [
      quick,
      medium,
      entry('Sałatka', '2026-09-01T09:00:00.000Z', { plannedCount: 0 }, ['kolacja'], 5)
    ];

    expect(
      searchRecipes(tagged, '', ['obiad'], { maxPrepMinutes: 15 }).map((row) => row.recipe.name)
    ).toEqual(['Jajecznica']);
    expect(searchRecipes(tagged, 'gulasz', [], { maxPrepMinutes: 15 })).toEqual([]);
    expect(
      searchRecipes(tagged, 'gulasz', [], { maxPrepMinutes: 60 }).map((row) => row.recipe.name)
    ).toEqual(['Gulasz']);
  });

  it('hides nothing for its time when no ceiling is given', () => {
    // Same activity date throughout, so the tie-break is the Polish alphabet.
    expect(searchRecipes(list, '').map((row) => row.recipe.name)).toEqual([
      'Gulasz',
      'Jajecznica',
      'Rosół'
    ]);
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

describe('searchRecipes by what is in the house (Phase 18 task B)', () => {
  /** An entry whose recipe holds the named ingredient ids. */
  const holding = (name: string, ingredientIds: string[], plannedCount = 0): RecipeListEntry => ({
    recipe: makeRecipe({
      id: `r-${name}`,
      name,
      updatedAt: '2026-09-01T09:00:00.000Z',
      items: ingredientIds.map((id) => item(id, 100))
    }),
    usage: { plannedCount }
  });

  /** What `ingredientIndex.keysById()` hands over: name key first, then the alias keys. */
  const keys: ReadonlyMap<string, readonly string[]> = new Map([
    ['i-soczewica', ['soczewica czerwona', 'soczewica']],
    ['i-kurczak', ['piers z kurczaka', 'kurczak', 'filet']],
    ['i-ser', ['ser bialy']]
  ]);

  const library = [
    holding('Soczewica z curry', ['i-kurczak']),
    holding('Zupa dnia', ['i-soczewica', 'i-ser'], 4),
    holding('Placki', ['i-soczewica'], 1),
    holding('Sernik', ['i-ser'])
  ];

  const found = (query: string) =>
    searchRecipes(library, query, [], { ingredientKeys: keys }).map((row) => row.recipe.name);

  it('lists recipes that contain the thing, below every recipe named after it', () => {
    expect(found('soczewica')).toEqual(['Soczewica z curry', 'Zupa dnia', 'Placki']);
  });

  it('keeps „Sernik" first for „sernik", ahead of anything merely containing cheese', () => {
    // „ser" is *exactly* what „Zupa dnia" holds and only an infix of „Sernik". The name wins.
    expect(found('ser')).toEqual(['Sernik', 'Zupa dnia']);
    expect(found('sernik')[0]).toBe('Sernik');
  });

  it('matches an ingredient alias too', () => {
    // Nothing is called „kurczak"; one recipe uses „Pierś z kurczaka", whose alias it is.
    expect(found('kurczak')).toEqual(['Soczewica z curry']);
    expect(found('filet')).toEqual(['Soczewica z curry']);
  });

  it('searches names only when no keys are handed over — Phase 17 behaviour, unchanged', () => {
    expect(searchRecipes(library, 'soczewica').map((row) => row.recipe.name)).toEqual([
      'Soczewica z curry'
    ]);
    expect(searchRecipes(library, 'kurczak')).toEqual([]);
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
        items: [draft()],
        sourceUrl: '',
        prepMinutes: null
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
      { name: 'Nowy', instructions: '', tagLabels: [], items: [], sourceUrl: '', prepMinutes: null },
      { id: 'r2', now: '2026-09-01T00:00:00.000Z' }
    );
    expect(recipe.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a blank name blocks saving, and so does a time that is not a time', () => {
    const base = { instructions: '', tagLabels: [], items: [], sourceUrl: '', prepMinutes: null };
    expect(canSaveDraft({ ...base, name: ' ' })).toBe(false);
    expect(canSaveDraft({ ...base, name: 'X' })).toBe(true);

    // Optional: an empty field saves. Zero, a negative and a fraction do not.
    expect(canSaveDraft({ ...base, name: 'X', prepMinutes: 20 })).toBe(true);
    expect(canSaveDraft({ ...base, name: 'X', prepMinutes: 0 })).toBe(false);
    expect(canSaveDraft({ ...base, name: 'X', prepMinutes: -5 })).toBe(false);
    expect(canSaveDraft({ ...base, name: 'X', prepMinutes: 12.5 })).toBe(false);
  });

  it('writes a preparation time, and omits the field entirely when there is none', () => {
    const base = { instructions: '', tagLabels: [], items: [], sourceUrl: '', prepMinutes: null };
    const options = { id: 'r3', now: '2026-09-01T00:00:00.000Z' };

    expect(draftToRecipe({ ...base, name: 'Z czasem', prepMinutes: 20 }, options).prepMinutes).toBe(20);
    // Absent, not zero: „nobody timed this" is not „it takes no time" (PLAN.md Phase 20).
    expect('prepMinutes' in draftToRecipe({ ...base, name: 'Bez czasu' }, options)).toBe(false);
    expect(
      'prepMinutes' in draftToRecipe({ ...base, name: 'Zero', prepMinutes: 0 }, options)
    ).toBe(false);
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

describe('the recipe source', () => {
  const now = '2026-09-03T00:00:00.000Z';

  it('survives the editor unchanged', () => {
    const recipe = makeRecipe({ sourceUrl: 'https://kwestiasmaku.com/przepis/zurek' });
    const loaded = draftFromRecipe(recipe, [], () => 'k1');

    expect(loaded.sourceUrl).toBe('https://kwestiasmaku.com/przepis/zurek');
    expect(draftToRecipe(loaded, { id: recipe.id, now }).sourceUrl).toBe(recipe.sourceUrl);
  });

  it('is absent, never empty, on a recipe that came from nowhere', () => {
    // An absent source and an empty one must not be two different things in the Drive JSON.
    const written = draftToRecipe(emptyDraft2('Jajecznica'), { id: 'r1', now });
    expect('sourceUrl' in written).toBe(false);
  });

  it('is cleared by emptying the field, so a rewritten recipe stops claiming a page', () => {
    const loaded = draftFromRecipe(
      makeRecipe({ sourceUrl: 'https://example.com/a' }),
      [],
      () => 'k1'
    );
    loaded.sourceUrl = '';
    expect('sourceUrl' in draftToRecipe(loaded, { id: 'r1', now })).toBe(false);
  });

  it('travels with a copy — a variant still came from the same page', () => {
    const copy = duplicateRecipe(makeRecipe({ sourceUrl: 'https://example.com/a' }), {
      id: 'r2',
      now
    });
    expect(copy.sourceUrl).toBe('https://example.com/a');
  });
});

/** A draft with a name and nothing else, for the assertions above. */
function emptyDraft2(name: string): RecipeDraft {
  return { ...emptyDraft(), name };
}

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

  it('carries the preparation time to the copy', () => {
    const original = makeRecipe({ prepMinutes: 25 });
    expect(duplicateRecipe(original, { id: 'r2', now: 'now' }).prepMinutes).toBe(25);
    expect(
      'prepMinutes' in duplicateRecipe(makeRecipe({}), { id: 'r3', now: 'now' })
    ).toBe(false);
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

describe('household measures on a recipe row (Phase 16)', () => {
  it('sets unit, label and weight in one act, and the macros equal typing szt + 5 by hand', () => {
    const chip = emptyDraftItem('row-1');
    chip.ingredientId = garlic.id;
    chip.amount = 2;
    applyMeasure(chip, { name: 'ząbek', grams: 5 });

    const byHand = emptyDraftItem('row-2');
    byHand.ingredientId = garlic.id;
    byHand.amount = 2;
    byHand.unit = 'szt';
    byHand.gramsPerUnit = 5;

    expect(chip.unit).toBe('szt');
    expect(chip.gramsPerUnit).toBe(5);
    expect(chip.measureName).toBe('ząbek');
    // The whole claim of decision 323: a measure is a label, so the arithmetic is identical.
    expect(itemGrams(toRecipeItem(chip))).toBe(itemGrams(toRecipeItem(byHand)));
    expect(itemMacros(toRecipeItem(chip), garlic)).toEqual(itemMacros(toRecipeItem(byHand), garlic));
  });

  it('leaves a fresh row on grams, so typing 100 after picking still means 100 grams', () => {
    const draft = emptyDraftItem('row-1');
    draft.ingredientId = garlic.id;
    draft.amount = 100;

    expect(draft.unit).toBe('g');
    expect(measureChoices(draft, garlic)).toHaveLength(2);
    expect(itemGrams(toRecipeItem(draft))).toBe(100);
  });

  it('stores the label only on a szt row', () => {
    const draft = emptyDraftItem('row-1');
    draft.ingredientId = garlic.id;
    draft.amount = 2;
    applyMeasure(draft, { name: 'ząbek', grams: 5 });
    expect(toRecipeItem(draft).measureName).toBe('ząbek');

    // Switching the unit back drops a label nothing would ever print.
    draft.unit = 'g';
    expect(toRecipeItem(draft)).not.toHaveProperty('measureName');
  });

  it('round-trips through the draft, and an item without a measure stays without one', () => {
    const labelled = item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' });
    expect(toRecipeItem(draftFromRecipeItem(labelled, 'row-1'))).toEqual(labelled);

    const plain = item(egg.id, 2, 'szt', { gramsPerUnit: 58 });
    expect(toRecipeItem(draftFromRecipeItem(plain, 'row-2'))).toEqual(plain);
  });

  it('keeps offering a measure the ingredient has since dropped, with the row\u2019s own weight', () => {
    const draft = draftFromRecipeItem(
      item(garlic.id, 2, 'szt', { gramsPerUnit: 7, measureName: 'ząbek' }),
      'row-1'
    );
    // The library forgot cloves; the recipe did not.
    const forgetful = { ...garlic, measures: [{ name: 'szt.' as const, grams: 45 }] };

    expect(measureChoices(draft, forgetful)).toEqual([
      { name: 'szt.', grams: 45 },
      { name: 'ząbek', grams: 7 }
    ]);
    // Label, weight and macros are all the row's own, untouched by the library.
    const wire = toRecipeItem(draft);
    expect(wire.measureName).toBe('ząbek');
    expect(wire.gramsPerUnit).toBe(7);
    expect(itemGrams(wire)).toBe(14);
  });

  it('offers nothing for an ingredient with no measures, which is most of them', () => {
    const draft = emptyDraftItem('row-1');
    draft.ingredientId = chicken.id;
    expect(measureChoices(draft, chicken)).toEqual([]);
    expect(measureChoices(draft, undefined)).toEqual([]);
  });

  it('copies the label into a duplicated recipe', () => {
    const original = makeRecipe({
      items: [item(garlic.id, 2, 'szt', { gramsPerUnit: 5, measureName: 'ząbek' })]
    });
    const copy = duplicateRecipe(original, { id: 'r2', now: '2026-09-11T10:00:00.000Z' });
    expect(copy.items[0]?.measureName).toBe('ząbek');
  });
});
