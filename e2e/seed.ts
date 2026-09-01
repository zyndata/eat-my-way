import type { Day, Profile, Recipe, Tag } from '../src/lib/types';
import type { FakeDrive } from './fake-google';

/**
 * Documents in the shape `src/lib/sync/documents.ts` defines, for putting data on the fake
 * Drive as though another device had already been there.
 *
 * These are written as literals rather than by calling the app's own writers: a test that
 * builds its input with the same code it is checking proves nothing about the wire format.
 */

export const DEFAULT_GOALS = { kcal: 2000, protein: 150, carbs: 200, fat: 60 };

export function profileDocument(overrides: Partial<Profile> = {}): string {
  return JSON.stringify({
    goals: DEFAULT_GOALS,
    geminiModel: 'gemini-2.5-flash',
    encryptVault: false,
    locale: 'pl',
    ...overrides
  });
}

export function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-drive-1',
    name: 'Naleśniki z Dysku',
    instructions: 'Usmaż na patelni.',
    items: [],
    tags: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides
  };
}

export function recipesDocument(recipes: Recipe[], tags: Tag[] = []): string {
  return JSON.stringify({ recipes, tags });
}

export function daysDocument(days: Record<string, Day>): string {
  return JSON.stringify(days);
}

/**
 * The folder as a device that has already synced would leave it: a profile bound to `sub-1`
 * and one recipe. Enough that the folder is not "fresh", so connecting lands on the settings
 * screen rather than the first-run wizard.
 */
export function seedAccount(drive: FakeDrive, options: { recipes?: Recipe[]; googleSub?: string } = {}): void {
  drive.put('profile.json', profileDocument({ googleSub: options.googleSub ?? 'sub-1' }));
  drive.put('recipes.json', recipesDocument(options.recipes ?? [recipe()]));
}
