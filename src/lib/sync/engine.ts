import type { Day, Ingredient, Profile, Recipe, Tag } from '../types';
import type { DriveFileRow } from '../db';
import { DEFAULT_PROFILE } from '../db';
import type { MergedData, Repository, SyncSnapshot } from '../repository';
import {
  NotAuthenticatedError,
  RemoteChangedError,
  type AccountInfo,
  type RemoteVersion,
  type StorageBackend
} from './backend';
import {
  INGREDIENTS_FILE,
  PROFILE_FILE,
  RECIPES_FILE,
  VAULT_FILE,
  daysFileName,
  monthFromDaysFileName,
  monthOf,
  readDaysDocument,
  readIngredientsDocument,
  mergeGeminiUsage,
  readProfileDocument,
  readRecipesDocument,
  type DaysDocument,
  type IngredientCorrection
} from './documents';
import { hashValue } from './hash';
import {
  applyResolutions,
  baselineOf,
  byKey,
  localWins,
  mergeCollection,
  newerWins,
  type Conflict,
  type MergeResult
} from './merge';

/**
 * The sync engine: one pass over the whole dataset, merging IndexedDB against Drive.
 *
 * IndexedDB stays the source of truth (PLAN.md). Sync never blocks a screen, never runs on a
 * timer while the user is typing, and can fail entirely without the app noticing — every
 * failure path here leaves local data exactly as it was.
 *
 * The order is deliberate: read both sides, merge in memory, ask the user about any same-day
 * conflict, *then* write locally and upload. Nothing is written anywhere until every decision
 * has been made, so an abandoned conflict prompt leaves both sides untouched.
 */

/** One day two devices both edited. The user picks a side; the engine never guesses. */
export interface DayConflict {
  date: string;
  /** `undefined` means that side deleted (cleared) the day. */
  local: Day | undefined;
  remote: Day | undefined;
}

/** Answers the conflict prompt. `null` aborts the sync without writing anything. */
export type ConflictResolver = (
  conflicts: DayConflict[]
) => Promise<ReadonlyMap<string, 'local' | 'remote'> | null>;

export type SyncOutcome =
  | {
      status: 'ok';
      /** Something arrived from Drive. */
      pulled: boolean;
      /** Something was uploaded. */
      pushed: boolean;
      /** The vault on Drive replaced the local copy (STATE.md decision 93). */
      vaultAdopted: boolean;
      /** The folder held nothing when this sync began — what the wizard keys off. */
      freshFolder: boolean;
      account: AccountInfo;
    }
  /** The connected account is not the one this data belongs to. Nothing was read or written. */
  | { status: 'foreign-account'; account: AccountInfo; storedSub: string }
  /** No usable Google session. The caller may retry interactively from a click. */
  | { status: 'unauthenticated'; message: string }
  /** The user dismissed the conflict prompt. Both sides are unchanged. */
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Which of the two waits the user is in (Phase 11 task 3). Drive reports no totals, so there is
 * no honest percentage — but „waiting on the Google window" and „reading and writing your
 * files" feel different and fail differently, and naming which one is running is the only
 * progress this app can report truthfully.
 */
export type SyncStage = 'authenticating' | 'transferring';

export interface SyncOptions {
  /** May open the Google consent popup. Only ever true when the user clicked something. */
  interactive?: boolean;
  resolveConflicts?: ConflictResolver;
  /**
   * Proceed even though the account differs from `Profile.googleSub`. The caller must have
   * asked the user first; this also clears the sync baseline, since the new account's folder
   * has nothing to do with the old one's history.
   */
  acceptAccount?: boolean;
  /** Told which wait is running, so the button that started it can say so. */
  onstage?: (stage: SyncStage) => void;
}

/** How many times a write racing another device is retried before giving up. */
const MAX_ATTEMPTS = 3;

/** Baseline key namespaces. Kept here so nothing else has to know their spelling. */
const key = {
  profile: 'profile',
  vault: 'vault',
  recipe: (id: string) => `recipe:${id}`,
  tag: (tagKey: string) => `tag:${tagKey}`,
  ingredient: (id: string) => `ingredient:${id}`,
  correction: (nameKey: string) => `correction:${nameKey}`,
  day: (date: string) => `day:${date}`
};

