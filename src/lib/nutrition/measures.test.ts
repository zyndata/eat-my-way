import { describe, expect, it } from 'vitest';
// The build script is `.mjs` and cannot import a `.ts` module, so the closed vocabulary lives
// in two places. This file is the join: it imports both and fails the moment they drift
// (STATE.md decision 350).
import { MEASURE_NAMES as SCRIPT_NAMES, parseMeasures } from '../../../scripts/measures.mjs';
import { MEASURE_NAMES } from '../text';

const WHERE = 'data/pl-ingredients.tsv:42';

describe('the build script and the app agree on the vocabulary', () => {
  it('holds the same names in the same order', () => {
    expect(SCRIPT_NAMES).toEqual([...MEASURE_NAMES]);
  });
});

describe('parseMeasures', () => {
  it('reads nazwa:gramy pairs separated by a bar', () => {
    expect(parseMeasures('ząbek:5|szt.:45', WHERE)).toEqual([
      { name: 'ząbek', grams: 5 },
      { name: 'szt.', grams: 45 }
    ]);
  });

  it('reads a name that contains a space and a full stop', () => {
    expect(parseMeasures('średnia szt.:150|duża szt.:200', WHERE)).toEqual([
      { name: 'średnia szt.', grams: 150 },
      { name: 'duża szt.', grams: 200 }
    ]);
  });

  it('treats an empty column as "this row offers nothing", which is the normal case', () => {
    expect(parseMeasures('', WHERE)).toEqual([]);
    expect(parseMeasures('   ', WHERE)).toEqual([]);
  });

  it('keeps two decimals, so the bundle stays a pure function of its inputs', () => {
    expect(parseMeasures('łyżka:13.567', WHERE)).toEqual([{ name: 'łyżka', grams: 13.57 }]);
  });

  it('fails the build on an unknown measure name', () => {
    expect(() => parseMeasures('szczypta:1', WHERE)).toThrow(/unknown measure name "szczypta"/);
  });

  it('fails the build on a weight of zero or less', () => {
    expect(() => parseMeasures('ząbek:0', WHERE)).toThrow(/more than 0 g/);
    expect(() => parseMeasures('ząbek:-5', WHERE)).toThrow(/more than 0 g/);
    expect(() => parseMeasures('ząbek:pięć', WHERE)).toThrow(/more than 0 g/);
  });

  it('fails the build on a pair that is not a pair, and on a repeated name', () => {
    expect(() => parseMeasures('ząbek', WHERE)).toThrow(/not "nazwa:gramy"/);
    expect(() => parseMeasures('ząbek:5|ząbek:6', WHERE)).toThrow(/listed twice/);
  });

  it('names the file and line it failed on', () => {
    expect(() => parseMeasures('szczypta:1', WHERE)).toThrow(/pl-ingredients\.tsv:42/);
  });
});
