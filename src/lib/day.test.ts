import { describe, expect, it } from 'vitest';
import {
  addMeals,
  clearDay,
  clonePlannedMeal,
  clonePlannedMeals,
  copyMealsInto,
  duplicateMealInDay,
  emptyDay,
  findMeal,
  planMeal,
  removeMeal,
  reorderMeals,
  withGoals
} from './day';
import { dayTotals, ingredientLookup, mealMacros } from './macros';
import type { Day, PlannedMeal } from './types';
import { chicken, ingredients, item, macros, makeRecipe, seqIds } from '../test/fixtures';

const lookup = ingredientLookup(ingredients);
const goals = macros(2000, 100, 250, 70);

function mealOf(id: string, kcal: number): PlannedMeal {
  return {
    id,
    recipeId: 'recipe-1',
    cookingScale: 1,
    portionsEaten: 1,
    macroSnapshot: macros(kcal, 10, 20, 5)
  };
}

describe('planMeal', () => {
  it('freezes the recipe per-portion macros at add time', () => {
    const meal = planMeal(makeRecipe(), lookup, { id: 'meal-1' });
    expect(meal.macroSnapshot).toEqual(macros(300, 45, 1, 9));
    expect(meal.cookingScale).toBe(1);
    expect(meal.portionsEaten).toBe(1);
  });

  it('is unaffected by a later edit of the recipe it came from', () => {
    const recipe = makeRecipe();
    const meal = planMeal(recipe, lookup, { id: 'meal-1' });

    const edited = { ...recipe, items: [item(chicken.id, 1000)] };
    expect(planMeal(edited, lookup, { id: 'meal-2' }).macroSnapshot.kcal).toBe(1000);
    expect(meal.macroSnapshot.kcal).toBe(300);
  });
});

describe('clonePlannedMeal', () => {
  const source = planMeal(makeRecipe(), lookup, {
    id: 'meal-1',
    cookingScale: 2,
    portionsEaten: 1.5
  });

  it('takes a new id and carries the snapshot over unchanged', () => {
    const copy = clonePlannedMeal(source, 'meal-2');

    expect(copy.id).toBe('meal-2');
    expect(copy.macroSnapshot).toEqual(source.macroSnapshot);
    expect(copy.cookingScale).toBe(2);
    expect(copy.portionsEaten).toBe(1.5);
  });

  it('deep copies the snapshot, so the copy shares no object with the source', () => {
    const copy = clonePlannedMeal(source, 'meal-2');
    expect(copy.macroSnapshot).not.toBe(source.macroSnapshot);

    source.macroSnapshot.kcal = 9999;
    expect(copy.macroSnapshot.kcal).toBe(300);
  });

  it('gives every meal of a list its own id', () => {
    const copies = clonePlannedMeals([mealOf('a', 100), mealOf('b', 200)], seqIds('copy'));
    expect(copies.map((meal) => meal.id)).toEqual(['copy-1', 'copy-2']);
  });
});

describe('goalSnapshot', () => {
  it('is captured when the first meal lands on the day', () => {
    const day = addMeals(emptyDay('2026-09-03'), [mealOf('a', 500)], goals);
    expect(day.goalSnapshot).toEqual(goals);
  });

  it('is not captured on a day that stays empty', () => {
    expect(addMeals(emptyDay('2026-09-03'), [], goals).goalSnapshot).toBeUndefined();
  });

  it('is not rewritten when the goals change later', () => {
    const first = addMeals(emptyDay('2026-09-03'), [mealOf('a', 500)], goals);
    const second = addMeals(first, [mealOf('b', 300)], macros(1500, 90, 150, 50));

    expect(second.goalSnapshot).toEqual(goals);
  });

  it('is applied directly by withGoals, and only to a day that has meals', () => {
    const planned: Day = { date: '2026-09-03', meals: [mealOf('a', 500)] };
    expect(withGoals(planned, goals).goalSnapshot).toEqual(goals);
    expect(withGoals(emptyDay('2026-09-03'), goals).goalSnapshot).toBeUndefined();
    expect(withGoals(planned, undefined).goalSnapshot).toBeUndefined();
  });

  it('is dropped again once the day has no meals left', () => {
    const day = addMeals(emptyDay('2026-09-03'), [mealOf('a', 500)], goals);
    expect(removeMeal(day, 'a').goalSnapshot).toBeUndefined();
    expect(clearDay(day)).toEqual(emptyDay('2026-09-03'));
  });
});

