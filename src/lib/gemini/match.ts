import type { Ingredient } from '../types';
import type { ResponseSchema } from './client';
import type { IngredientCorrection } from '../sync/documents';
import type { IngredientMatch } from '../ingredients';
import { normalizeKey } from '../text';
import type { ParsedIngredient } from './parse';

/**
 * Matching a parsed Polish name to a row of the local nutrition database.
 *
 * Three steps, cheapest first (PLAN.md Phase 7 task 4, STATE.md decision 114):
 *
 * 1. A **correction** the user has already made wins outright. It is a lookup, it is
 *    deterministic, and the name is never sent to Gemini again.
 * 2. Otherwise the app ranks its own index and picks candidates. An exact hit on the
 *    normalized name is taken as-is — asking a model to choose between „ryż biały" and
 *    „ryż biały" would be spending a request on a decided question.
 * 3. Whatever is left goes to Gemini as a **closed list of ids**. The model may answer with an
 *    id from that list or with `null`, and an answer outside the list is discarded here. It
 *    never sees macros and cannot invent an ingredient.
 *
 * Everything in this file is pure. The single Gemini call lives in `import.ts`.
 */

/** How many rows the model is offered per name. Enough to hold the right one, short enough to read. */
export const MAX_CANDIDATES = 8;

/** One name on its way to being matched. */
export interface MatchTarget {
  /** The name exactly as the parser produced it. */
  name: string;
  /** `normalizeKey(name)` — the correction key and the dedupe key. */
  nameKey: string;
  candidates: Ingredient[];
}

export interface ResolvedMatch {
  nameKey: string;
  ingredientId: string;
  /** Where the answer came from. Only `model` costs a request. */
  via: 'correction' | 'exact' | 'model';
}

/**
 * The rows a name is allowed to be matched against.
 *
 * The autocomplete's ranker requires *every* query word to hit the same name, which is right
 * for a person typing and wrong for a name off a recipe page: „oliwa do smażenia" matches
 * nothing at all, because „do" and „smażenia" appear in no ingredient. So a name that ranks
 * empty is retried word by word and the results are unioned in word order — the head noun of
 * a Polish ingredient name comes first, which is why „oliwa" finds the olive oil.
 *
 * Words shorter than three letters are skipped: „do", „z", „na" would each drag in a third of
 * the database and push the real candidate off the end of the list.
 */
export async function gatherCandidates(
  name: string,
  search: (query: string) => Promise<IngredientMatch[]>
): Promise<IngredientMatch[]> {
  const direct = await search(name);
  if (direct.length > 0) return direct;

  const words = normalizeKey(name)
    .split(' ')
    .filter((word) => word.length >= 3);

  const merged: IngredientMatch[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    for (const match of await search(word)) {
      if (seen.has(match.ingredient.id)) continue;
      seen.add(match.ingredient.id);
      merged.push(match);
    }
    if (merged.length >= MAX_CANDIDATES) break;
  }
  return merged;
}

/** Corrections keyed by `nameKey`, as the resolver wants them. */
export function correctionMap(
  corrections: readonly IngredientCorrection[]
): Map<string, string> {
  return new Map(corrections.map((correction) => [correction.nameKey, correction.ingredientId]));
}

/**
 * Split ranked candidates into "already decided" and "ask the model".
 *
 * `ranked` is what `ingredientIndex.search` returned for the name, best first. An exact-tier
 * first hit is accepted; anything weaker becomes a candidate list. A name with no candidates at
 * all is not sent — there is nothing to choose from — and falls through to the manual
 * autocomplete in the editor.
 */
export function classifyName(
  name: string,
  ranked: readonly IngredientMatch[],
  corrections: ReadonlyMap<string, string>
): { resolved?: ResolvedMatch; target?: MatchTarget } {
  const nameKey = normalizeKey(name);

  const corrected = corrections.get(nameKey);
  if (corrected !== undefined) {
    return { resolved: { nameKey, ingredientId: corrected, via: 'correction' } };
  }

  const best = ranked[0];
  if (best !== undefined && normalizeKey(best.ingredient.name) === nameKey) {
    return { resolved: { nameKey, ingredientId: best.ingredient.id, via: 'exact' } };
  }

  const candidates = ranked.slice(0, MAX_CANDIDATES).map((match) => match.ingredient);
  if (candidates.length === 0) return {};
  return { target: { name, nameKey, candidates } };
}

