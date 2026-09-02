/**
 * Calendar dates as `YYYY-MM-DD` strings — the key format of the days table.
 *
 * Always the *local* calendar date, never UTC: a meal belongs to the day the user is
 * living in, and `toISOString()` would move an evening meal to the next day east of
 * Greenwich. All arithmetic here goes through a local `Date` at midday, which keeps a
 * daylight-saving shift from ever landing on the neighbouring day.
 *
 * Formatting is Polish, through `Intl` — it is part of the platform, so it costs no
 * dependency and works offline.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed key that names a real calendar day. */
export function isDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  return toDateKey(parseDateKey(value)) === value;
}

/** Local calendar date of `date`, zero-padded. */
export function toDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

/** Today, as the days table keys it. `now` is injectable so tests are not clock-dependent. */
export function todayDate(now: Date = new Date()): string {
  return toDateKey(now);
}

/**
 * A local `Date` for the key, at 12:00. Midday rather than midnight so that adding whole
 * days never lands inside a daylight-saving transition and slips a day.
 */
export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12);
}

/** `days` calendar days after `key` (negative goes back). */
export function addDays(key: string, days: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/**
 * `years` calendar years after `key` (negative goes back). 29 February in a leap year has
 * no counterpart, so it lands on 1 March, which is what `Date` does anyway.
 */
export function addYears(key: string, years: number): string {
  const date = parseDateKey(key);
  date.setFullYear(date.getFullYear() + years);
  return toDateKey(date);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const millis = parseDateKey(to).getTime() - parseDateKey(from).getTime();
  return Math.round(millis / 86_400_000);
}

/** Day of the week with Monday as 0 — the Polish week (decision 74). */
export function weekdayIndex(key: string): number {
  return (parseDateKey(key).getDay() + 6) % 7;
}

// ---- Polish formatting -------------------------------------------------------------------

const LOCALE = 'pl-PL';

const longFormat = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'long',
  day: 'numeric',
  month: 'long'
});
const weekdayShortFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const monthYearFormat = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const dayMonthFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' });

/** „poniedziałek, 1 września" */
export function formatDayLong(key: string): string {
  return longFormat.format(parseDateKey(key));
}

/** „1 września" */
export function formatDayMonth(key: string): string {
  return dayMonthFormat.format(parseDateKey(key));
}

/** „pon" — the week strip's column header. */
export function formatWeekdayShort(key: string): string {
  return weekdayShortFormat.format(parseDateKey(key)).replace('.', '');
}

/** „wrzesień 2026" */
export function formatMonthYear(key: string): string {
  return monthYearFormat.format(parseDateKey(key));
}

/** Day of the month, without the leading zero the key carries. */
export function dayOfMonth(key: string): number {
  return parseDateKey(key).getDate();
}

/**
 * „Dziś" / „Jutro" / „Wczoraj" for the three days a user thinks of by name, and the full
 * date for everything else. `today` is passed in so nothing here reads the clock.
 */
export function relativeDayLabel(key: string, today: string): string {
  switch (daysBetween(today, key)) {
    case 0:
      return 'Dziś';
    case 1:
      return 'Jutro';
    case -1:
      return 'Wczoraj';
    default:
      return formatDayLong(key);
  }
}
