import { isOffline } from '../net';
import { repository } from '../repository';
import type { AccountInfo } from './backend';
import { createDriveBackend } from './drive';
import { createSyncEngine, type DayConflict, type SyncOutcome, type SyncStage } from './engine';
import { isDriveConfigured } from './google-auth';
import { loadVault } from '../vault/session.svelte';

/**
 * App-wide sync state. One engine, one backend, one in-flight sync at a time.
 *
 * Everything here is best-effort by design: the app is fully usable with Drive disconnected,
 * offline, or signed out. Nothing on this module's failure paths writes to IndexedDB.
 */

export type SyncPhase = 'idle' | 'syncing' | 'error';

export type { SyncStage };

/** What each stage is called on screen. One sentence fragment, not a status line. */
export const STAGE_LABELS: Record<SyncStage, string> = {
  authenticating: 'Łączenie z kontem Google…',
  transferring: 'Odczyt i zapis plików na Dysku…'
};

export const syncState = $state<{
  /** Whether the build carries an OAuth client id at all. */
  configured: boolean;
  /** A Drive session is in hand. */
  connected: boolean;
  account: AccountInfo | null;
  phase: SyncPhase;
  /**
   * Which wait is running while `phase` is `syncing`; `null` otherwise. Drive reports no
   * totals, so this is the only honest progress the app has (STATE.md decision 194).
   */
  stage: SyncStage | null;
  /** ISO timestamp of the last successful sync, or `undefined`. */
  lastSyncedAt: string | undefined;
  /** Polish message for the user, or `''`. */
  message: string;
  /** Set while the conflict dialog is open; `null` otherwise. */
  conflicts: DayConflict[] | null;
  /** Set when the connected account is not the one the local data belongs to. */
  foreignAccount: { account: AccountInfo; storedSub: string } | null;
  /** Drive replaced the local vault on the last sync; the user should know. */
  vaultAdopted: boolean;
  /**
   * Drive is connected and its folder was empty — PLAN.md's condition for showing the
   * first-run wizard. Cleared once the user has been there.
   */
  setupNeeded: boolean;
}>({
  configured: isDriveConfigured(),
  connected: false,
  account: null,
  phase: 'idle',
  stage: null,
  lastSyncedAt: undefined,
  message: '',
  conflicts: null,
  foreignAccount: null,
  vaultAdopted: false,
  setupNeeded: false
});

const backend = createDriveBackend();
const engine = createSyncEngine(backend, repository);

/** Resolves the promise the engine is waiting on while the conflict dialog is open. */
let answerConflicts: ((answers: ReadonlyMap<string, 'local' | 'remote'> | null) => void) | null = null;

/** One sync at a time: a second request joins the first rather than racing it. */
let running: Promise<SyncOutcome> | null = null;

/**
 * Whether this device may talk to Google without the user asking. False until they have
 * connected Drive at least once, which is what keeps the promise in `google-auth.ts`: a user
 * who never connects makes no request to Google, from any code path — not the resume on load,
 * not the visibility handler, not the periodic timer.
 */
let silentAllowed = false;

/**
 * Set once a silent renewal has failed, so the next one is deferred to a user gesture.
 *
 * GIS has no truly silent path it can guarantee: when the stored token has expired it may fall
 * back to a window, and a window opened by a script that runs on page load is blocked by every
 * browser. That is why a start-up renewal could fail while the Google grant was perfectly
 * intact. So the retry rides on the first tap or key press, which carries the user activation
 * GIS needs — one attempt per failure, and never with `prompt: 'consent'`, so nothing pops up
 * in the user's face uninvited. See STATE.md decision 173.
 */
let renewalArmed = false;

function renewOnNextGesture(): void {
  if (renewalArmed || !silentAllowed) return;
  renewalArmed = true;

  const attempt = (): void => {
    window.removeEventListener('pointerdown', attempt);
    window.removeEventListener('keydown', attempt);
    void syncNow();
  };

  window.addEventListener('pointerdown', attempt);
  window.addEventListener('keydown', attempt);
}

function describe(outcome: SyncOutcome, interactive: boolean): string {
  // Offline is not a failure of the app or of the account, and the app recovers from it on
  // its own — `startAutoSync` listens for `online`. Saying "sync failed" here would send the
  // user looking for a problem that will fix itself.
  if (outcome.status !== 'ok' && isOffline()) {
    return 'Jesteś offline. Kalendarz i przepisy działają normalnie; synchronizacja ruszy sama, gdy wróci połączenie.';
  }

  switch (outcome.status) {
    case 'ok':
      return '';
    case 'unauthenticated':
      // After an explicit click, "the connection expired" would be nonsense — the user is
      // looking at a sign-in that did not finish, not at a session that lapsed.
      return interactive
        ? 'Nie udało się połączyć z Dyskiem Google.'
        : 'Połączenie z Dyskiem Google wygasło. Połącz konto ponownie — dane na tym urządzeniu są nietknięte.';
    case 'foreign-account':
      return 'To konto Google jest inne niż to, z którego pochodzą dane na tym urządzeniu.';
    case 'cancelled':
      return 'Synchronizacja przerwana. Nic nie zostało zmienione.';
    case 'error':
      return 'Synchronizacja się nie powiodła. Dane na tym urządzeniu są nietknięte.';
  }
}

