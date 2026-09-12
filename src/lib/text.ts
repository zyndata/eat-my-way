import type { Unit } from './types';

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

/** „szt." reads as a unit in Polish; `g` and `ml` do not take a full stop. */
export function unitLabel(unit: Unit): string {
  return unit === 'szt' ? 'szt.' : unit;
}

/** Two decimals at most, with the Polish decimal comma. */
export function formatAmount(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString('pl-PL');
}

/** An amount as it is written next to an ingredient: „200 g", „1,5 szt.". */
export function formatAmountWithUnit(amount: number, unit: Unit): string {
  return `${formatAmount(amount)} ${unitLabel(unit)}`;
}

// ---- household measures (Phase 16) -------------------------------------------------------

/**
 * The closed vocabulary of household measures (STATE.md decision 324).
 *
 * Closed because free text fragments — „ząbek", „ząbeczek", „ząbek czosnku" within a week —
 * which kills any chance of a suggestion list and makes Polish plural agreement impossible.
 * The value stored on an ingredient and on a recipe item IS the singular spelling below; there
 * is no separate key, because a sixteen-entry list gains nothing from one.
 *
 * A measure is a **label and a default weight**, never a unit: the arithmetic in `macros.ts`
 * never sees one (decision 323).
 */
export const MEASURE_NAMES = [
  'szt.',
  'mała szt.',
  'średnia szt.',
  'duża szt.',
  'ząbek',
  'kromka',
  'plaster',
  'garść',
  'łyżka',
  'łyżeczka',
  'szklanka',
  'kubek',
  'pęczek',
  'gałązka',
  'opakowanie',
  'porcja'
] as const;

export type MeasureName = (typeof MEASURE_NAMES)[number];

/**
 * The four forms each measure is printed in.
 *
 * Three of them are `pluralPl`'s: 1 ząbek, 2 ząbki, 5 ząbków. The fourth is the genitive
 * singular, which a fraction takes — „1,5 ząbka" — and which `pluralPl` cannot reach because
 * it truncates (STATE.md decision 349). `portionWord` gets away without it only because
 * „porcji" happens to be both genitives of „porcja"; „ząbka" and „ząbków" are not one word.
 *
 * „szt." is an abbreviation and does not decline in any of the four.
 */
export interface MeasureForms {
  one: string;
  few: string;
  many: string;
  /** Genitive singular, for a non-integer count. */
  fraction: string;
}

const MEASURE_FORMS: Record<MeasureName, MeasureForms> = {
  'szt.': { one: 'szt.', few: 'szt.', many: 'szt.', fraction: 'szt.' },
  'mała szt.': { one: 'mała szt.', few: 'małe szt.', many: 'małych szt.', fraction: 'małej szt.' },
  'średnia szt.': {
    one: 'średnia szt.',
    few: 'średnie szt.',
    many: 'średnich szt.',
    fraction: 'średniej szt.'
  },
  'duża szt.': { one: 'duża szt.', few: 'duże szt.', many: 'dużych szt.', fraction: 'dużej szt.' },
  'ząbek': { one: 'ząbek', few: 'ząbki', many: 'ząbków', fraction: 'ząbka' },
  'kromka': { one: 'kromka', few: 'kromki', many: 'kromek', fraction: 'kromki' },
  'plaster': { one: 'plaster', few: 'plastry', many: 'plastrów', fraction: 'plastra' },
  'garść': { one: 'garść', few: 'garście', many: 'garści', fraction: 'garści' },
  'łyżka': { one: 'łyżka', few: 'łyżki', many: 'łyżek', fraction: 'łyżki' },
  'łyżeczka': { one: 'łyżeczka', few: 'łyżeczki', many: 'łyżeczek', fraction: 'łyżeczki' },
  'szklanka': { one: 'szklanka', few: 'szklanki', many: 'szklanek', fraction: 'szklanki' },
  'kubek': { one: 'kubek', few: 'kubki', many: 'kubków', fraction: 'kubka' },
  'pęczek': { one: 'pęczek', few: 'pęczki', many: 'pęczków', fraction: 'pęczka' },
  'gałązka': { one: 'gałązka', few: 'gałązki', many: 'gałązek', fraction: 'gałązki' },
  'opakowanie': {
    one: 'opakowanie',
    few: 'opakowania',
    many: 'opakowań',
    fraction: 'opakowania'
  },
  'porcja': { one: 'porcja', few: 'porcje', many: 'porcji', fraction: 'porcji' }
};

/** True for a value read back out of storage that is still one of the known measures. */
export function isMeasureName(value: unknown): value is MeasureName {
  return typeof value === 'string' && (MEASURE_NAMES as readonly string[]).includes(value);
}

/**
 * The measure as it is spelled next to `count`: „ząbek", „ząbki", „ząbków", „ząbka".
 *
 * A name that is not in the vocabulary is returned untouched rather than dropped — a recipe
 * written by a newer build must still print something readable on an older one.
 */
export function measureWord(name: string, count: number): string {
  const forms = MEASURE_FORMS[name as MeasureName];
  if (forms === undefined) return name;
  if (!Number.isInteger(count)) return forms.fraction;
  return pluralPl(count, forms);
}

/**
 * An amount as it is written next to an ingredient, with a household measure when the row
 * carries one: „2 ząbki", „1,5 łyżki", „200 g", „2 szt.".
 *
 * A measure only ever labels a `szt` row (decision 323). On `g` and `ml` — and on a row with
 * no measure — this is `formatAmountWithUnit` exactly.
 */
export function formatMeasureAmount(amount: number, unit: Unit, measureName?: string): string {
  if (unit !== 'szt' || measureName === undefined || measureName === '') {
    return formatAmountWithUnit(amount, unit);
  }
  return `${formatAmount(amount)} ${measureWord(measureName, amount)}`;
}
