import type { Recipe, Tag } from './types';
import { rankCandidates } from './search';
import { normalizeKey } from './text';

/**
 * Tag rules (pure). A tag is identified by its normalized `key`; the `label` is whatever
 * spelling the user typed the *first* time, and later spellings of the same key do not
 * overwrite it.
 */

/** `key` for a user-typed label. `"Bez Glutenu"` and `"bez glutenu"` collapse to one key. */
export function tagKey(label: string): string {
  return normalizeKey(label);
}

/** A brand-new tag, unused so far. */
export function makeTag(label: string): Tag {
  return { key: tagKey(label), label: label.trim(), useCount: 0 };
}

/** `useCount + delta`, floored at 0. Returns a new object; never mutates. */
export function bumpTag(tag: Tag, delta = 1): Tag {
  return { ...tag, useCount: Math.max(0, tag.useCount + delta) };
}

/**
 * Turn free-typed labels into the key list stored on a `Recipe`. Blank entries are dropped
 * and duplicates collapse, preserving first-seen order.
 */
export function toTagKeys(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const label of labels) {
    const key = tagKey(label);
    if (key) seen.add(key);
  }
  return [...seen];
}

/**
 * Reconcile typed labels against the tags already in the library: which rows to insert,
 * and which keys the recipe should carry. An existing tag keeps its original label.
 */
export function resolveTags(
  labels: readonly string[],
  existing: readonly Tag[]
): { keys: string[]; created: Tag[] } {
  const known = new Set(existing.map((tag) => tag.key));
  const keys = toTagKeys(labels);
  const created: Tag[] = [];

  for (const label of labels) {
    const key = tagKey(label);
    if (!key || known.has(key)) continue;
    known.add(key);
    created.push(makeTag(label));
  }

  return { keys, created };
}

/**
 * Suggestions for the recipe editor's tag field, ranked by the same rules as the ingredient
 * autocomplete (`search.ts`): match quality first, then how many recipes carry the tag. Keys
 * in `exclude` are already on the recipe and are never offered again. An empty query offers
 * the most-used tags, which is what the field should show before anything is typed.
 */
export function rankTags(
  query: string,
  tags: readonly Tag[],
  options: { exclude?: readonly string[]; limit?: number } = {}
): Tag[] {
  const excluded = new Set(options.exclude ?? []);
  const candidates = tags
    .filter((tag) => !excluded.has(tag.key))
    .map((tag) => ({ tag, nameKey: tag.key, aliasKeys: [] as string[], useCount: tag.useCount }));

  return rankCandidates(query, candidates, options.limit ?? 8).map((match) => match.item.tag);
}

// ---- tag administration (PLAN.md Phase 9 task 2) ----------------------------------------

/**
 * Swap one key for another in a recipe's tag list, preserving order and collapsing the
 * duplicate a merge creates. Returns the same array reference when nothing changed, so a
 * caller can skip the write.
 */
export function replaceTagKey(keys: readonly string[], from: string, to: string): string[] {
  if (!keys.includes(from)) return [...keys];

  const next: string[] = [];
  for (const key of keys) {
    const mapped = key === from ? to : key;
    if (!next.includes(mapped)) next.push(mapped);
  }
  return next;
}

/** Drop one key from a recipe's tag list. */
export function removeTagKey(keys: readonly string[], key: string): string[] {
  return keys.filter((existing) => existing !== key);
}

/**
 * How many recipes carry each key, counted from the recipes themselves.
 *
 * This is the definition of `useCount`, and tag administration always *recomputes* rather
 * than patching (PLAN.md task 2): a rename that collides with an existing tag, or a merge,
 * changes the count by an amount that is only knowable by counting.
 */
export function countTagUses(recipes: readonly Recipe[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const recipe of recipes) {
    // A recipe listing a key twice would still be one user of it.
    for (const key of new Set(recipe.tags)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * What renaming a tag to `label` actually means. A label that normalizes to a key some other
 * tag already holds is not a rename at all — it is a merge, and saying so is the difference
 * between „Sniadanie" quietly swallowing „Śniadanie" and the user being asked first.
 */
export type TagRenamePlan =
  /** Nothing to do: same key, same label. */
  | { kind: 'noop' }
  /** The label is blank once trimmed. */
  | { kind: 'invalid' }
  /** Only the spelling changes; the key and every recipe stay as they are. */
  | { kind: 'relabel'; key: string; label: string }
  /** A new key: recipes carrying the old one are rewritten. */
  | { kind: 'rekey'; from: string; to: string; label: string }
  /** The new key already exists elsewhere; this would fold the two together. */
  | { kind: 'merge'; from: string; to: string };

export function planTagRename(
  tag: Tag,
  label: string,
  existing: readonly Tag[]
): TagRenamePlan {
  const trimmed = label.trim();
  if (trimmed === '') return { kind: 'invalid' };

  const key = tagKey(trimmed);
  if (key === '') return { kind: 'invalid' };

  if (key === tag.key) {
    return trimmed === tag.label ? { kind: 'noop' } : { kind: 'relabel', key, label: trimmed };
  }

  const clash = existing.find((other) => other.key === key && other.key !== tag.key);
  if (clash !== undefined) return { kind: 'merge', from: tag.key, to: clash.key };

  return { kind: 'rekey', from: tag.key, to: key, label: trimmed };
}