describe('meal list operations', () => {
  const day: Day = addMeals(
    emptyDay('2026-09-03'),
    [mealOf('a', 100), mealOf('b', 200), mealOf('c', 300)],
    goals
  );

  it('inserts a duplicate directly after its original', () => {
    const result = duplicateMealInDay(day, 'b', 'b-copy');
    expect(result.meals.map((meal) => meal.id)).toEqual(['a', 'b', 'b-copy', 'c']);
    expect(findMeal(result, 'b-copy')?.macroSnapshot).toEqual(macros(200, 10, 20, 5));
  });

  it('leaves the day untouched when the meal id is unknown', () => {
    expect(duplicateMealInDay(day, 'nope', 'x')).toBe(day);
    expect(removeMeal(day, 'nope')).toBe(day);
  });

  it('removes by id, keeping array order as the display order', () => {
    expect(removeMeal(day, 'b').meals.map((meal) => meal.id)).toEqual(['a', 'c']);
  });

  it('reorders within the day', () => {
    expect(reorderMeals(day, 0, 2).meals.map((meal) => meal.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the day it was given', () => {
    duplicateMealInDay(day, 'b', 'b-copy');
    reorderMeals(day, 0, 2);
    expect(day.meals.map((meal) => meal.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('copyMealsInto', () => {
  const source = addMeals(emptyDay('2026-09-03'), [mealOf('a', 100), mealOf('b', 200)], goals);

  it('appends copies with fresh ids and identical snapshots', () => {
    const target = addMeals(emptyDay('2026-09-04'), [mealOf('x', 50)], goals);
    const result = copyMealsInto(target, source.meals, 'append', { nextId: seqIds('c') });

    expect(result.meals.map((meal) => meal.id)).toEqual(['x', 'c-1', 'c-2']);
    expect(dayTotals(result).kcal).toBe(350);
    expect(result.meals[1]?.macroSnapshot).toEqual(source.meals[0]?.macroSnapshot);
  });

  it('discards what the target had when replacing', () => {
    const target = addMeals(emptyDay('2026-09-04'), [mealOf('x', 50)], goals);
    const result = copyMealsInto(target, source.meals, 'replace', { nextId: seqIds('c'), goals });

    expect(result.meals.map((meal) => meal.id)).toEqual(['c-1', 'c-2']);
    expect(dayTotals(result).kcal).toBe(300);
  });

  it('keeps copies independent of later edits to the source recipe', () => {
    const recipe = makeRecipe();
    const planned = planMeal(recipe, lookup, { id: 'meal-1' });
    const day = addMeals(emptyDay('2026-09-03'), [planned], goals);
    const copy = copyMealsInto(emptyDay('2026-09-04'), day.meals, 'append', {
      nextId: seqIds('c'),
      goals
    });

    // The recipe is edited afterwards and re-planned onto a third day.
    const edited = { ...recipe, items: [item(chicken.id, 1000)] };
    const later = planMeal(edited, lookup, { id: 'meal-9' });

    expect(mealMacros(copy.meals[0]!).kcal).toBe(300);
    expect(later.macroSnapshot.kcal).toBe(1000);
  });

  it('captures goals on a target day that had no meals', () => {
    const result = copyMealsInto(emptyDay('2026-09-05'), source.meals, 'append', {
      nextId: seqIds('c'),
      goals
    });
    expect(result.goalSnapshot).toEqual(goals);
  });
});
