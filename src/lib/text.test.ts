import { describe, expect, it } from 'vitest';
import {
  MEASURE_NAMES,
  formatBytes,
  formatMeasureAmount,
  formatPortions,
  isMeasureName,
  measureWord,
  normalizeKey,
  pluralPl,
  portionWord,
  sourceHost
} from './text';

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

describe('sourceHost', () => {
  it('shows the host and drops a leading www', () => {
    expect(sourceHost('https://www.kwestiasmaku.com/przepis/zurek?p=1')).toBe('kwestiasmaku.com');
    expect(sourceHost('https://przepisy.pl/a/b#c')).toBe('przepisy.pl');
  });

  it('falls back to the value rather than rendering an empty row', () => {
    expect(sourceHost('nie-adres')).toBe('nie-adres');
  });
});

describe('household measures', () => {
  it('declines each name over the counts that actually occur', () => {
    // The four shapes, on the name the phase was written for.
    expect(measureWord('ząbek', 1)).toBe('ząbek');
    expect(measureWord('ząbek', 2)).toBe('ząbki');
    expect(measureWord('ząbek', 5)).toBe('ząbków');
    expect(measureWord('ząbek', 1.5)).toBe('ząbka');

    expect(measureWord('kromka', 1)).toBe('kromka');
    expect(measureWord('kromka', 3)).toBe('kromki');
    expect(measureWord('kromka', 5)).toBe('kromek');

    expect(measureWord('plaster', 2)).toBe('plastry');
    expect(measureWord('plaster', 7)).toBe('plastrów');

    expect(measureWord('łyżka', 2)).toBe('łyżki');
    expect(measureWord('łyżka', 5)).toBe('łyżek');
    expect(measureWord('łyżeczka', 5)).toBe('łyżeczek');

    expect(measureWord('szklanka', 2)).toBe('szklanki');
    expect(measureWord('szklanka', 5)).toBe('szklanek');
    expect(measureWord('kubek', 5)).toBe('kubków');

    expect(measureWord('garść', 2)).toBe('garście');
    expect(measureWord('garść', 5)).toBe('garści');

    expect(measureWord('pęczek', 2)).toBe('pęczki');
    expect(measureWord('pęczek', 5)).toBe('pęczków');
    expect(measureWord('gałązka', 5)).toBe('gałązek');

    expect(measureWord('opakowanie', 2)).toBe('opakowania');
    expect(measureWord('opakowanie', 5)).toBe('opakowań');
    expect(measureWord('porcja', 5)).toBe('porcji');
  });

  it('keeps the teens on the many form, like every other Polish count', () => {
    expect(measureWord('ząbek', 12)).toBe('ząbków');
    expect(measureWord('ząbek', 22)).toBe('ząbki');
    expect(measureWord('kromka', 14)).toBe('kromek');
    expect(measureWord('kromka', 24)).toBe('kromki');
    // Zero is `many`, not `one`.
    expect(measureWord('ząbek', 0)).toBe('ząbków');
  });

  it('leaves the abbreviated szt. undeclined and declines the sized ones', () => {
    expect(measureWord('szt.', 1)).toBe('szt.');
    expect(measureWord('szt.', 5)).toBe('szt.');
    expect(measureWord('szt.', 1.5)).toBe('szt.');
    expect(measureWord('średnia szt.', 1)).toBe('średnia szt.');
    expect(measureWord('średnia szt.', 2)).toBe('średnie szt.');
    expect(measureWord('średnia szt.', 5)).toBe('średnich szt.');
    expect(measureWord('duża szt.', 5)).toBe('dużych szt.');
  });

  it('prints an unknown name untouched rather than dropping it', () => {
    // A recipe written by a newer build must still read as something on an older one.
    expect(measureWord('szczypta', 3)).toBe('szczypta');
    expect(isMeasureName('szczypta')).toBe(false);
    expect(isMeasureName('ząbek')).toBe(true);
    expect(isMeasureName(7)).toBe(false);
  });

  it('has a plural table covering exactly the closed vocabulary', () => {
    expect(MEASURE_NAMES).toHaveLength(16);
    for (const name of MEASURE_NAMES) {
      // No form may fall through to the name itself — that is the unknown-name path.
      expect(measureWord(name, 5).length).toBeGreaterThan(0);
      expect(measureWord(name, 1)).toBe(name);
    }
  });

  it('labels a szt row and leaves every other row exactly as it was', () => {
    expect(formatMeasureAmount(2, 'szt', 'ząbek')).toBe('2 ząbki');
    expect(formatMeasureAmount(1.5, 'szt', 'łyżka')).toBe('1,5 łyżki');
    // No measure, or a unit that cannot carry one: the old spelling, unchanged.
    expect(formatMeasureAmount(2, 'szt')).toBe('2 szt.');
    expect(formatMeasureAmount(200, 'g', 'ząbek')).toBe('200 g');
    expect(formatMeasureAmount(100, 'ml')).toBe('100 ml');
  });
});
