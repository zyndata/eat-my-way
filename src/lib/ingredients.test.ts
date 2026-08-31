import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EatMyWayDb } from './db';
import type { Ingredient } from './types';
import { createRepository, type Repository } from './repository';
import { createIngredientIndex } from './ingredients';
import { freshDb, makeRecipe, item } from '../test/fixtures';

function ingredient(id: string, name: string, aliases: string[] = []): Ingredient {
  return {
    id,
    name,
    aliases,
    state: 'raw',
    per100g: { kcal: 100, protein: 10, carbs: 10, fat: 1 },
    source: 'usda'
  };
}

const cheese = ingredient('usda:1', 'Ser żółty gouda', ['gouda', 'ser zolty']);
const feta = ingredient('usda:2', 'Ser feta', ['feta']);
const dessert = ingredient('usda:3', 'Deser ryżowy');
const potato = ingredient('usda:4', 'Ziemniaki', ['kartofle']);

describe('ingredient index', () => {
  let database: EatMyWayDb;
  let repository: Repository;

  beforeEach(async () => {
    database = freshDb();
    await database.open();
    repository = createRepository(database);
    await repository.putIngredients([cheese, feta, dessert, potato]);
  });

  afterEach(async () => {
    await database.delete();
  });

  it('searches the local database without diacritics', async () => {
    const index = createIngredientIndex(repository);
    const found = await index.search('zolty ser');

    expect(found.map((match) => match.ingredient.name)).toEqual(['Ser żółty gouda']);
  });

  it('uses the normalized keys IndexedDB already stores', async () => {
    // Written through the repository, so nameKey/aliasKeys were derived on write.
    const rows = await repository.ingredientSearchIndex();
    const gouda = rows.find((row) => row.ingredient.id === cheese.id);

    expect(gouda?.nameKey).toBe('ser zolty gouda');
    expect(gouda?.aliasKeys).toEqual(['gouda', 'ser zolty']);
  });

  it('ranks an ingredient used in a recipe above an unused one', async () => {
    const index = createIngredientIndex(repository);
    expect((await index.search('ser'))[0]?.ingredient.name).toBe('Ser feta');

    await repository.saveRecipe(makeRecipe({ id: 'r1', items: [item(cheese.id, 50)] }));
    index.invalidate();

    const found = await index.search('ser');
    expect(found[0]?.ingredient.name).toBe('Ser żółty gouda');
    expect(found[0]?.useCount).toBe(1);
    // Still ranked by match quality first: the infix hit stays last.
    expect(found.at(-1)?.ingredient.name).toBe('Deser ryżowy');
  });

  it('counts an ingredient once per recipe, however many rows use it', async () => {
    await repository.saveRecipe(
      makeRecipe({ id: 'r1', items: [item(potato.id, 100), item(potato.id, 50)] })
    );

    expect(await repository.ingredientUseCounts()).toEqual(new Map([[potato.id, 1]]));
  });

  it('caches until invalidated', async () => {
    const index = createIngredientIndex(repository);
    await index.warm();

    await repository.putIngredient(ingredient('custom:1', 'Serek wiejski'));
    expect((await index.search('serek')).length).toBe(0);

    index.invalidate();
    expect((await index.search('serek'))[0]?.ingredient.name).toBe('Serek wiejski');
  });
});
