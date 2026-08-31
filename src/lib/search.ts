import { normalizeKey } from './text';

/**
 * Ranking for the ingredient autocomplete. Pure: it knows nothing about IndexedDB, so the
 * rules can be tested directly. `ingredients.ts` feeds it rows read from the local
 * database — there is never a network lookup for nutrition data.
 *
 * The query and the candidate keys are both diacritic-normalized, so `zolty ser` typed on
 * a keyboard without Polish letters matches „ser żółty".
 */

/** Match quality, best first. The numbers are the primary sort key. */
export const MatchTier = {
  /** The whole query is exactly one of the candidate's names. */
  Exact: 0,
  /** One of the names starts with the whole query. */
  Prefix: 1,
  /** Every query word starts a word of the same name — „zolty ser" vs „ser zolty". */
  WordPrefix: 2,
  /** Every query word appears somewhere inside the same name. */
  Infix: 3
} as const;

export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/** What the ranker needs from a row. `useCount` is how many recipes refer to it. */
export interface SearchCandidate {
  /** `normalizeKey(name)`. */
  nameKey: string;
  /** `normalizeKey` of every alias. */
  aliasKeys: readonly string[];
  useCount: number;
}

export interface RankedMatch<T> {
  item: T;
  tier: MatchTier;
  /** Where the first query word starts in the matched name — earlier reads as closer. */
  offset: number;
}

/** Split a query into normalized words. An all-whitespace query yields no words. */
export function queryTokens(query: string): string[] {
  const normalized = normalizeKey(query);
  return normalized === '' ? [] : normalized.split(' ');
}

/** True when `token` starts the string or starts a word inside it. */
function isWordPrefix(haystack: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(token, from);
    if (at === -1) return false;
    if (at === 0 || haystack[at - 1] === ' ') return true;
    from = at + 1;
  }
}

/**
 * Score one name against the query. All words must match the *same* name: matching „ser"
 * in the display name and „zolty" in an unrelated alias would not be a match a user
 * recognizes.
 */
function scoreField(field: string, query: string, tokens: readonly string[]): RankedMatch<null> | undefined {
  if (field === query) return { item: null, tier: MatchTier.Exact, offset: 0 };
  if (field.startsWith(query)) return { item: null, tier: MatchTier.Prefix, offset: 0 };

  let tier: MatchTier = MatchTier.WordPrefix;
  for (const token of tokens) {
    if (isWordPrefix(field, token)) continue;
    if (field.includes(token)) tier = MatchTier.Infix;
    else return undefined;
  }

  const offset = field.indexOf(tokens[0] ?? '');
  return { item: null, tier, offset: offset === -1 ? field.length : offset };
}

/** The best tier this candidate reaches over its name and aliases, or `undefined`. */
export function matchCandidate(
  candidate: SearchCandidate,
  query: string,
  tokens: readonly string[]
): { tier: MatchTier; offset: number } | undefined {
  let best: { tier: MatchTier; offset: number } | undefined;

  for (const field of [candidate.nameKey, ...candidate.aliasKeys]) {
    const scored = scoreField(field, query, tokens);
    if (scored === undefined) continue;
    if (best === undefined || scored.tier < best.tier || (scored.tier === best.tier && scored.offset < best.offset)) {
      best = { tier: scored.tier, offset: scored.offset };
    }
  }

  return best;
}

/**
 * Rank candidates for `query`.
 *
 * Order: match quality first (exact → prefix → word-prefix → infix), then ingredients the
 * user has already put in a recipe, then the earlier match, then the shorter and
 * alphabetically first name. An empty query returns the most-used ingredients, which is
 * what the field should offer before anything is typed.
 */
export function rankCandidates<T extends SearchCandidate>(
  query: string,
  candidates: readonly T[],
  limit = 20
): RankedMatch<T>[] {
  const normalized = normalizeKey(query);
  const tokens = queryTokens(query);

  const matches: RankedMatch<T>[] = [];
  for (const candidate of candidates) {
    if (tokens.length === 0) {
      matches.push({ item: candidate, tier: MatchTier.Prefix, offset: 0 });
      continue;
    }
    const best = matchCandidate(candidate, normalized, tokens);
    if (best !== undefined) matches.push({ item: candidate, ...best });
  }

  matches.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.item.useCount - a.item.useCount ||
      a.offset - b.offset ||
      a.item.nameKey.length - b.item.nameKey.length ||
      a.item.nameKey.localeCompare(b.item.nameKey, 'pl')
  );

  return limit >= 0 ? matches.slice(0, limit) : matches;
}
