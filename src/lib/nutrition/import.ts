import type { Repository } from '../repository';
import { repository as defaultRepository } from '../repository';
import { loadNutritionBundle, type NutritionBundle } from './bundle';
import { NUTRITION_DATA_VERSION } from './meta';

/**
 * First-run import of the bundled USDA subset into IndexedDB.
 *
 * Guarded by a meta flag holding the imported `dataVersion`, so a second load skips the
 * fetch entirely and a future bundle re-imports itself exactly once. Custom ingredients the
 * user added are untouched: the import writes only `usda:*` ids.
 */

export type ImportOutcome =
  /** The meta flag already names this version or a newer one; nothing was fetched. */
  | { status: 'skipped'; dataVersion: number; imported: 0 }
  /** The bundle was fetched and written. */
  | { status: 'imported'; dataVersion: number; imported: number }
  /** Something went wrong. The app still works — the user just has no bundled ingredients. */
  | { status: 'failed'; dataVersion: number; imported: 0; error: Error };

/** Rows are written in batches so one huge transaction never blocks the first paint. */
const BATCH_SIZE = 250;

export interface ImportOptions {
  repository?: Repository;
  /** Injected in tests; production always uses the real bundle over `fetch`. */
  load?: () => Promise<NutritionBundle>;
  /** Re-import even when the meta flag is already current. */
  force?: boolean;
}

export async function importBundledNutrition(options: ImportOptions = {}): Promise<ImportOutcome> {
  const repository = options.repository ?? defaultRepository;
  const load = options.load ?? (() => loadNutritionBundle());

  try {
    const imported = await repository.getMeta('nutritionDataVersion');
    if (!options.force && imported !== undefined && imported >= NUTRITION_DATA_VERSION) {
      return { status: 'skipped', dataVersion: imported, imported: 0 };
    }

    const bundle = await load();
    for (let start = 0; start < bundle.ingredients.length; start += BATCH_SIZE) {
      await repository.putIngredients(bundle.ingredients.slice(start, start + BATCH_SIZE));
    }

    // Written last: a crash mid-import leaves the flag behind, so the next load retries.
    await repository.setMeta('nutritionDataVersion', bundle.dataVersion);
    await repository.setMeta('nutritionImportedAt', new Date().toISOString());

    return { status: 'imported', dataVersion: bundle.dataVersion, imported: bundle.ingredients.length };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { status: 'failed', dataVersion: NUTRITION_DATA_VERSION, imported: 0, error };
  }
}
