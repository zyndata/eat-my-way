import { hashValue } from './hash';

/**
 * The merge rules. Pure functions over plain data — no Drive, no IndexedDB, no clock.
 *
 * Every collection is merged three ways: the local side, the remote side, and a baseline of
 * content hashes recorded at the last successful sync. The baseline is what turns "the two
 * sides differ" into the only question that matters — *which* side moved:
 *
 *   only local moved   -> take local
 *   only remote moved  -> take remote
 *   neither moved      -> they are equal anyway
 *   both moved         -> the caller decides; for days that means asking the user
 *
 * Deletions fall out of the same rule for free: an entity missing on one side has no hash, so
 * "was present in the baseline, absent now" reads as a change like any other, and a delete on
 * one device is not resurrected by the other device that merely still has the row.
 */

/** Content hashes as of the last successful sync, keyed the same way as the collection. */
export type Baseline = ReadonlyMap<string, string>;

/** What to do when both sides changed the same entity. */
export type BothChanged<T> =
  /** Ask the user. The entity is left at its local value and reported as a conflict. */
  | 'conflict'
  /** Decide it here — used where a deterministic rule exists (newest `updatedAt` wins). */
  | ((local: T | undefined, remote: T | undefined) => T | undefined);

export interface Conflict<T> {
  key: string;
  /** `undefined` means this side deleted the entity. */
  local: T | undefined;
  remote: T | undefined;
}

export interface MergeResult<T> {
  merged: Map<string, T>;
  conflicts: Conflict<T>[];
  /** The merge differs from what this device holds, so local must be rewritten. */
  localOutdated: boolean;
  /** The merge differs from what Drive holds, so the file must be uploaded. */
  remoteOutdated: boolean;
}

function hashOrUndefined<T>(value: T | undefined): string | undefined {
  return value === undefined ? undefined : hashValue(value);
}

/**
 * Merge one keyed collection. `local` and `remote` are complete pictures of their side —
 * an absent key means the entity is not there, not that it is unknown.
 */
export function mergeCollection<T>(
  base: Baseline,
  local: ReadonlyMap<string, T>,
  remote: ReadonlyMap<string, T>,
  onBothChanged: BothChanged<T> = 'conflict'
): MergeResult<T> {
  const merged = new Map<string, T>();
  const conflicts: Conflict<T>[] = [];
  let localOutdated = false;
  let remoteOutdated = false;

  const keep = (key: string, value: T | undefined): void => {
    if (value !== undefined) merged.set(key, value);
    const chosen = hashOrUndefined(value);
    if (chosen !== hashOrUndefined(local.get(key))) localOutdated = true;
    if (chosen !== hashOrUndefined(remote.get(key))) remoteOutdated = true;
  };

  for (const key of new Set([...local.keys(), ...remote.keys(), ...base.keys()])) {
    const ours = local.get(key);
    const theirs = remote.get(key);
    const ourHash = hashOrUndefined(ours);
    const theirHash = hashOrUndefined(theirs);

    if (ourHash === theirHash) {
      keep(key, ours);
      continue;
    }

    const baseHash = base.get(key);
    const weChanged = ourHash !== baseHash;
    const theyChanged = theirHash !== baseHash;

    if (!weChanged) {
      keep(key, theirs);
      continue;
    }
    if (!theyChanged) {
      keep(key, ours);
      continue;
    }

    if (onBothChanged === 'conflict') {
      conflicts.push({ key, local: ours, remote: theirs });
      // Left at the local value until the user answers; nothing is written meanwhile.
      keep(key, ours);
      continue;
    }
    keep(key, onBothChanged(ours, theirs));
  }

  return { merged, conflicts, localOutdated, remoteOutdated };
}

/** Apply the user's answers to a conflicted merge, producing the collection to store. */
export function applyResolutions<T>(
  result: MergeResult<T>,
  choices: ReadonlyMap<string, 'local' | 'remote'>
): Map<string, T> {
  const merged = new Map(result.merged);
  for (const conflict of result.conflicts) {
    const chosen = choices.get(conflict.key) === 'remote' ? conflict.remote : conflict.local;
    if (chosen === undefined) merged.delete(conflict.key);
    else merged.set(conflict.key, chosen);
  }
  return merged;
}

/** Anything carrying an ISO `updatedAt`, which is enough to break a tie without asking. */
export interface Timestamped {
  updatedAt: string;
}

/**
 * The rule for entities that carry their own edit time. Recipes use it: two devices editing
 * *different* recipes never collide, and two devices editing the *same* recipe is rare enough
 * — and recoverable enough, the recipe is still there — that a prompt would cost more than it
 * saves. PLAN.md reserves the prompt for days, where the loss would be a day's plan.
 */
export function newerWins<T extends Timestamped>(): BothChanged<T> {
  return (local, remote) => {
    if (local === undefined) return remote;
    if (remote === undefined) return local;
    return remote.updatedAt > local.updatedAt ? remote : local;
  };
}

/** The rule for entities that are only ever added to, where either side's copy will do. */
export function localWins<T>(): BothChanged<T> {
  return (local, remote) => local ?? remote;
}

/** Index a list by a key so it can go into `mergeCollection`. */
export function byKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

/** The baseline entry for every member of a merged collection. */
export function baselineOf<T>(collection: ReadonlyMap<string, T>): Map<string, string> {
  return new Map([...collection].map(([key, value]) => [key, hashValue(value)]));
}
