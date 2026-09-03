/**
 * Data model. These are the *wire* shapes: exactly what PLAN.md specifies and exactly
 * what is written to Google Drive in Phase 6. The IndexedDB layer may add derived index
 * fields on top (see `IngredientRecord` in `db.ts`), but never changes these.
 */

/** Macronutrients. `kcal` is kilocalories, everything else is grams. */
export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Whether `per100g` describes the ingredient raw or after cooking. */
export type IngredientState = 'raw' | 'cooked';

/** Where the ingredient came from. `custom` means the user typed it. */
export type IngredientSource = 'usda' | 'off' | 'custom';

/** Unit a recipe item is measured in. `szt` is Polish for "pieces". */
export type Unit = 'g' | 'ml' | 'szt';

export interface Ingredient {
  /** Namespaced: `usda:1097473`, `off:...`, `custom:<uuid>`. */
  id: string;
  /** Polish display name. */
  name: string;
  aliases: string[];
  state: IngredientState;
  per100g: Macros;
  source: IngredientSource;
  /**
   * When this row was last written, ISO 8601. Custom rows only: the bundled subset is
   * rewritten wholesale by every data refresh, so an edit time would say nothing about it.
   *
   * Absent means "written before Phase 10", when a custom ingredient could only ever be
   * created. That is exactly why it is optional and unindexed — no schema version, no
   * migration — and why the merge counts a row without it as the older side (STATE.md
   * decision 182).
   */
  updatedAt?: string;
}

export interface RecipeItem {
  ingredientId: string;
  amount: number;
  unit: Unit;
  /** Grams per single unit. Required for `szt`; for `ml` it is the density (default 1). */
  gramsPerUnit?: number;
  /** Manual per-100 g values used at this point of use instead of the ingredient's own. */
  macroOverride?: Macros;
}

export interface Recipe {
  id: string;
  name: string;
  /** Future: separate Drive file holding the photo. */
  photoFileId?: string;
  instructions: string;
  /** ALWAYS the amounts for exactly one portion. */
  items: RecipeItem[];
  /** Normalized tag keys, not labels. */
  tags: string[];
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
  /**
   * The page this recipe was imported from, cleaned by `cleanSourceUrl` and always `http`/
   * `https` (Phase 11 task 5). Absent for a recipe pasted as text or written by hand, and
   * clearable — a recipe edited beyond recognition no longer comes from anywhere.
   *
   * Optional on purpose: it costs no schema version, no migration and nothing in the Drive
   * format, because `readRecipesDocument` keeps the fields it does not know.
   */
  sourceUrl?: string;
}

/** `key` is lowercase with diacritics stripped; `label` is the spelling first typed. */
export interface Tag {
  key: string;
  label: string;
  useCount: number;
}

export interface PlannedMeal {
  id: string;
  recipeId: string;
  /** Scales the DISPLAYED ingredient amounts. Never touches macros. */
  cookingScale: number;
  /** Scales the MACROS. Never touches displayed amounts. */
  portionsEaten: number;
  /** Per-1-portion macros frozen at the moment the meal was added. Never recomputed. */
  macroSnapshot: Macros;
}

export interface Day {
  /** `YYYY-MM-DD`, and the primary key of the days table. */
  date: string;
  /** Array order IS the display order — there is deliberately no `order` field. */
  meals: PlannedMeal[];
  /** The profile's goals as they were when the first meal landed on this day. */
  goalSnapshot?: Macros;
}

/** What one device has spent on Gemini during one quota day. */
export interface DeviceUsage {
  /** `generateContent` calls that came back 200. */
  requests: number;
  /** Tokens Google reported for them. */
  tokens: number;
}

/**
 * Gemini spend for a single quota day, tallied **per model and per device**.
 *
 * Two dimensions, each forced by something real. Google's free tier counts per *project*, so a
 * useful number has to add up across every device on the account — but `profile.json` resolves
 * a conflict by taking this device's whole document (engine.ts), so one shared integer would
 * let a device quietly erase another's count. Hence a grow-only counter keyed by device: each
 * writes only its own entry, merging is a union taking the larger value, and no coordinator or
 * clock is needed.
 *
 * And the quota is charged **per model**, with limits that differ by more than an order of
 * magnitude — 20 requests a day for `gemini-3.6-flash` against 500 for `gemini-3.5-flash-lite`
 * at the time of writing (STATE.md decision 129). One number spanning every model would be
 * meaningless the moment a user switched, which is exactly what someone does when a model runs
 * out. So the model is the outer key.
 *
 * `day` is the quota window; a newer day replaces an older one wholesale, because yesterday's
 * tallies are not spend against today.
 */
export interface GeminiUsage {
  /** `YYYY-MM-DD` in Google's quota reset zone. */
  day: string;
  /** Model name → device id → what that device spent on that model. */
  models: Record<string, Record<string, DeviceUsage>>;
}

export interface Profile {
  goals: Macros;
  geminiModel: string;
  encryptVault: boolean;
  locale: 'pl';
  /** Google account subject id, so a wrong account can be detected on sync. */
  googleSub?: string;
  /** Gemini spend for the current quota day. Absent until the first import (Phase 7). */
  geminiUsage?: GeminiUsage;
}
