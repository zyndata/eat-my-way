/**
 * Calendar dates as `YYYY-MM-DD` strings — the key format of the days table.
 *
 * Always the *local* calendar date, never UTC: a meal belongs to the day the user is
 * living in, and `toISOString()` would move an evening meal to the next day east of
 * Greenwich. Phase 5 extends this module; nothing here formats anything for display.
 */

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
