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
  schemaVersion: 3,
  settings: {}
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

  it('carries the vault verbatim when the device has one', () => {
    // The vault is opaque here: whatever the device holds is what travels (decision 184).
    const backup = buildBackup({ ...input, vaultFile: '{"v":1,"cipher":"…"}' });
    expect(backup.vault).toBe('{"v":1,"cipher":"…"}');
  });

  it('leaves the section out entirely when there is no vault', () => {
    expect(buildBackup(input).vault).toBeUndefined();
    expect(JSON.stringify(buildBackup(input))).not.toContain('vault');
  });

  it('carries the per-device list settings', () => {
    const backup = buildBackup({ ...input, settings: { recipeSort: 'name', recipeGrouped: true } });
    expect(backup.settings).toEqual({ recipeSort: 'name', recipeGrouped: true });
  });

  it('carries the theme, which never travels to Drive', () => {
    // Same fact, opposite conclusion (decision 187): sync equalises two devices that may
    // reasonably disagree, a backup rebuilds one device that had one answer.
    const backup = buildBackup({ ...input, settings: { theme: 'dark' } });
    expect(backup.settings).toEqual({ theme: 'dark' });
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
      exportedAt: '2026-09-01T12:00:00.000Z',
      vault: false
    });
  });

  it('says when the file brings a vault with it', () => {
    expect(summarizeBackup(buildBackup({ ...input, vaultFile: '{}' })).vault).toBe(true);
  });

  it('fills in profile fields a file predates', () => {
    const document = { ...buildBackup(input), profile: { goals: DEFAULT_PROFILE.goals } };
    const backup = readBackup(JSON.stringify(document));

    expect(backup.profile.geminiModel).toBe(DEFAULT_PROFILE.geminiModel);
    expect(backup.profile.encryptVault).toBe(DEFAULT_PROFILE.encryptVault);
  });

  it('round-trips the vault and the settings', () => {
    const document = buildBackup({
      ...input,
      vaultFile: '{"v":1}',
      settings: { recipeSort: 'kcal', recipeGrouped: true, theme: 'dark' }
    });
    const backup = readBackup(JSON.stringify(document));

    expect(backup.vault).toBe('{"v":1}');
    expect(backup.settings).toEqual({ recipeSort: 'kcal', recipeGrouped: true, theme: 'dark' });
  });

  it('reads a file written before either section existed', () => {
    // The reverse of the compatibility `BACKUP_VERSION` stays at 1 for (decision 188).
    const { vault: _v, settings: _s, ...older } = buildBackup({ ...input, vaultFile: '{}' });
    const backup = readBackup(JSON.stringify(older));

    expect(backup.vault).toBeUndefined();
    expect(backup.settings).toEqual({});
    expect(backup.recipes).toHaveLength(1);
  });

  it('stays readable by a build that predates the two new sections', () => {
    // An older build reads `version` 1, constructs its own document from the fields it knows
    // and never looks at `vault` or `settings` — so what it sees is exactly the file this
    // version would have written without them (decision 188).
    const current = buildBackup(
      { ...input, vaultFile: '{"v":1}', settings: { recipeSort: 'name' } },
      new Date('2026-09-01T12:00:00.000Z')
    );
    const { vault: _v, settings: _s, ...asAnOlderBuildSeesIt } = current;
    const { settings: _old, ...v1Shape } = buildBackup(input, new Date('2026-09-01T12:00:00.000Z'));

    expect(current.version).toBe(1);
    expect(asAnOlderBuildSeesIt).toEqual(v1Shape);
  });

  it('drops a settings value it does not recognise instead of refusing the file', () => {
    const document = {
      ...buildBackup(input),
      settings: { recipeSort: 'nonsense', recipeGrouped: 'tak', theme: 'neonowy' }
    };
    expect(readBackup(JSON.stringify(document)).settings).toEqual({});
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
