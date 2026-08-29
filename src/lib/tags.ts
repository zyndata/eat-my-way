import type { Tag } from './types';
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
