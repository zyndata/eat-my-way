import { describe, expect, it } from 'vitest';
import { normalizeKey, stripDiacritics } from './text';
import {
  bumpTag,
  countTagUses,
  makeTag,
  planTagRename,
  rankTags,
  removeTagKey,
  replaceTagKey,
  resolveTags,
  tagKey,
  toTagKeys
} from './tags';
import type { Tag } from './types';
import { makeRecipe } from '../test/fixtures';

describe('normalizeKey', () => {
  it('strips every Polish diacritic, including the stroked l', () => {
    expect(normalizeKey('Śniadanie')).toBe('sniadanie');
    expect(normalizeKey('Łosoś')).toBe('losos');
    expect(normalizeKey('ŻÓŁĆ')).toBe('zolc');
    expect(normalizeKey('Zażółć gęślą jaźń')).toBe('zazolc gesla jazn');
    expect(normalizeKey('Ćwikła')).toBe('cwikla');
  });

  it('lowercases, collapses whitespace and trims', () => {
    expect(normalizeKey('  Bez   GLUTENU ')).toBe('bez glutenu');
  });

  it('leaves an already normalized key alone', () => {
    expect(normalizeKey('obiad')).toBe('obiad');
  });

  it('keeps case and spacing when only stripping diacritics', () => {
    expect(stripDiacritics('Żurek Śląski')).toBe('Zurek Slaski');
  });
});

describe('tag identity', () => {
  it('collapses spellings that differ only by case or diacritics', () => {
    expect(tagKey('Bez Glutenu')).toBe(tagKey('bez glutenu'));
    expect(tagKey('Śniadanie')).toBe(tagKey('sniadanie'));
  });

  it('keeps the label as first typed and starts unused', () => {
    expect(makeTag('  Śniadanie ')).toEqual({ key: 'sniadanie', label: 'Śniadanie', useCount: 0 });
  });

  it('deduplicates keys and drops blanks, preserving first-seen order', () => {
    expect(toTagKeys(['Obiad', 'obiad', '   ', 'Śniadanie'])).toEqual(['obiad', 'sniadanie']);
  });
});

describe('resolveTags', () => {
  const existing: Tag[] = [{ key: 'obiad', label: 'Obiad', useCount: 3 }];

  it('creates only the unknown tags and never restyles an existing label', () => {
    const { keys, created } = resolveTags(['OBIAD', 'Bez glutenu'], existing);

    expect(keys).toEqual(['obiad', 'bez glutenu']);
    expect(created).toEqual([{ key: 'bez glutenu', label: 'Bez glutenu', useCount: 0 }]);
  });

  it('creates a tag only once even if typed twice', () => {
    const { created } = resolveTags(['Wege', 'wege'], []);
    expect(created).toHaveLength(1);
  });
});

describe('bumpTag', () => {
  const tag: Tag = { key: 'obiad', label: 'Obiad', useCount: 1 };

  it('counts up and down without mutating', () => {
    expect(bumpTag(tag).useCount).toBe(2);
    expect(bumpTag(tag, -1).useCount).toBe(0);
    expect(tag.useCount).toBe(1);
  });

  it('never goes below zero', () => {
    expect(bumpTag(tag, -5).useCount).toBe(0);
  });
});

describe('rankTags', () => {
  const tags = [
    { key: 'obiad', label: 'Obiad', useCount: 12 },
    { key: 'sniadanie', label: 'Śniadanie', useCount: 4 },
    { key: 'obiad wegetarianski', label: 'Obiad wegetariański', useCount: 1 },
    { key: 'szybkie', label: 'Szybkie', useCount: 7 }
  ];

  it('ranks an exact match above a prefix match', () => {
    expect(rankTags('obiad', tags).map((tag) => tag.key)).toEqual([
      'obiad',
      'obiad wegetarianski'
    ]);
  });

  it('matches without Polish letters', () => {
    expect(rankTags('sniad', tags).map((tag) => tag.label)).toEqual(['Śniadanie']);
  });

  it('offers the most-used tags for an empty query', () => {
    expect(rankTags('', tags, { limit: 2 }).map((tag) => tag.key)).toEqual(['obiad', 'szybkie']);
  });

  it('never re-offers a tag the recipe already carries', () => {
    expect(rankTags('', tags, { exclude: ['obiad', 'szybkie'] }).map((tag) => tag.key)).toEqual([
      'sniadanie',
      'obiad wegetarianski'
    ]);
  });
});

describe('tag administration helpers', () => {
  it('replaceTagKey swaps the key and collapses the duplicate a merge creates', () => {
    expect(replaceTagKey(['obiad', 'szybkie'], 'obiad', 'kolacja')).toEqual([
      'kolacja',
      'szybkie'
    ]);
    // A recipe carrying both already: the merge must not leave it counted twice.
    expect(replaceTagKey(['obiad', 'szybkie'], 'obiad', 'szybkie')).toEqual(['szybkie']);
    expect(replaceTagKey(['szybkie'], 'obiad', 'kolacja')).toEqual(['szybkie']);
  });

  it('removeTagKey drops just that key', () => {
    expect(removeTagKey(['obiad', 'szybkie'], 'obiad')).toEqual(['szybkie']);
  });

  it('countTagUses counts recipes, not tag occurrences', () => {
    const counts = countTagUses([
      makeRecipe({ id: 'r1', tags: ['obiad'] }),
      makeRecipe({ id: 'r2', tags: ['obiad', 'szybkie'] })
    ]);
    expect(counts.get('obiad')).toBe(2);
    expect(counts.get('szybkie')).toBe(1);
  });

  it('planTagRename tells a relabel, a rekey and a merge apart', () => {
    const obiad: Tag = { key: 'obiad', label: 'Obiad', useCount: 2 };
    const szybkie: Tag = { key: 'szybkie', label: 'Szybkie', useCount: 1 };
    const all = [obiad, szybkie];

    expect(planTagRename(obiad, 'Obiad', all)).toEqual({ kind: 'noop' });
    expect(planTagRename(obiad, '  ', all)).toEqual({ kind: 'invalid' });
    // Same key, different spelling — nothing but the label moves.
    expect(planTagRename(obiad, 'OBIAD', all)).toEqual({
      kind: 'relabel',
      key: 'obiad',
      label: 'OBIAD'
    });
    expect(planTagRename(obiad, 'Obiad dnia', all)).toEqual({
      kind: 'rekey',
      from: 'obiad',
      to: 'obiad dnia',
      label: 'Obiad dnia'
    });
    // „Szybkie" normalizes onto a key that already exists: that is a merge, and the user
    // is asked rather than having the two folded together quietly.
    expect(planTagRename(obiad, 'szybkie', all)).toEqual({
      kind: 'merge',
      from: 'obiad',
      to: 'szybkie'
    });
  });
});