/**
 * Nothing the user has said. `locale` is a constant, `googleSub` is bookkeeping and
 * `geminiUsage` is a counter merged on its own — what is left is exactly the settings screen.
 */
function isUntouchedProfile(profile: Profile): boolean {
  return (
    hashValue(profile.goals) === hashValue(DEFAULT_PROFILE.goals) &&
    profile.geminiModel === DEFAULT_PROFILE.geminiModel &&
    profile.encryptVault === DEFAULT_PROFILE.encryptVault
  );
}

/** The subset of a baseline under one prefix, with the prefix removed. */
function scoped(baseline: ReadonlyMap<string, string>, prefix: string): Map<string, string> {
  const scopedBaseline = new Map<string, string>();
  for (const [baselineKey, hash] of baseline) {
    if (baselineKey.startsWith(prefix)) scopedBaseline.set(baselineKey.slice(prefix.length), hash);
  }
  return scopedBaseline;
}

/** True when `collection` matches its baseline exactly — nothing added, changed or removed. */
function matchesBaseline<T>(
  collection: ReadonlyMap<string, T>,
  baseline: ReadonlyMap<string, string>
): boolean {
  if (collection.size !== baseline.size) return false;
  for (const [entryKey, value] of collection) {
    if (baseline.get(entryKey) !== hashValue(value)) return false;
  }
  return true;
}

/**
 * What actually gets merged about a tag: its label, keyed by the tag key. `useCount` is
 * derived from the recipes carrying the tag, so merging it would only let a counter that
 * drifted apart make every sync look like a change.
 *
 * Labels used to be resolved as „local wins, because one side has to", which meant a rename
 * never reached the other device and the two disagreed for good (STATE.md decision 229).
 * Merged as a keyed collection they behave like everything else: the side that moved away
 * from the baseline wins, and a deletion is a key that left.
 */
function labelsOf(tags: Iterable<Tag>): Map<string, string> {
  return new Map([...tags].map((tag) => [tag.key, tag.label]));
}

/** The tag rows to store: one per merged label, with `useCount` recomputed from the recipes. */
function tagsFrom(
  labels: ReadonlyMap<string, string>,
  recipes: ReadonlyMap<string, Recipe>
): Map<string, Tag> {
  const counts = new Map<string, number>();
  for (const recipe of recipes.values()) {
    for (const tagKey of new Set(recipe.tags)) counts.set(tagKey, (counts.get(tagKey) ?? 0) + 1);
  }

  const merged = new Map<string, Tag>();
  for (const [tagKey, label] of labels) {
    merged.set(tagKey, { key: tagKey, label, useCount: counts.get(tagKey) ?? 0 });
  }
  // A tag used by a merged recipe but described by neither side still needs a row.
  for (const [tagKey, useCount] of counts) {
    if (!merged.has(tagKey)) merged.set(tagKey, { key: tagKey, label: tagKey, useCount });
  }
  return merged;
}

/** One logical file as the engine handles it: what Drive has, and what we last saw. */
interface RemoteState {
  /** `null` when the file does not exist on Drive. */
  version: RemoteVersion | null;
  /** Parsed content, or `undefined` when it was not downloaded because it had not moved. */
  content?: unknown;
}

