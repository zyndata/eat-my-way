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

/**
 * Polish plural forms. The language has three, not two, and the difference is visible in
 * ordinary numbers: 1 zapytanie, 2 zapytania, 5 zapytań. Picking `one`/`many` alone — the
 * English habit — misspells every count from 2 to 4, which is most of the small numbers a
 * usage counter actually shows.
 *
 * The rule: `one` for exactly 1; `few` when the last digit is 2-4, **except** in the teens
 * (12-14 take `many`, which is why 22 is „dwadzieścia dwa zapytania" but 12 is „dwanaście
 * zapytań"); `many` otherwise, including 0.
 */
export function pluralPl(count: number, forms: { one: string; few: string; many: string }): string {
  const n = Math.abs(Math.trunc(count));
  if (n === 1) return forms.one;
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return forms.few;
  return forms.many;
}

/**
 * „porcja" / „porcje" / „porcji" for a count that may be fractional.
 *
 * Portions are the one number in this app that is deliberately not an integer — `portionsEaten`
 * moves in halves — and a fraction is not a plural: Polish puts it in the genitive singular,
 * which for this noun happens to look like the genitive plural.
 */
export function portionWord(count: number): string {
  // A fraction takes the genitive, which `pluralPl` cannot say: it truncates, so 1.5 would
  // come back as „porcja".
  if (!Number.isInteger(count)) return 'porcji';
  return pluralPl(count, { one: 'porcja', few: 'porcje', many: 'porcji' });
}

/** The same, with the count in front and a Polish decimal comma: „1,5 porcji". */
export function formatPortions(count: number): string {
  return `${count.toLocaleString('pl-PL')} ${portionWord(count)}`;
}

/** Google's own units: Drive's 15 GB is 15 × 2^30 bytes, and it calls that „15 GB". */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as a person reads it: „1,25 GB", „340 MB", „15 GB".
 *
 * Precision falls as the number grows, which is how a size is quoted out loud — two decimals
 * under 10, one under 100, none above, and never a decimal on raw bytes. The separator is the
 * Polish comma, so it matches every other number on the screen.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';

  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const digits = unit === 0 ? 0 : size < 10 ? 2 : size < 100 ? 1 : 0;
  return `${size.toLocaleString('pl-PL', { maximumFractionDigits: digits })} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/**
 * The host of a stored source URL, as the „Źródło" row shows it: `www.` dropped, nothing else
 * touched. A 200-character link is unreadable on a phone, and the host is the part that tells
 * the user whether the page is worth opening (STATE.md decision 196).
 *
 * Falls back to the value itself for anything unparseable, so the row never renders empty for a
 * recipe that plainly has a source.
 */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
