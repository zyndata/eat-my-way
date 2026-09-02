import { describe, expect, it } from 'vitest';
import { formatBytes, formatPortions, normalizeKey, pluralPl, portionWord } from './text';

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

describe('portions', () => {
  it('uses all three plural forms for whole portions', () => {
    expect(formatPortions(1)).toBe('1 porcja');
    expect(formatPortions(2)).toBe('2 porcje');
    expect(formatPortions(5)).toBe('5 porcji');
    expect(formatPortions(22)).toBe('22 porcje');
  });

  it('puts a fraction in the genitive and writes it with a comma', () => {
    expect(formatPortions(0.5)).toBe('0,5 porcji');
    expect(formatPortions(1.5)).toBe('1,5 porcji');
    expect(formatPortions(2.5)).toBe('2,5 porcji');
  });

  it('offers the bare word for a field that prints the number itself', () => {
    expect(portionWord(1)).toBe('porcja');
    expect(portionWord(3)).toBe('porcje');
    expect(portionWord(1.5)).toBe('porcji');
  });
});

describe('byte sizes', () => {
  it('climbs the units and keeps Google\u2019s reading of a gigabyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    // What Drive calls a free 15 GB account: 15 x 2^30 bytes.
    expect(formatBytes(16_106_127_360)).toBe('15 GB');
  });

  it('loses precision as the number grows, the way a size is quoted out loud', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1.25)).toBe('1,25 GB');
    expect(formatBytes(1024 * 1024 * 42.5)).toBe('42,5 MB');
    expect(formatBytes(1024 * 1024 * 340.7)).toBe('341 MB');
    // Bytes are whole things; there is no such quantity as 0,5 of one.
    expect(formatBytes(512.4)).toBe('512 B');
  });

  it('says nothing rather than something wrong about a figure it does not have', () => {
    expect(formatBytes(Number.NaN)).toBe('\u2014');
    expect(formatBytes(-1)).toBe('\u2014');
  });
});