export async function syncNow(options: { interactive?: boolean; acceptAccount?: boolean } = {}): Promise<SyncOutcome> {
  if (running !== null) return running;
  if (!syncState.configured) {
    return { status: 'error', message: 'no client id' };
  }
  if (options.interactive !== true && !silentAllowed) {
    return { status: 'unauthenticated', message: 'Drive has never been connected on this device' };
  }
  // A background sync with no network cannot succeed and has nothing to tell the user. It is
  // skipped rather than attempted, so the indicator does not go red on a train; `online`
  // brings the next attempt along by itself.
  if (options.interactive !== true && isOffline()) {
    return { status: 'error', message: 'offline' };
  }

  syncState.phase = 'syncing';
  syncState.stage = 'authenticating';
  syncState.message = '';

  running = engine.sync({
    ...options,
    onstage: (stage) => (syncState.stage = stage),
    resolveConflicts: (conflicts) =>
      new Promise((resolve) => {
        syncState.conflicts = conflicts;
        answerConflicts = (answers) => {
          syncState.conflicts = null;
          answerConflicts = null;
          resolve(answers);
        };
      })
  });

  try {
    const outcome = await running;
    syncState.message = describe(outcome, options.interactive === true);

    if (outcome.status === 'ok') {
      silentAllowed = true;
      renewalArmed = false;
      syncState.connected = true;
      syncState.account = outcome.account;
      syncState.phase = 'idle';
      syncState.vaultAdopted = outcome.vaultAdopted;
      syncState.foreignAccount = null;
      syncState.lastSyncedAt = await repository.getMeta('lastSyncedAt');
      // PLAN.md: the wizard is for "Drive connected and appDataFolder has no data".
      if (outcome.freshFolder && (await repository.getMeta('vaultFile')) === undefined) {
        syncState.setupNeeded = true;
      }
      // A vault that arrived from Drive has to be re-read before anything asks for a secret.
      if (outcome.pulled) await loadVault();
    } else if (outcome.status === 'foreign-account') {
      syncState.foreignAccount = { account: outcome.account, storedSub: outcome.storedSub };
      syncState.phase = 'idle';
    } else if (outcome.status === 'cancelled') {
      syncState.phase = 'idle';
    } else {
      if (outcome.status === 'unauthenticated') {
        syncState.connected = false;
        // A background renewal that failed for want of a user gesture gets one, on the next
        // tap. An interactive attempt already had one, so there is nothing to defer.
        if (options.interactive !== true) renewOnNextGesture();
      }
      syncState.phase = 'error';
    }

    return outcome;
  } finally {
    running = null;
    syncState.stage = null;
    if (answerConflicts !== null) answerConflicts(null);
  }
}

/** Answer the conflict dialog. `null` aborts the sync and writes nothing. */
export function resolveConflicts(answers: ReadonlyMap<string, 'local' | 'remote'> | null): void {
  answerConflicts?.(answers);
}

/** Connect Drive from a click — this is the one path allowed to open the consent popup. */
export async function connectDrive(): Promise<SyncOutcome> {
  return syncNow({ interactive: true });
}

/** Continue on an account that is not the stored one, after the user said so explicitly. */
export async function useDifferentAccount(): Promise<SyncOutcome> {
  syncState.foreignAccount = null;
  return syncNow({ interactive: false, acceptAccount: true });
}

/**
 * Disconnect. The Google grant is revoked and the vault key is dropped, but not one row of
 * local data is touched — the calendar and the recipe library keep working exactly as before.
 */
export function disconnectDrive(): void {
  backend.signOut();
  silentAllowed = false;
  renewalArmed = false;
  syncState.connected = false;
  syncState.account = null;
  syncState.message = '';
  syncState.foreignAccount = null;
}

/** Whether the app's Drive folder is still empty — the first-run wizard's step 2. */
export async function isRemoteEmpty(): Promise<boolean> {
  return engine.isRemoteEmpty();
}

/**
 * Called once on start-up. It does nothing at all until the user has connected Drive at least
 * once — `Profile.googleSub` is the record of that — so a user who never connects makes no
 * request to Google, ever, and the app stays entirely local. When they have connected, a
 * silent token is tried: if their Google session is alive the app syncs, and if not it stays
 * quiet, because "not signed in right now" is not an error worth a message.
 */
export async function resumeSync(): Promise<void> {
  if (!syncState.configured) return;
  if ((await repository.getProfile()).googleSub === undefined) return;

  silentAllowed = true;
  const outcome = await syncNow({ interactive: false });
  if (outcome.status === 'unauthenticated') {
    // Never connected, or the session lapsed. Both are ordinary; the user connects when ready.
    syncState.phase = 'idle';
    syncState.message = '';
  }
}

/** Quiet period after an edit before a push. Long enough that typing does not cause traffic. */
const DEBOUNCE_MS = 4000;
/** Backstop for a tab left open all day. */
const INTERVAL_MS = 5 * 60 * 1000;

let debounce: ReturnType<typeof setTimeout> | undefined;

/**
 * Ask for a sync soon. Called after any local edit; repeated calls collapse into one, and a
 * sync that would open a popup or show an error never happens on this path — it is background
 * work and must stay invisible until it succeeds.
 */
export function scheduleSync(): void {
  if (!syncState.configured || !syncState.connected) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void syncNow(), DEBOUNCE_MS);
}

/**
 * Sync when the tab comes back to the foreground, when the network returns, and every few
 * minutes for a tab that is simply left open. There is no push channel from Drive, so these
 * three moments are the only cheap approximations of "something may have changed elsewhere".
 */
export function startAutoSync(): () => void {
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void syncNow();
  };
  const onOnline = (): void => void syncNow();
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow();
  }, INTERVAL_MS);

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}
