import { describe, expect, it } from 'vitest';
import { normalizeKey } from './text';
import { MatchTier, queryTokens, rankCandidates, type SearchCandidate } from './search';

interface Row extends SearchCandidate {
  name: string;
}

function row(name: string, aliases: string[] = [], useCount = 0): Row {
  return {
    name,
    nameKey: normalizeKey(name),
    aliasKeys: aliases.map(normalizeKey),
    useCount
  };
}

const names = (matches: { item: Row }[]) => matches.map((match) => match.item.name);

describe('queryTokens', () => {
  it('normalizes and splits on whitespace', () => {
    expect(queryTokens('  Ser   ŻÓŁTY ')).toEqual(['ser', 'zolty']);
  });

  it('is empty for a blank query', () => {
    expect(queryTokens('   ')).toEqual([]);
  });
});

describe('rankCandidates', () => {
  it('finds „ser żółty" when the query is typed without diacritics', () => {
    const found = rankCandidates('zolty ser', [
      row('Mleko 3,2%'),
      row('Ser żółty gouda', ['gouda', 'ser zolty'])
    ]);

    expect(names(found)).toEqual(['Ser żółty gouda']);
  });

  it('matches words in any order but requires all of them', () => {
    const candidates = [row('Ser żółty gouda', ['ser zolty']), row('Ser feta', ['feta'])];

    expect(names(rankCandidates('zolty ser', candidates))).toEqual(['Ser żółty gouda']);
    expect(names(rankCandidates('ser zolty', candidates))).toEqual(['Ser żółty gouda']);
    expect(rankCandidates('zolty twarog', candidates)).toEqual([]);
  });

  it('ranks a prefix match above an infix match', () => {
    const found = rankCandidates('ser', [
      row('Deser ryżowy'), // 'ser' only in the middle of a word
      row('Ser feta')
    ]);

    expect(names(found)).toEqual(['Ser feta', 'Deser ryżowy']);
    expect(found[0]?.tier).toBe(MatchTier.Prefix);
    expect(found[1]?.tier).toBe(MatchTier.Infix);
  });

  it('ranks an exact name above a longer one that merely starts with the query', () => {
    const found = rankCandidates('ser', [row('Ser żółty gouda'), row('Ser')]);
    expect(names(found)).toEqual(['Ser', 'Ser żółty gouda']);
  });

  it('ranks a word-prefix match above a plain infix match', () => {
    const found = rankCandidates('zolty', [row('Barszcz z zoltymi burakami'.replace('zolt', 'żółt')), row('Ser żółty')]);
    expect(found[0]?.tier).toBe(MatchTier.WordPrefix);
  });

  it('puts ingredients already used in a recipe above unused ones of the same quality', () => {
    const found = rankCandidates('ser', [
      row('Ser feta', [], 0),
      row('Ser gouda', [], 3),
      row('Ser brie', [], 1)
    ]);

    expect(names(found)).toEqual(['Ser gouda', 'Ser brie', 'Ser feta']);
  });

  it('does not let usage override match quality', () => {
    const found = rankCandidates('ser', [
      row('Deser ryżowy', [], 10), // infix, heavily used
      row('Ser feta', [], 0) // prefix, never used
    ]);

    expect(names(found)).toEqual(['Ser feta', 'Deser ryżowy']);
  });

  it('offers the most-used ingredients when nothing is typed yet', () => {
    const found = rankCandidates('  ', [row('Jajko', [], 1), row('Masło', [], 5)]);
    expect(names(found)).toEqual(['Masło', 'Jajko']);
  });

  it('matches aliases as well as names', () => {
    const found = rankCandidates('kartofle', [row('Ziemniaki', ['ziemniak', 'kartofle'])]);
    expect(names(found)).toEqual(['Ziemniaki']);
  });

  it('requires every word to match the same field', () => {
    // 'piers' is in the name, 'filet' in an alias — deliberately not a match.
    const candidates = [row('Pierś z kurczaka', ['filet z kurczaka'])];
    expect(rankCandidates('piers filet', candidates)).toEqual([]);
    expect(names(rankCandidates('filet kurczaka', candidates))).toEqual(['Pierś z kurczaka']);
  });

  it('honours the limit', () => {
    const candidates = Array.from({ length: 30 }, (_, n) => row(`Ser ${n}`));
    expect(rankCandidates('ser', candidates, 5)).toHaveLength(5);
  });
});
