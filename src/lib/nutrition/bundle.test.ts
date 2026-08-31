import { describe, expect, it } from 'vitest';
import raw from './ingredients.json?raw';
import type { Ingredient } from '../types';
import { normalizeKey } from '../text';
import { rankCandidates } from '../search';
import { NUTRITION_DATA_VERSION, NUTRITION_INGREDIENT_COUNT, NUTRITION_SOURCES } from './meta';

/**
 * Tests over the generated bundle itself. It is pulled in with `?raw` rather than as a
 * module, so these assertions are about the committed artefact — the exact bytes the
 * browser fetches, formatting included.
 */

const bytes = new TextEncoder().encode(raw).length;
const bundle = JSON.parse(raw) as {
  dataVersion: number;
  sources: string[];
  attribution: string;
  ingredients: Ingredient[];
};

/** Ingredients whose names contain `needle`, in the same normalized form the app searches. */
function named(needle: string): Ingredient[] {
  const key = normalizeKey(needle);
  return bundle.ingredients.filter((ingredient) => normalizeKey(ingredient.name).includes(key));
}

describe('bundled nutrition data', () => {
  it('matches the generated meta constants', () => {
    expect(bundle.dataVersion).toBe(NUTRITION_DATA_VERSION);
    expect(bundle.ingredients).toHaveLength(NUTRITION_INGREDIENT_COUNT);
    expect(bundle.sources).toEqual([...NUTRITION_SOURCES]);
  });

  it('holds 800-1500 ingredients in 200-400 kB, as PLAN.md specifies', () => {
    expect(bundle.ingredients.length).toBeGreaterThanOrEqual(800);
    expect(bundle.ingredients.length).toBeLessThanOrEqual(1500);

    expect(bytes).toBeGreaterThanOrEqual(200_000);
    expect(bytes).toBeLessThanOrEqual(400_000);
  });

  it('credits FoodData Central', () => {
    expect(bundle.attribution).toContain('FoodData Central');
  });

  it('gives every ingredient a namespaced id, a Polish name and complete macros', () => {
    const ids = new Set<string>();
    for (const ingredient of bundle.ingredients) {
      expect(ingredient.id).toMatch(/^usda:\d+$/);
      expect(ids.has(ingredient.id)).toBe(false);
      ids.add(ingredient.id);

      expect(ingredient.name.trim()).not.toBe('');
      expect(ingredient.source).toBe('usda');
      expect(['raw', 'cooked']).toContain(ingredient.state);

      for (const macro of [
        ingredient.per100g.kcal,
        ingredient.per100g.protein,
        ingredient.per100g.carbs,
        ingredient.per100g.fat
      ]) {
        expect(Number.isFinite(macro)).toBe(true);
        expect(macro).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('has no duplicate display names', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const ingredient of bundle.ingredients) {
      const key = normalizeKey(ingredient.name);
      if (seen.has(key)) duplicates.push(ingredient.name);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it.each([
    ['ziemniak', 'ziemniaki'],
    ['ryż', 'ryz bialy'],
    ['pierś z kurczaka', 'piers z kurczaka']
  ])('has a raw and a cooked variant of %s', (_label, needle) => {
    const variants = named(needle);
    expect(variants.some((ingredient) => ingredient.state === 'raw')).toBe(true);
    expect(variants.some((ingredient) => ingredient.state === 'cooked')).toBe(true);
  });

  it('gives raw and cooked variants different macros', () => {
    const rawPotato = bundle.ingredients.find((i) => i.name === 'Ziemniaki');
    const cookedPotato = bundle.ingredients.find((i) => i.name === 'Ziemniaki gotowane');
    expect(rawPotato?.per100g).not.toEqual(cookedPotato?.per100g);

    const rawRice = bundle.ingredients.find((i) => i.name === 'Ryż biały');
    const cookedRice = bundle.ingredients.find((i) => i.name === 'Ryż biały gotowany');
    // Cooked rice absorbs water, so it must be far lighter per 100 g than dry rice.
    expect(cookedRice!.per100g.kcal).toBeLessThan(rawRice!.per100g.kcal / 2);
  });

  it('finds „ser żółty" from a query typed without Polish letters', () => {
    const candidates = bundle.ingredients.map((ingredient) => ({
      ingredient,
      nameKey: normalizeKey(ingredient.name),
      aliasKeys: ingredient.aliases.map(normalizeKey),
      useCount: 0
    }));

    const found = rankCandidates('zolty ser', candidates, 5);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.item.ingredient.name).toContain('Ser żółty');
  });

  it('is serialized one ingredient per line, so diffs stay readable', () => {
    const lines: string[] = raw.split('\n');
    expect(lines.filter((line) => line.startsWith('    {"id":'))).toHaveLength(
      bundle.ingredients.length
    );
  });
});
