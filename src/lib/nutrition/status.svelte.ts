import { ingredientIndex } from '../ingredients';
import { repository } from '../repository';
import { importBundledNutrition } from './import';

/**
 * App-wide state of the first-run nutrition import, so any screen can say what is going on
 * without triggering the import a second time.
 */

export type NutritionPhase = 'idle' | 'importing' | 'ready' | 'failed';

export const nutritionStatus = $state<{
  phase: NutritionPhase;
  /** Ingredients in the local database once the import settled. */
  count: number;
  /** Polish message for the user when `phase` is `failed`. */
  message: string;
}>({ phase: 'idle', count: 0, message: '' });

/** Runs at most once per page load, however many screens ask for it. */
let started: Promise<void> | null = null;

export function ensureNutritionImported(): Promise<void> {
  started ??= run();
  return started;
}

async function run(): Promise<void> {
  nutritionStatus.phase = 'importing';

  const outcome = await importBundledNutrition();
  if (outcome.status === 'failed') {
    nutritionStatus.phase = 'failed';
    nutritionStatus.message = 'Nie udało się wczytać bazy składników. Odśwież stronę.';
    // Surfaced for the developer; the message above is what the user sees.
    console.error('Nutrition import failed', outcome.error);
    return;
  }

  // The index caches a snapshot, so it must be read after the import, not before.
  ingredientIndex.invalidate();
  await ingredientIndex.warm();

  nutritionStatus.count = await repository.countIngredients();
  nutritionStatus.phase = 'ready';
}