export function createSyncEngine(backend: StorageBackend, repository: Repository) {
  /**
   * `whenMissing` says what an absent file means. Only `days/*.json` is ever deleted by this
   * engine — when a month is emptied — so only there does "no file" mean "no days"; for every
   * other file an absence is something unexpected, and the safe reading is "Drive has no
   * opinion", which keeps the local side and recreates the file.
   */
  async function readRemote(
    name: string,
    known: DriveFileRow | undefined,
    listed: Map<string, RemoteVersion>,
    whenMissing: 'empty' | 'unknown' = 'unknown'
  ): Promise<RemoteState> {
    const version = listed.get(name) ?? null;
    if (version === null) return whenMissing === 'empty' ? { version: null, content: {} } : { version: null };

    // Unmoved since the last sync: whatever it holds is exactly the baseline, and the
    // baseline is already in hand. This is what makes an ordinary sync one request.
    if (known !== undefined && known.modifiedTime === version.modifiedTime) return { version };

    const content = await backend.read(name);
    if (content === null) return whenMissing === 'empty' ? { version: null, content: {} } : { version: null };
    try {
      return { version: content.version, content: JSON.parse(content.content) };
    } catch {
      // A file we cannot parse is treated as absent rather than as an empty dataset: the
      // merge then takes the local side and rewrites it, instead of deleting everything.
      return { version: content.version };
    }
  }

  /**
   * Merge one collection against a remote file. When the file has not moved since the last
   * sync there is nothing to merge — the remote side *is* the baseline — so this only reports
   * whether the local side drifted and therefore needs uploading.
   */
  function mergeAgainst<T>(
    remote: RemoteState,
    local: Map<string, T>,
    baseline: Map<string, string>,
    readRemoteCollection: (content: unknown) => Map<string, T>,
    onBothChanged: Parameters<typeof mergeCollection<T>>[3] = 'conflict'
  ): MergeResult<T> {
    if (remote.content === undefined) {
      const drifted = !matchesBaseline(local, baseline);
      return {
        merged: local,
        conflicts: [],
        localOutdated: false,
        // A file that does not exist on Drive at all still has to be created.
        remoteOutdated: drifted || remote.version === null
      };
    }
    return mergeCollection(baseline, local, readRemoteCollection(remote.content), onBothChanged);
  }

  async function runOnce(options: SyncOptions): Promise<SyncOutcome> {
    options.onstage?.('authenticating');
    const account = await backend.authenticate({ interactive: options.interactive === true });
    options.onstage?.('transferring');

    const snapshot: SyncSnapshot = await repository.syncSnapshot();
    if (
      snapshot.profile.googleSub !== undefined &&
      snapshot.profile.googleSub !== account.id &&
      options.acceptAccount !== true
    ) {
      // PLAN.md: say so, never silently start a fresh profile on the other account.
      return { status: 'foreign-account', account, storedSub: snapshot.profile.googleSub };
    }

    if (options.acceptAccount === true && snapshot.profile.googleSub !== account.id) {
      await repository.resetSyncState();
    }

    const baseline = options.acceptAccount === true ? new Map<string, string>() : await repository.syncBaseline();
    const known = await repository.driveFiles();

    const listed = new Map<string, RemoteVersion>();
    for (const file of await backend.list()) {
      listed.set(file.name, { fileId: file.fileId, modifiedTime: file.modifiedTime });
    }
    const freshFolder = listed.size === 0;

    // Every month either side knows about. A month only one side has is still merged, so a
    // fresh device pulls history it never had.
    const months = new Set<string>(snapshot.days.map((day) => monthOf(day.date)));
    for (const name of listed.keys()) {
      const month = monthFromDaysFileName(name);
      if (month !== undefined) months.add(month);
    }

    // ---- read every file we might need ------------------------------------------------

    const remoteProfile = await readRemote(PROFILE_FILE, known.get(PROFILE_FILE), listed);
    const remoteRecipes = await readRemote(RECIPES_FILE, known.get(RECIPES_FILE), listed);
    const remoteIngredients = await readRemote(INGREDIENTS_FILE, known.get(INGREDIENTS_FILE), listed);
    const remoteVault = await readRemote(VAULT_FILE, known.get(VAULT_FILE), listed);
    const remoteDays = new Map<string, RemoteState>();
    for (const month of months) {
      const name = daysFileName(month);
      remoteDays.set(month, await readRemote(name, known.get(name), listed, 'empty'));
    }

    // ---- merge ------------------------------------------------------------------------

    const localProfile = { ...snapshot.profile, googleSub: account.id };
    const profileBaseline = new Map<string, string>();
    const storedProfileHash = baseline.get(key.profile);
    if (storedProfileHash !== undefined) profileBaseline.set(key.profile, storedProfileHash);

    // A device that has never synced always *looks* like it edited the profile: the database
    // seeds `DEFAULT_PROFILE` when it is created, so there is a document to hash before the
    // user has typed anything. With no baseline to say otherwise that read as a two-sided edit
    // and `localWins` handed the account's real goals to a profile nobody had written — which
    // is how a browser whose data was cleared came back with everything except its goals, and
    // then pushed the defaults over them on Drive (STATE.md decision 227).
    const untouched = storedProfileHash === undefined && isUntouchedProfile(snapshot.profile);

    const profileMerge = mergeAgainst(
      remoteProfile,
      new Map([[key.profile, localProfile]]),
      profileBaseline,
      (content) => new Map([[key.profile, readProfileDocument(content, DEFAULT_PROFILE)]]),
      // Both sides edited the profile: keep this device's, which is the one in front of the
      // user. It is four numbers and two settings, all of them re-enterable in one screen —
      // unless this device has nothing of its own to keep, and then the account's wins.
      untouched
        ? (local, remote) => remote ?? local
        : localWins<Profile>()
    );
    const winner = profileMerge.merged.get(key.profile) ?? localProfile;

    // The one field that must not follow "local wins": the Gemini tally is a grow-only counter
    // per device, and taking one side's whole document would drop the other device's spend.
    // Unioning it here keeps every other profile field on the winning document (types.ts).
    const remoteUsage =
      remoteProfile.content === undefined
        ? undefined
        : readProfileDocument(remoteProfile.content, DEFAULT_PROFILE).geminiUsage;
    const mergedUsage = mergeGeminiUsage(localProfile.geminiUsage, remoteUsage);
    const mergedProfile: Profile =
      mergedUsage === undefined ? winner : { ...winner, geminiUsage: mergedUsage };

    const recipesDoc = remoteRecipes.content === undefined ? undefined : readRecipesDocument(remoteRecipes.content);
    const recipeMerge = mergeAgainst(
      remoteRecipes,
      byKey(snapshot.recipes, (recipe) => recipe.id),
      scoped(baseline, 'recipe:'),
      () => byKey(recipesDoc?.recipes ?? [], (recipe) => recipe.id),
      // Recipes carry their own `updatedAt`, so the newer edit wins without a prompt.
      newerWins<Recipe>()
    );
    // Tags travel inside `recipes.json`, so they merge against the same remote state — which
    // also means the file has to be uploaded when only a label moved, and it never was
    // (decision 229).
    const tagMerge = mergeAgainst(
      remoteRecipes,
      labelsOf(snapshot.tags),
      scoped(baseline, 'tag:'),
      () => labelsOf(recipesDoc?.tags ?? []),
      // Both devices renamed the same tag: keep this one's, the way the profile does.
      localWins<string>()
    );
    const mergedTags = tagsFrom(tagMerge.merged, recipeMerge.merged);

    const ingredientsDoc =
      remoteIngredients.content === undefined ? undefined : readIngredientsDocument(remoteIngredients.content);
    const ingredientMerge = mergeAgainst(
      remoteIngredients,
      byKey(snapshot.customIngredients, (ingredient) => ingredient.id),
      scoped(baseline, 'ingredient:'),
      () => byKey(ingredientsDoc?.ingredients ?? [], (ingredient) => ingredient.id),
      // Custom ingredients became editable in Phase 10, which retired the „only ever added to"
      // premise `localWins` rested on: two devices that both corrected one row would otherwise
      // keep whichever synced last, silently. A row written before that phase carries no
      // `updatedAt` and loses to an edited copy (STATE.md decision 182).
      newerWins<Ingredient>()
    );
    const correctionMerge = mergeAgainst(
      remoteIngredients,
      byKey(snapshot.corrections, (correction) => correction.nameKey),
      scoped(baseline, 'correction:'),
      () => byKey(ingredientsDoc?.corrections ?? [], (correction) => correction.nameKey),
      newerWins<IngredientCorrection>()
    );

    const dayBaseline = scoped(baseline, 'day:');
    const localDays = byKey(snapshot.days, (day) => day.date);
    const dayMerges = new Map<string, MergeResult<Day>>();
    const conflicts: Conflict<Day>[] = [];

    for (const month of months) {
      const inMonth = <T>(source: ReadonlyMap<string, T>): Map<string, T> =>
        new Map([...source].filter(([date]) => monthOf(date) === month));

      const merge = mergeAgainst(
        remoteDays.get(month) ?? { version: null, content: {} },
        inMonth(localDays),
        inMonth(dayBaseline),
        (content) => new Map(Object.entries(readDaysDocument(content)))
      );
      dayMerges.set(month, merge);
      conflicts.push(...merge.conflicts);
    }

    // ---- ask about same-day conflicts before anything is written -----------------------

    let choices: ReadonlyMap<string, 'local' | 'remote'> = new Map();
    if (conflicts.length > 0) {
      const answers = await options.resolveConflicts?.(
        conflicts.map((conflict) => ({ date: conflict.key, local: conflict.local, remote: conflict.remote }))
      );
      if (answers === undefined || answers === null) return { status: 'cancelled' };
      choices = answers;
    }

    const mergedDays = new Map<string, Day>();
    for (const merge of dayMerges.values()) {
      for (const [date, day] of applyResolutions(merge, choices)) mergedDays.set(date, day);
    }

    // ---- the vault: opaque bytes, never merged ----------------------------------------

    const remoteVaultText =
      remoteVault.content === undefined ? undefined : JSON.stringify(remoteVault.content);
    const vaultBaseline = baseline.get(key.vault);
    const localVaultHash = snapshot.vaultFile === undefined ? undefined : hashValue(snapshot.vaultFile);
    const remoteVaultHash = remoteVaultText === undefined ? vaultBaseline : hashValue(remoteVaultText);

    let vaultText = snapshot.vaultFile;
    let vaultAdopted = false;
    let vaultUpload = false;
    if (localVaultHash !== remoteVaultHash) {
      if (remoteVaultHash !== vaultBaseline) {
        // Drive moved. A vault is opaque ciphertext — there is nothing to merge — so the
        // shared copy wins and the user is told (STATE.md decision 93).
        vaultText = remoteVaultText;
        vaultAdopted = true;
      } else {
        vaultUpload = true;
      }
    } else if (remoteVault.version === null && snapshot.vaultFile !== undefined) {
      vaultUpload = true;
    }

    // ---- write locally ----------------------------------------------------------------

    const merged: MergedData = {
      profile: mergedProfile,
      recipes: recipeMerge.merged,
      tags: mergedTags,
      ingredients: ingredientMerge.merged,
      corrections: correctionMerge.merged,
      days: mergedDays,
      months: [...months]
    };
    await repository.applyMergedData(merged);
    if (vaultAdopted && vaultText !== undefined) {
      // Keep what we are about to overwrite. The two vaults can have different master
      // passwords, so adopting Drive's copy can leave this device unable to open its own
      // secrets — decision 150. The kept copy is local only; it is never uploaded.
      if (snapshot.vaultFile !== undefined) {
        await repository.setMeta('vaultFileReplaced', snapshot.vaultFile);
      }
      await repository.setMeta('vaultFile', vaultText);
    }
    if (account.label !== undefined) await repository.setMeta('driveAccountLabel', account.label);

    // ---- upload what moved ------------------------------------------------------------

    const writes: DriveFileRow[] = [];
    const upload = async (name: string, content: string, current: RemoteVersion | null): Promise<void> => {
      const version = await backend.write(name, content, current);
      writes.push({ name, fileId: version.fileId, modifiedTime: version.modifiedTime });
    };

    let pushed = false;

    if (profileMerge.remoteOutdated || hashValue(mergedProfile) !== hashValue(localProfile) || remoteProfile.version === null) {
      await upload(PROFILE_FILE, JSON.stringify(mergedProfile), remoteProfile.version);
      pushed = true;
    }
    if (recipeMerge.remoteOutdated || tagMerge.remoteOutdated || remoteRecipes.version === null) {
      const document = { recipes: [...recipeMerge.merged.values()], tags: [...mergedTags.values()] };
      await upload(RECIPES_FILE, JSON.stringify(document), remoteRecipes.version);
      pushed = true;
    }
    if (ingredientMerge.remoteOutdated || correctionMerge.remoteOutdated || remoteIngredients.version === null) {
      const document = {
        ingredients: [...ingredientMerge.merged.values()],
        corrections: [...correctionMerge.merged.values()]
      };
      await upload(INGREDIENTS_FILE, JSON.stringify(document), remoteIngredients.version);
      pushed = true;
    }
    if (vaultUpload && vaultText !== undefined) {
      await upload(VAULT_FILE, vaultText, remoteVault.version);
      pushed = true;
    }

    const removed = new Set<string>();

    for (const month of months) {
      const state = remoteDays.get(month) ?? { version: null, content: {} };
      const document: DaysDocument = {};
      for (const [date, day] of mergedDays) {
        if (monthOf(date) === month && day.meals.length > 0) document[date] = day;
      }

      // Whether the merge (after the user answered any conflict) differs from what Drive
      // holds. Computed from the content when we have it, so answering a conflict with
      // "keep the Drive version" uploads nothing at all.
      const changed =
        state.content === undefined
          ? dayMerges.get(month)?.remoteOutdated === true
          : hashValue(document) !== hashValue(readDaysDocument(state.content));


      if (Object.keys(document).length === 0) {
        // Every day in the month was cleared. Removing the file keeps the folder honest.
        if (state.version !== null && changed) {
          await backend.remove(daysFileName(month), state.version);
          removed.add(daysFileName(month));
          pushed = true;
        }
        continue;
      }
      if (!changed && state.version !== null) continue;
      await upload(daysFileName(month), JSON.stringify(document), state.version);
      pushed = true;
    }

    // ---- record the new baseline ------------------------------------------------------

    const nextBaseline = new Map<string, string>();
    nextBaseline.set(key.profile, hashValue(mergedProfile));
    for (const [id, hash] of baselineOf(recipeMerge.merged)) nextBaseline.set(key.recipe(id), hash);
    // The label, not the whole row: `useCount` is derived and would otherwise read as a change.
    for (const [tagKey, tag] of mergedTags) nextBaseline.set(key.tag(tagKey), hashValue(tag.label));
    for (const [id, hash] of baselineOf(ingredientMerge.merged)) nextBaseline.set(key.ingredient(id), hash);
    for (const [nameKey, hash] of baselineOf(correctionMerge.merged)) {
      nextBaseline.set(key.correction(nameKey), hash);
    }
    for (const [date, day] of mergedDays) {
      if (day.meals.length > 0) nextBaseline.set(key.day(date), hashValue(day));
    }
    if (vaultText !== undefined) nextBaseline.set(key.vault, hashValue(vaultText));

    await repository.setSyncBaseline(nextBaseline);

    // What Drive holds now, from this device's point of view: everything it listed, updated
    // with what we just wrote, minus what we deleted.
    const files = new Map<string, DriveFileRow>();
    for (const [name, version] of listed) files.set(name, { name, ...version });
    for (const row of writes) files.set(row.name, row);
    for (const name of removed) files.delete(name);
    await repository.setDriveFiles([...files.values()]);
    await repository.setMeta('lastSyncedAt', new Date().toISOString());

    const pulled =
      profileMerge.localOutdated ||
      recipeMerge.localOutdated ||
      tagMerge.localOutdated ||
      ingredientMerge.localOutdated ||
      correctionMerge.localOutdated ||
      vaultAdopted ||
      [...dayMerges.values()].some((merge) => merge.localOutdated);

    return { status: 'ok', pulled, pushed, vaultAdopted, freshFolder, account };
  }

  return {
    /**
     * One full sync. A write that lost a race is retried from the top — the whole point of
     * re-reading `modifiedTime` immediately before writing is that we would rather redo the
     * merge than overwrite what the other device just saved.
     */
    async sync(options: SyncOptions = {}): Promise<SyncOutcome> {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          return await runOnce(options);
        } catch (error) {
          if (error instanceof RemoteChangedError && attempt < MAX_ATTEMPTS) continue;
          if (error instanceof NotAuthenticatedError) {
            return { status: 'unauthenticated', message: error.message };
          }
          return {
            status: 'error',
            message: error instanceof Error ? error.message : 'Sync failed'
          };
        }
      }
      return { status: 'error', message: 'Drive kept changing while the merge was running' };
    }
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
