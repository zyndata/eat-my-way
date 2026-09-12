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

/**
 * Mirror the phase onto `<html data-nutrition>`, the way `theme.svelte.ts` mirrors the theme.
 *
 * Rendered nowhere and read by nobody in the app — it exists so that something outside it can
 * tell whether the first-run import is still running. `e2e/fixtures.ts` waits on it before a
 * test acts, which is what stops the whole suite from racing an import that takes twenty
 * seconds under Playwright's WebKit (STATE.md decision 390). A one-attribute signal is cheaper and far steadier than a
 * test reaching into IndexedDB past the app — a read that, on WebKit, is itself blocked by the
 * import it is trying to observe.
 */
function paint(phase: NutritionPhase): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.nutrition = phase;
}

/** Runs at most once per page load, however many screens ask for it. */
let started: Promise<void> | null = null;

export function ensureNutritionImported(): Promise<void> {
  started ??= run();
  return started;
}

async function run(): Promise<void> {
  nutritionStatus.phase = 'importing';
  paint('importing');

  const outcome = await importBundledNutrition();
  if (outcome.status === 'failed') {
    nutritionStatus.phase = 'failed';
    paint('failed');
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
  paint('ready');
}
