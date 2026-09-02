import { describe, expect, it } from 'vitest';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  buildBackup,
  readBackup,
  summarizeBackup,
  type BackupInput
} from './backup';
import { DEFAULT_PROFILE } from './db';
import type { Day, Ingredient, Recipe } from './types';

const macros = { kcal: 100, protein: 5, carbs: 10, fat: 2 };

const recipe: Recipe = {
  id: 'recipe-1',
  name: 'Jajecznica',
  tags: ['sniadanie'],
  items: [{ ingredientId: 'usda-1', amount: 100, unit: 'g' }],
  instructions: '',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z'
};

const day: Day = {
  date: '2026-09-01',
  meals: [
    {
      id: 'meal-1',
      recipeId: 'recipe-1',
      portionsEaten: 1,
      cookingScale: 1,
      macroSnapshot: macros
    }
  ]
};

const custom: Ingredient = {
  id: 'custom-1',
  name: 'Twaróg półtłusty',
  aliases: [],
  state: 'raw',
  per100g: macros,
  source: 'custom'
};

const input: BackupInput = {
  profile: DEFAULT_PROFILE,
  recipes: [recipe],
  tags: [{ key: 'sniadanie', label: 'Śniadanie', useCount: 1 }],
  customIngredients: [custom],
  corrections: [{ nameKey: 'twarog', ingredientId: 'custom-1', updatedAt: '2026-09-01T10:00:00.000Z' }],
  days: [day],
  schemaVersion: 3
};

describe('building a backup', () => {
  it('carries every collection and names itself', () => {
    const backup = buildBackup(input, new Date('2026-09-01T12:00:00.000Z'));

    expect(backup.kind).toBe(BACKUP_KIND);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.exportedAt).toBe('2026-09-01T12:00:00.000Z');
    expect(backup.recipes).toHaveLength(1);
    expect(backup.days).toHaveLength(1);
    expect(backup.ingredients).toHaveLength(1);
    expect(backup.corrections).toHaveLength(1);
  });

  it('never carries the vault — that is the whole point of leaving it out', () => {
    const serialized = JSON.stringify(buildBackup(input));
    expect(serialized).not.toContain('vault');
    expect(serialized).not.toContain('geminiApiKey');
  });

  it('names the file by the day it was written', () => {
    expect(backupFileName(new Date('2026-09-01T22:30:00.000Z'))).toBe('eat-my-way-2026-09-01.json');
  });
});

describe('reading a backup', () => {
  it('round-trips what was exported', () => {
    const backup = readBackup(JSON.stringify(buildBackup(input)));

    expect(backup.recipes[0]).toEqual(recipe);
    expect(backup.days[0]).toEqual(day);
    expect(backup.ingredients[0]).toEqual(custom);
    expect(backup.profile).toEqual(DEFAULT_PROFILE);
  });

  it('summarizes what a restore would bring in', () => {
    const summary = summarizeBackup(buildBackup(input, new Date('2026-09-01T12:00:00.000Z')));

    expect(summary).toEqual({
      recipes: 1,
      days: 1,
      meals: 1,
      ingredients: 1,
      exportedAt: '2026-09-01T12:00:00.000Z'
    });
  });

  it('fills in profile fields a file predates', () => {
    const document = { ...buildBackup(input), profile: { goals: DEFAULT_PROFILE.goals } };
    const backup = readBackup(JSON.stringify(document));

    expect(backup.profile.geminiModel).toBe(DEFAULT_PROFILE.geminiModel);
    expect(backup.profile.encryptVault).toBe(DEFAULT_PROFILE.encryptVault);
  });

  it('refuses anything that is not one of our files', () => {
    expect(() => readBackup('not json at all')).toThrow(BackupError);
    expect(() => readBackup('{"kind":"something-else"}')).toThrow(/Eat My Way/);
    expect(() => readBackup('null')).toThrow(BackupError);
  });

  it('refuses a file from a future version rather than half-reading it', () => {
    const document = { ...buildBackup(input), version: BACKUP_VERSION + 1 };
    expect(() => readBackup(JSON.stringify(document))).toThrow(/nowszej wersji/);
  });

  it('refuses a meal with no frozen macros', () => {
    const document = buildBackup(input);
    const broken = {
      ...document,
      days: [{ date: '2026-09-01', meals: [{ id: 'meal-1', recipeId: 'r', portionsEaten: 1 }] }]
    };
    expect(() => readBackup(JSON.stringify(broken))).toThrow(/wartości odżywczych/);
  });

  it('refuses a missing collection instead of importing an empty one', () => {
    const { recipes: _dropped, ...withoutRecipes } = buildBackup(input);
    expect(() => readBackup(JSON.stringify(withoutRecipes))).toThrow(/przepisy/);
  });
});
