import { describe, expect, it } from 'vitest';
import { normalizeKey, pluralPl } from './text';

const zapytanie = { one: 'zapytanie', few: 'zapytania', many: 'zapytań' };

describe('pluralPl', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralPl(1, zapytanie)).toBe('zapytanie');
  });

  it('uses the 2-4 form, which an English one/many split gets wrong', () => {
    for (const n of [2, 3, 4, 22, 33, 104]) expect(pluralPl(n, zapytanie)).toBe('zapytania');
  });

  it('uses the genitive plural for 0, 5 and up', () => {
    for (const n of [0, 5, 9, 11, 25, 100]) expect(pluralPl(n, zapytanie)).toBe('zapytań');
  });

  it('handles the teens, where 12-14 break the last-digit rule', () => {
    for (const n of [12, 13, 14, 112, 113]) expect(pluralPl(n, zapytanie)).toBe('zapytań');
  });

  it('is unaffected by sign or fraction', () => {
    expect(pluralPl(-2, zapytanie)).toBe('zapytania');
    expect(pluralPl(2.7, zapytanie)).toBe('zapytania');
  });
});

describe('normalizeKey', () => {
  it('strips Polish diacritics, including the stroked l', () => {
    expect(normalizeKey('  Mąka   PSZENNA ')).toBe('maka pszenna');
    expect(normalizeKey('Żółć')).toBe('zolc');
  });
});
