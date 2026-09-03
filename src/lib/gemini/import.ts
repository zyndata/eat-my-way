import type { Ingredient } from '../types';
import type { DraftItem } from '../recipes';
import type { IngredientCorrection } from '../sync/documents';
import type { IngredientIndex } from '../ingredients';
import { ingredientIndex as defaultIndex } from '../ingredients';
import { normalizeKey } from '../text';
import { repository as defaultRepository, type Repository } from '../repository';
import { GeminiError, generateJson, generateText } from './client';
import {
  FETCH_SYSTEM,
  NO_RECIPE,
  PARSE_SYSTEM,
  RECIPE_SCHEMA,
  cleanSourceUrl,
  fetchPrompt,
  looksLikeUrl,
  normalizeUrl,
  parsePrompt,
  readParsedRecipe,
  toSinglePortion,
  type ParsedRecipe
} from './parse';
import {
  MATCH_SCHEMA,
  MATCH_SYSTEM,
  attachMatches,
  classifyName,
  correctionMap,
  gatherCandidates,
  matchPrompt,
  readMatchResponse,
  type MatchTarget,
  type MatchedIngredient,
  type ResolvedMatch
} from './match';

/**
 * „Wklej przepis z internetu", end to end.
 *
 * The shape of a run, and why (STATE.md decisions 113 and 114):
 *
 *   link  → one call with `url_context` that returns the page's recipe as plain text
 *   text  → one structured call that returns `{name, portions, ingredients, instructions}`
 *         → one structured call that picks an id per name, from lists the app chose
 *
 * The link path is the text path with a retrieval step in front of it, which is what makes a
 * link and its pasted text produce the same draft rather than merely a similar one. The result
 * is a draft handed back to the editor — nothing here writes a recipe, and the ordinary
 * „Zapisz przepis" stays the only path to IndexedDB (PLAN.md task 6).
 */

/** What the import is doing right now. A link import runs all three; a paste, the last two. */
export type ImportStage = 'reading-page' | 'parsing' | 'matching';

export interface ImportDeps {
  apiKey: string;
  model: string;
  index?: IngredientIndex;
  repository?: Repository;
  fetchImpl?: typeof fetch;
  /** Row ids for the editor's `{#each}` block and its drag handles. */
  nextId: () => string;
  /** Told what is happening, so a three-call import does not look frozen. */
  onstage?: (stage: ImportStage) => void;
  /**
   * Called once per answered request. `importRecipe` reports through this even when a later
   * step throws — a request Google answered has already cost quota, whether or not the import
   * finished (STATE.md decision 127).
   */
  onusage?: (spent: { requests: number; tokens: number }) => void;
}

export interface ImportedRecipe {
  /** The dish name, or `''` when the source gave none. */
  name: string;
  instructions: string;
  items: DraftItem[];
  /** Ingredients the editor should show, keyed by id, so it need not re-read IndexedDB. */
  ingredientsById: Record<string, Ingredient>;
  /** Rows the user has to fill in by hand. */
  unmatched: number;
  /** How many portions the source described, before the amounts were divided down to one. */
  sourcePortions: number;
  /**
   * The page the import read, cleaned for storage. Absent when the import began with pasted
   * text, which has no source (PLAN.md Phase 11 task 5).
   */
  sourceUrl?: string;
}

/** Counts what the three calls actually spent, so a partial run still reports honestly. */
interface Tally {
  requests: number;
  tokens: number;
}

const countInto = (tally: Tally) => (tokens: number) => {
  tally.requests += 1;
  tally.tokens += tokens;
};

/** The retrieval step. Throws a `bad-response` when the model could not read the page. */
async function fetchRecipeText(url: string, deps: ImportDeps, tally: Tally): Promise<string> {
  deps.onstage?.('reading-page');
  const text = await generateText({
    apiKey: deps.apiKey,
    model: deps.model,
    system: FETCH_SYSTEM,
    prompt: fetchPrompt(url),
    urlContext: true,
    onusage: countInto(tally),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
  });

  if (text.trim().toUpperCase().includes(NO_RECIPE)) {
    throw new GeminiError(
      'bad-response',
      'Nie udało się otworzyć tej strony ani znaleźć na niej przepisu. Otwórz ją w przeglądarce, ' +
        'skopiuj treść przepisu i wklej ją tutaj zamiast linku.'
    );
  }
  return text;
}

/** The parse step. Everything after this point is pure. */
async function parseRecipeText(text: string, deps: ImportDeps, tally: Tally): Promise<ParsedRecipe> {
  deps.onstage?.('parsing');
  const answer = await generateJson<unknown>({
    apiKey: deps.apiKey,
    model: deps.model,
    system: PARSE_SYSTEM,
    prompt: parsePrompt(text),
    schema: RECIPE_SCHEMA,
    onusage: countInto(tally),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
  });
  return readParsedRecipe(answer);
}

/**
 * Resolve every parsed name to an ingredient id where one can be found. Corrections and exact
 * hits are settled locally; only what is left is sent, and only as a closed list of ids.
 */
