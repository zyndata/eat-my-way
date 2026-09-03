import { describe, expect, it } from 'vitest';
import { applyResolutions, baselineOf, byKey, localWins, mergeCollection, newerWins } from './merge';
import { canonicalJson, hashValue } from './hash';

interface Note {
  id: string;
  text: string;
  updatedAt: string;
}

const note = (id: string, text: string, updatedAt = '2026-09-01T00:00:00.000Z'): Note => ({
  id,
  text,
  updatedAt
});

const index = (...notes: Note[]) => byKey(notes, (item) => item.id);

describe('canonical JSON', () => {
  it('is independent of the order properties were built in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('treats an absent property and an undefined one alike', () => {
    expect(hashValue({ a: 1 })).toBe(hashValue({ a: 1, b: undefined }));
  });

  it('keeps array order significant', () => {
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
  });
});

describe('three-way merge', () => {
  it('takes the remote side when only it changed', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(base, index(note('a', 'old')), index(note('a', 'new')));

    expect(result.merged.get('a')?.text).toBe('new');
    expect(result.localOutdated).toBe(true);
    expect(result.remoteOutdated).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it('takes the local side when only it changed', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(base, index(note('a', 'mine')), index(note('a', 'old')));

    expect(result.merged.get('a')?.text).toBe('mine');
    expect(result.remoteOutdated).toBe(true);
    expect(result.localOutdated).toBe(false);
  });

  it('keeps an addition from either side', () => {
    const base = baselineOf(index(note('a', 'shared')));
    const result = mergeCollection(
      base,
      index(note('a', 'shared'), note('b', 'mine')),
      index(note('a', 'shared'), note('c', 'theirs'))
    );

    expect([...result.merged.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(result.conflicts).toHaveLength(0);
  });

  it('honours a deletion instead of resurrecting the row', () => {
    const base = baselineOf(index(note('a', 'x'), note('b', 'y')));
    // Local deleted `b`; remote still has it untouched.
    const result = mergeCollection(base, index(note('a', 'x')), index(note('a', 'x'), note('b', 'y')));

    expect(result.merged.has('b')).toBe(false);
    expect(result.remoteOutdated).toBe(true);
  });

  it('reports a conflict when both sides changed the same entity', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(base, index(note('a', 'mine')), index(note('a', 'theirs')));

    expect(result.conflicts).toEqual([
      { key: 'a', local: note('a', 'mine'), remote: note('a', 'theirs') }
    ]);
    // Until the user answers, the merge stands at the local value and nothing is written.
    expect(result.merged.get('a')?.text).toBe('mine');
  });

  it('reports a delete-versus-edit as a conflict too', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(base, index(), index(note('a', 'theirs')));

    expect(result.conflicts[0]).toEqual({ key: 'a', local: undefined, remote: note('a', 'theirs') });
  });

  it('does not consult the baseline when both sides already agree', () => {
    const base = baselineOf(index(note('a', 'ancient')));
    const result = mergeCollection(base, index(note('a', 'same')), index(note('a', 'same')));

    expect(result.conflicts).toHaveLength(0);
    expect(result.localOutdated).toBe(false);
    expect(result.remoteOutdated).toBe(false);
  });

  it('applies the user’s answers', () => {
    const base = baselineOf(index(note('a', 'old'), note('b', 'old')));
    const result = mergeCollection(
      base,
      index(note('a', 'mine'), note('b', 'mine')),
      index(note('a', 'theirs'), note('b', 'theirs'))
    );

    const resolved = applyResolutions(
      result,
      new Map([
        ['a', 'remote' as const],
        ['b', 'local' as const]
      ])
    );
    expect(resolved.get('a')?.text).toBe('theirs');
    expect(resolved.get('b')?.text).toBe('mine');
  });

  it('deletes the entity when the chosen side had deleted it', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(base, index(), index(note('a', 'theirs')));

    expect(applyResolutions(result, new Map([['a', 'local' as const]])).has('a')).toBe(false);
  });
});

describe('automatic tie-breaks', () => {
  it('newerWins takes the later updatedAt', () => {
    const base = baselineOf(index(note('a', 'old', '2026-09-01T00:00:00.000Z')));
    const result = mergeCollection(
      base,
      index(note('a', 'mine', '2026-09-02T00:00:00.000Z')),
      index(note('a', 'theirs', '2026-09-03T00:00:00.000Z')),
      newerWins<Note>()
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.merged.get('a')?.text).toBe('theirs');
  });

  it('newerWins counts a row with no updatedAt as the older side', () => {
    // Custom ingredients written before Phase 10 carry no timestamp (STATE.md decision 182).
    // An un-stamped row must lose to an edited copy, whichever device it happens to sit on.
    const undated = { id: 'a', text: 'przed fazą 10' } as Note;
    const base = baselineOf(index(note('a', 'old', '2026-08-01T00:00:00.000Z')));

    const theirsIsNewer = mergeCollection(
      base,
      index(undated),
      index(note('a', 'poprawione', '2026-09-02T00:00:00.000Z')),
      newerWins<Note>()
    );
    expect(theirsIsNewer.merged.get('a')?.text).toBe('poprawione');

    const oursIsNewer = mergeCollection(
      base,
      index(note('a', 'poprawione', '2026-09-02T00:00:00.000Z')),
      index(undated),
      newerWins<Note>()
    );
    expect(oursIsNewer.merged.get('a')?.text).toBe('poprawione');
  });

  it('localWins keeps this device’s value', () => {
    const base = baselineOf(index(note('a', 'old')));
    const result = mergeCollection(
      base,
      index(note('a', 'mine')),
      index(note('a', 'theirs')),
      localWins<Note>()
    );

    expect(result.merged.get('a')?.text).toBe('mine');
  });
});