/**
 * The controlled vocabulary, as the model sees it: a numbered name and, under it, the ids it
 * is allowed to answer with. Names are asked about in one call rather than one call each —
 * a recipe has a dozen ingredients and a dozen round trips would be a dozen chances to fail.
 */
export function matchPrompt(targets: readonly MatchTarget[]): string {
  const blocks = targets.map((target) => {
    const rows = target.candidates
      .map(
        (candidate) =>
          `  - id: ${candidate.id} | ${candidate.name}` +
          ` (${candidate.state === 'cooked' ? 'po ugotowaniu' : 'surowy'})`
      )
      .join('\n');
    return `Składnik z przepisu: "${target.name}"\nMożliwe dopasowania:\n${rows}`;
  });
  return blocks.join('\n\n');
}

export const MATCH_SYSTEM = [
  'Dopasowujesz nazwy składników z przepisu do pozycji w bazie produktów.',
  'Dla każdego składnika wybierz JEDNO id z podanej pod nim listy — nic spoza listy.',
  'Jeśli żadna pozycja nie jest tym samym produktem, zwróć null. Lepiej null niż zła pozycja:',
  'użytkownik poprawi brak w dwie sekundy, a złego dopasowania może nie zauważyć.',
  'Kieruj się produktem, nie słowem: „ser żółty” to nie „ser biały”, a „masło” to nie „masło orzechowe”.',
  'Zwracasz wyłącznie JSON zgodny ze schematem, w tej samej kolejności co składniki na wejściu.'
].join('\n');

export const MATCH_SCHEMA: ResponseSchema = {
  type: 'object',
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'id'],
        propertyOrdering: ['name', 'id'],
        properties: {
          name: { type: 'string', description: 'Nazwa składnika z przepisu, przepisana dosłownie.' },
          id: {
            type: 'string',
            nullable: true,
            description: 'Wybrane id z listy albo null.'
          }
        }
      }
    }
  }
};

/**
 * Read the model's picks back, keeping only answers that name a candidate actually offered for
 * that name. An id the model made up, an id borrowed from another ingredient's list, a name
 * nobody asked about: all dropped, all indistinguishable from "no match" to the caller.
 */
export function readMatchResponse(
  value: unknown,
  targets: readonly MatchTarget[]
): ResolvedMatch[] {
  const doc = (typeof value === 'object' && value !== null ? value : {}) as {
    matches?: unknown;
  };
  const rows = Array.isArray(doc.matches) ? doc.matches : [];

  const byKey = new Map(targets.map((target) => [target.nameKey, target]));
  const resolved: ResolvedMatch[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { name, id } = row as { name?: unknown; id?: unknown };
    if (typeof name !== 'string' || typeof id !== 'string') continue;

    const nameKey = normalizeKey(name);
    const target = byKey.get(nameKey);
    if (target === undefined || seen.has(nameKey)) continue;
    if (!target.candidates.some((candidate) => candidate.id === id)) continue;

    seen.add(nameKey);
    resolved.push({ nameKey, ingredientId: id, via: 'model' });
  }

  return resolved;
}

/**
 * The parsed rows with an ingredient id attached where one was found. Order is the recipe's,
 * because that is the order the editor will show and the user will read against the page.
 */
export interface MatchedIngredient {
  parsed: ParsedIngredient;
  nameKey: string;
  ingredientId?: string;
}

export function attachMatches(
  ingredients: readonly ParsedIngredient[],
  matches: readonly ResolvedMatch[]
): MatchedIngredient[] {
  const byKey = new Map(matches.map((match) => [match.nameKey, match.ingredientId]));
  return ingredients.map((parsed) => {
    const nameKey = normalizeKey(parsed.name);
    const ingredientId = byKey.get(nameKey);
    return ingredientId === undefined ? { parsed, nameKey } : { parsed, nameKey, ingredientId };
  });
}
