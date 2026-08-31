import type { Ingredient } from './types';
import type { IngredientSearchEntry, Repository } from './repository';
import { repository as defaultRepository } from './repository';
import { rankCandidates, type MatchTier } from './search';

/**
 * The ingredient autocomplete's data source.
 *
 * The whole ingredient table is read from IndexedDB once and kept in memory: it is ~1300
 * rows, and re-reading it on every keystroke to run a scan that IndexedDB cannot index
 * anyway (infix matching) would be slower for no benefit. Nothing here ever reaches the
 * network — the bundled subset is imported once and that is the only source.
 *
 * Anything that writes an ingredient must call `invalidate()`; the recipe editor does so
 * after creating a custom one.
 */

export interface IngredientMatch {
  ingredient: Ingredient;
  /** How many recipes already use it. */
  useCount: number;
  tier: MatchTier;
}

export interface IngredientIndex {
  search(query: string, limit?: number): Promise<IngredientMatch[]>;
  /** Drop the snapshot so the next search re-reads IndexedDB. */
  invalidate(): void;
  /** Load the snapshot now, e.g. right after the first-run import. */
  warm(): Promise<void>;
}

export function createIngredientIndex(repository: Repository = defaultRepository): IngredientIndex {
  let snapshot: Promise<IngredientSearchEntry[]> | null = null;

  function entries(): Promise<IngredientSearchEntry[]> {
    // Cache the promise, not the result: parallel first searches then share one read.
    snapshot ??= repository.ingredientSearchIndex().catch((error: unknown) => {
      snapshot = null;
      throw error;
    });
    return snapshot;
  }

  return {
    async search(query: string, limit = 20): Promise<IngredientMatch[]> {
      return rankCandidates(query, await entries(), limit).map((match) => ({
        ingredient: match.item.ingredient,
        useCount: match.item.useCount,
        tier: match.tier
      }));
    },

    invalidate(): void {
      snapshot = null;
    },

    async warm(): Promise<void> {
      await entries();
    }
  };
}

/** The application-wide index, bound to the application-wide repository. */
export const ingredientIndex = createIngredientIndex();