async function resolveIngredients(
  recipe: ParsedRecipe,
  deps: ImportDeps,
  tally: Tally
): Promise<MatchedIngredient[]> {
  const index = deps.index ?? defaultIndex;
  const repository = deps.repository ?? defaultRepository;

  const corrections = correctionMap(await repository.allCorrections());

  const resolved: ResolvedMatch[] = [];
  const targets: MatchTarget[] = [];
  const asked = new Set<string>();

  for (const parsed of recipe.ingredients) {
    const ranked = await gatherCandidates(parsed.name, (query) => index.search(query));
    const outcome = classifyName(parsed.name, ranked, corrections);
    if (outcome.resolved !== undefined) {
      resolved.push(outcome.resolved);
      continue;
    }
    // The same name twice in one recipe is one question.
    if (outcome.target !== undefined && !asked.has(outcome.target.nameKey)) {
      asked.add(outcome.target.nameKey);
      targets.push(outcome.target);
    }
  }

  if (targets.length > 0) {
    deps.onstage?.('matching');
    const answer = await generateJson<unknown>({
      apiKey: deps.apiKey,
      model: deps.model,
      system: MATCH_SYSTEM,
      prompt: matchPrompt(targets),
      schema: MATCH_SCHEMA,
      onusage: countInto(tally),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
    });
    resolved.push(...readMatchResponse(answer, targets));
  }

  return attachMatches(recipe.ingredients, resolved);
}

/**
 * Matched rows → editor rows. `sourceName` rides along on every row so a later correction can
 * be recorded against the name the model produced (decision 116); an unmatched row is an
 * ordinary empty ingredient row, which is exactly what the editor already knows how to show.
 */
export function toDraftItems(
  matched: readonly MatchedIngredient[],
  nextId: () => string
): DraftItem[] {
  return matched.map((row) => ({
    id: nextId(),
    ingredientId: row.ingredientId ?? '',
    amount: row.parsed.amount,
    unit: row.parsed.unit,
    gramsPerUnit: row.parsed.gramsPerUnit ?? null,
    macroOverride: null,
    sourceName: row.parsed.name
  }));
}

/**
 * Run an import. `input` is a link or the recipe's text — the user is not asked which, because
 * one look at the string settles it.
 *
 * Throws `GeminiError` only; every message on it is Polish and safe to show, and none of them
 * carries the API key.
 */
export async function importRecipe(input: string, deps: ImportDeps): Promise<ImportedRecipe> {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new GeminiError('bad-response', 'Wklej link albo treść przepisu.');
  }

  // Reported in `finally`: three calls can fail at the third, and the first two were still
  // paid for. A user staring at a spent quota deserves to see where it went.
  const tally: Tally = { requests: 0, tokens: 0 };
  try {
    return await importWithTally(trimmed, deps, tally);
  } finally {
    if (tally.requests > 0) deps.onusage?.({ ...tally });
  }
}

async function importWithTally(
  trimmed: string,
  deps: ImportDeps,
  tally: Tally
): Promise<ImportedRecipe> {
  // Kept rather than dropped this time: the link the fetch step reads is the one the recipe
  // came from, and until Phase 11 there was nowhere to put it (STATE.md decision 196).
  const sourceUrl = looksLikeUrl(trimmed) ? cleanSourceUrl(trimmed) : undefined;
  const text = looksLikeUrl(trimmed)
    ? await fetchRecipeText(normalizeUrl(trimmed), deps, tally)
    : trimmed;

  const source = await parseRecipeText(text, deps, tally);
  // Recipes are stored per portion, so a page's „na 4 porcje" is divided down here.
  const recipe = toSinglePortion(source);
  if (recipe.ingredients.length === 0) {
    throw new GeminiError(
      'bad-response',
      'Nie udało się odczytać z tej treści żadnych składników. Sprawdź, czy to na pewno przepis.'
    );
  }

  const matched = await resolveIngredients(recipe, deps, tally);

  const repository = deps.repository ?? defaultRepository;
  const ids = matched
    .map((row) => row.ingredientId)
    .filter((id): id is string => id !== undefined);
  const found = await repository.ingredientsByIds(ids);
  const ingredientsById = Object.fromEntries(found.map((row) => [row.id, row]));

  const items = toDraftItems(matched, deps.nextId);

  return {
    name: recipe.name,
    instructions: recipe.instructions,
    items,
    ingredientsById,
    // An id that no longer resolves counts as unmatched: the row shows the autocomplete.
    unmatched: items.filter((item) => ingredientsById[item.ingredientId] === undefined).length,
    sourcePortions: source.portions,
    ...(sourceUrl === undefined ? {} : { sourceUrl })
  };
}

/**
 * Store „this Polish name means this ingredient". Called when the user picks on a row that came
 * from an import — the fix they were making anyway becomes the reason the next import of that
 * name needs no model at all (PLAN.md task 5).
 */
export async function rememberCorrection(
  sourceName: string,
  ingredientId: string,
  repository: Repository = defaultRepository
): Promise<void> {
  const nameKey = normalizeKey(sourceName);
  if (nameKey === '' || ingredientId === '') return;
  const correction: IngredientCorrection = {
    nameKey,
    ingredientId,
    updatedAt: new Date().toISOString()
  };
  await repository.putCorrection(correction);
}
