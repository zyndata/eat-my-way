/**
 * Text normalization shared by tag keys and the ingredient search index.
 *
 * Polish diacritics decompose under NFD (ą → a + ogonek) and the combining marks can then
 * be dropped — with one exception: `ł` is a single code point with a bar through it, not a
 * base letter plus a mark, so NFD leaves it untouched and it needs an explicit mapping.
 */

/** Letters that carry a stroke rather than a combining mark, so NFD cannot decompose them. */
const STROKED_LETTERS: Record<string, string> = {
  ł: 'l',
  Ł: 'L'
};

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const STROKED = /[łŁ]/g;
const WHITESPACE = /\s+/g;

/**
 * Strip diacritics without touching case or spacing.
 * `"Żurek Śląski"` → `"Zurek Slaski"`.
 */
export function stripDiacritics(value: string): string {
  return value
    .replace(STROKED, (ch) => STROKED_LETTERS[ch] ?? ch)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '');
}

/**
 * The canonical lookup form: diacritics stripped, lowercased, whitespace collapsed and
 * trimmed. `"  Bez   GLUTENU "` → `"bez glutenu"`, `"Śniadanie"` → `"sniadanie"`.
 *
 * Used as `Tag.key` and as the ingredient index key, so that a search typed without Polish
 * letters still matches.
 */
export function normalizeKey(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(WHITESPACE, ' ').trim();
}
