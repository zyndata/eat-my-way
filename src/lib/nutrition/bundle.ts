import ingredientsUrl from './ingredients.json?url';
import type { Ingredient } from '../types';
import { NUTRITION_DATA_VERSION } from './meta';

/**
 * The bundled USDA subset.
 *
 * It is fetched as a hashed asset rather than `import`ed as a module: 230 kB of data has
 * no business inflating the entry chunk when it is read exactly once, on first run. The
 * request is same-origin, which the production CSP allows through `connect-src 'self'`
 * (STATE.md decision 9), and it is the only fetch nutrition data ever causes — there are
 * no FoodData Central API calls at runtime.
 */

export interface NutritionBundle {
  dataVersion: number;
  sources: string[];
  attribution: string;
  ingredients: Ingredient[];
}

/** Where the bundle lives after the build. Exported so tests can stub `fetch` on it. */
export const NUTRITION_BUNDLE_URL: string = ingredientsUrl;

function isMacros(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const macros = value as Record<string, unknown>;
  return (['kcal', 'protein', 'carbs', 'fat'] as const).every(
    (key) => typeof macros[key] === 'number' && Number.isFinite(macros[key])
  );
}

/**
 * Reject anything that is not the shape we wrote. The file is our own build output, but it
 * arrives over the wire and lands in the source of truth, so it is checked before import.
 */
function assertBundle(value: unknown): asserts value is NutritionBundle {
  const bundle = value as Partial<NutritionBundle> | null;
  if (typeof bundle !== 'object' || bundle === null) throw new Error('Nutrition bundle is not an object');
  if (typeof bundle.dataVersion !== 'number') throw new Error('Nutrition bundle has no dataVersion');
  if (!Array.isArray(bundle.ingredients)) throw new Error('Nutrition bundle has no ingredients');

  for (const ingredient of bundle.ingredients as Ingredient[]) {
    if (typeof ingredient?.id !== 'string' || ingredient.id === '') {
      throw new Error('Nutrition bundle has an ingredient without an id');
    }
    if (typeof ingredient.name !== 'string' || !Array.isArray(ingredient.aliases)) {
      throw new Error(`Ingredient ${ingredient.id} has no usable name`);
    }
    if (ingredient.state !== 'raw' && ingredient.state !== 'cooked') {
      throw new Error(`Ingredient ${ingredient.id} has an unknown state`);
    }
    if (!isMacros(ingredient.per100g)) {
      throw new Error(`Ingredient ${ingredient.id} has incomplete macros`);
    }
  }
}

/** Fetch and validate the bundle. Throws with a readable message on anything unexpected. */
export async function loadNutritionBundle(fetchImpl: typeof fetch = fetch): Promise<NutritionBundle> {
  const response = await fetchImpl(NUTRITION_BUNDLE_URL);
  if (!response.ok) {
    throw new Error(`Nutrition bundle request failed: HTTP ${response.status}`);
  }

  const parsed: unknown = await response.json();
  assertBundle(parsed);

  if (parsed.dataVersion !== NUTRITION_DATA_VERSION) {
    throw new Error(
      `Nutrition bundle is version ${parsed.dataVersion}, code expects ${NUTRITION_DATA_VERSION}`
    );
  }
  return parsed;
}
