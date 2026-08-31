import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfMonth,
  daysBetween,
  formatDayLong,
  formatMonthYear,
  formatWeekdayShort,
  isDateKey,
  parseDateKey,
  relativeDayLabel,
  toDateKey,
  todayDate,
  weekdayIndex
} from './dates';

describe('toDateKey', () => {
  it('zero-pads month and day', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses the local calendar date, not UTC', () => {
    // 23:30 local on the 31st is already the next day in UTC east of Greenwich; the meal
    // still belongs to the 31st.
    expect(toDateKey(new Date(2026, 7, 31, 23, 30))).toBe('2026-08-31');
  });
});

describe('todayDate', () => {
  it('formats the injected clock', () => {
    expect(todayDate(new Date(2026, 8, 7, 8, 0))).toBe('2026-09-07');
  });
});

describe('isDateKey', () => {
  it('accepts a real calendar day', () => {
    expect(isDateKey('2026-02-28')).toBe(true);
    expect(isDateKey('2024-02-29')).toBe(true);
  });

  it('rejects malformed and impossible dates', () => {
    // The route parameter is whatever is in the URL bar, so this is a real input.
    expect(isDateKey('przyklad')).toBe(false);
    expect(isDateKey('2026-8-31')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('2026-02-30')).toBe(false);
  });
});

describe('parseDateKey', () => {
  it('lands at local midday, so day arithmetic cannot slip', () => {
    const date = parseDateKey('2026-09-07');
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([
      2026, 8, 7, 12
    ]);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('survives a daylight-saving transition', () => {
    // Europe/Warsaw springs forward on 2026-03-29; a midnight-based Date would lose an hour
    // and land back on the 29th.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('adding a week seven times is the same as adding 49 days', () => {
    let date = '2026-08-31';
    for (let step = 0; step < 7; step += 1) date = addDays(date, 7);
    expect(date).toBe(addDays('2026-08-31', 49));
  });
});

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-09-01', '2026-08-31')).toBe(-1);
    expect(daysBetween('2026-08-31', '2026-08-31')).toBe(0);
  });

  it('is unaffected by a daylight-saving transition', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });
});

describe('weekdayIndex', () => {
  it('counts Monday as 0', () => {
    // 2026-08-31 is a Monday, 2026-09-06 the Sunday after it.
    expect(weekdayIndex('2026-08-31')).toBe(0);
    expect(weekdayIndex('2026-09-06')).toBe(6);
  });
});

describe('dayOfMonth', () => {
  it('drops the leading zero the key carries', () => {
    expect(dayOfMonth('2026-09-05')).toBe(5);
  });
});

describe('Polish formatting', () => {
  it('names the weekday, day and month', () => {
    expect(formatDayLong('2026-08-31')).toBe('poniedziałek, 31 sierpnia');
  });

  it('abbreviates the weekday without a trailing dot', () => {
    expect(formatWeekdayShort('2026-08-31')).toBe('pon');
  });

  it('names the month and year', () => {
    expect(formatMonthYear('2026-09-15')).toBe('wrzesień 2026');
  });
});

describe('relativeDayLabel', () => {
  const today = '2026-08-31';

  it('names the three days a user thinks of by name', () => {
    expect(relativeDayLabel('2026-08-31', today)).toBe('Dziś');
    expect(relativeDayLabel('2026-09-01', today)).toBe('Jutro');
    expect(relativeDayLabel('2026-08-30', today)).toBe('Wczoraj');
  });

  it('falls back to the full date for anything further out', () => {
    expect(relativeDayLabel('2026-09-02', today)).toBe('środa, 2 września');
  });
});
