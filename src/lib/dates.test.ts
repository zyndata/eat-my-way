import { describe, expect, it } from 'vitest';
import { toDateKey, todayDate } from './dates';

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
