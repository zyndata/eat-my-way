import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayConflict, SyncOptions, SyncOutcome } from './engine';

/**
 * The orchestration layer between a click and the sync engine.
 *
 * The engine, the Drive client and the repository are all stubbed here on purpose: what is
 * under test is the part no other suite touches — when a sync is *allowed* to happen at all,
 * which Polish sentence each outcome produces, how the conflict prompt is handed to the UI and
 * back, and the three background triggers. The engine's own behaviour is covered by
 * `engine.test.ts` against a fake Drive.
 *
 * The module keeps `silentAllowed`, the in-flight sync and the debounce timer in module scope,
 * so every test imports a fresh copy through `load()`.
 */

const h = vi.hoisted(() => ({
  configured: { value: true },
  engine: {
    sync: vi.fn<(options: SyncOptions) => Promise<SyncOutcome>>(),
    isRemoteEmpty: vi.fn<() => Promise<boolean>>()
  },
  backend: { signOut: vi.fn<() => void>() },
  meta: new Map<string, string>(),
  profile: { value: {} as { googleSub?: string } },
  loadVault: vi.fn<() => Promise<void>>()
}));

vi.mock('./engine', () => ({ createSyncEngine: () => h.engine }));
vi.mock('./drive', () => ({ createDriveBackend: () => h.backend }));
vi.mock('./google-auth', () => ({ isDriveConfigured: () => h.configured.value }));
vi.mock('../vault/session.svelte', () => ({ loadVault: h.loadVault }));
vi.mock('../repository', () => ({
  repository: {
    getMeta: (key: string): Promise<string | undefined> => Promise.resolve(h.meta.get(key)),
    getProfile: (): Promise<{ googleSub?: string }> => Promise.resolve(h.profile.value)
  }
}));

type OkOutcome = Extract<SyncOutcome, { status: 'ok' }>;

const ACCOUNT = { id: 'sub-1', label: 'ktos@example.com' };

function ok(overrides: Partial<OkOutcome> = {}): OkOutcome {
  return {
    status: 'ok',
    pulled: false,
    pushed: false,
    vaultAdopted: false,
    freshFolder: false,
    account: ACCOUNT,
    ...overrides
  };
}

interface Dom {
  /** Dispatch an event to whatever the module registered for it. */
  fire(target: 'document' | 'window', type: string): void;
  hide(): void;
  show(): void;
  /** How many handlers are still registered — a cleanup that leaks shows up here. */
  registered(): number;
}

function installDom(): Dom {
  const listeners = {
    document: new Map<string, Set<() => void>>(),
    window: new Map<string, Set<() => void>>()
  };
  let visibility = 'visible';

  const make = (which: 'document' | 'window'): Record<string, unknown> => ({
    addEventListener(type: string, fn: () => void): void {
      const set = listeners[which].get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners[which].set(type, set);
    },
    removeEventListener(type: string, fn: () => void): void {
      listeners[which].get(type)?.delete(fn);
    }
  });

  const documentStub = make('document');
  Object.defineProperty(documentStub, 'visibilityState', { get: () => visibility });

  Object.assign(globalThis, { document: documentStub, window: make('window') });

  return {
    fire(target, type): void {
      for (const fn of listeners[target].get(type) ?? []) fn();
    },
    hide(): void {
      visibility = 'hidden';
    },
    show(): void {
      visibility = 'visible';
    },
    registered(): number {
      let total = 0;
      for (const map of [listeners.document, listeners.window]) {
        for (const set of map.values()) total += set.size;
      }
      return total;
    }
  };
}

type StateModule = typeof import('./state.svelte');

async function load(): Promise<StateModule> {
  vi.resetModules();
  return import('./state.svelte');
}

/** Connect Drive for real, so the tests about background behaviour start from a live session. */
async function connected(): Promise<StateModule> {
  const state = await load();
  h.engine.sync.mockResolvedValue(ok());
  await state.connectDrive();
  h.engine.sync.mockClear();
  return state;
}

let dom: Dom;

beforeEach(() => {
  vi.useFakeTimers();
  dom = installDom();
  h.configured.value = true;
  h.meta.clear();
  h.profile.value = {};
  h.engine.sync.mockReset();
  h.engine.isRemoteEmpty.mockReset();
  h.backend.signOut.mockReset();
  h.loadVault.mockReset();
  h.loadVault.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

describe('when Drive may run at all', () => {
  it('does nothing but report an error when the build has no client id', async () => {
    h.configured.value = false;
    const state = await load();

    expect(state.syncState.configured).toBe(false);
    await expect(state.syncNow({ interactive: true })).resolves.toEqual({
      status: 'error',
      message: 'no client id'
    });
    expect(h.engine.sync).not.toHaveBeenCalled();
  });

  it('refuses a background sync before Drive has ever been connected', async () => {
    const state = await load();

    const outcome = await state.syncNow();
    expect(outcome.status).toBe('unauthenticated');
    // The promise in google-auth.ts: a user who never connects reaches Google from no path,
    // and that starts here — the engine is not even asked.
    expect(h.engine.sync).not.toHaveBeenCalled();
  });

  it('allows background syncs once an interactive connect has succeeded', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());

    await state.syncNow();
    expect(h.engine.sync).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight sync instead of starting a second one', async () => {
    const state = await connected();
    let release: (outcome: SyncOutcome) => void = () => undefined;
    h.engine.sync.mockReturnValue(new Promise<SyncOutcome>((resolve) => (release = resolve)));

    const first = state.syncNow();
    const second = state.syncNow();
    release(ok());

    expect(await first).toEqual(await second);
    expect(h.engine.sync).toHaveBeenCalledTimes(1);
  });
});

describe('connecting', () => {
  it('opens the consent popup only from the interactive path', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue(ok());

    await state.connectDrive();
    expect(h.engine.sync.mock.calls[0]?.[0]?.interactive).toBe(true);

    await state.syncNow();
    expect(h.engine.sync.mock.calls[1]?.[0]?.interactive).toBeUndefined();
  });

  it('records the account, the timestamp and a clear message on success', async () => {
    const state = await load();
    h.meta.set('lastSyncedAt', '2026-09-01T10:00:00.000Z');
    h.engine.sync.mockResolvedValue(ok({ pushed: true }));

    await state.connectDrive();

    expect(state.syncState.connected).toBe(true);
    expect(state.syncState.account).toEqual(ACCOUNT);
    expect(state.syncState.phase).toBe('idle');
    expect(state.syncState.message).toBe('');
    expect(state.syncState.lastSyncedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('re-reads the vault only when something was pulled from Drive', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue(ok({ pulled: false }));
    await state.connectDrive();
    expect(h.loadVault).not.toHaveBeenCalled();

    h.engine.sync.mockResolvedValue(ok({ pulled: true, vaultAdopted: true }));
    await state.syncNow();
    expect(h.loadVault).toHaveBeenCalledTimes(1);
    expect(state.syncState.vaultAdopted).toBe(true);
  });
});

describe('the first-run wizard', () => {
  it('is requested when Drive is empty and no vault exists yet', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue(ok({ freshFolder: true }));

    await state.connectDrive();
    expect(state.syncState.setupNeeded).toBe(true);
  });

  it('is not requested when the folder is empty but a vault is already set up', async () => {
    const state = await load();
    h.meta.set('vaultFile', '{"v":1}');
    h.engine.sync.mockResolvedValue(ok({ freshFolder: true }));

    await state.connectDrive();
    expect(state.syncState.setupNeeded).toBe(false);
  });

  it('is not requested when the folder already holds data', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue(ok({ freshFolder: false }));

    await state.connectDrive();
    expect(state.syncState.setupNeeded).toBe(false);
  });
});

describe('what the user is told', () => {
  it('distinguishes a sign-in that did not finish from a session that lapsed', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue({ status: 'unauthenticated', message: 'no token' });

    await state.connectDrive();
    expect(state.syncState.message).toBe('Nie udało się połączyć z Dyskiem Google.');

    await state.syncNow();
    expect(state.syncState.message).toContain('wygasło');
    // Every one of these paths has to promise that local data is untouched.
    expect(state.syncState.message).toContain('nietknięte');
    expect(state.syncState.connected).toBe(false);
    expect(state.syncState.phase).toBe('error');
  });

  it('reports a failed sync without suggesting anything was lost', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue({ status: 'error', message: 'network' });

    await state.syncNow();
    expect(state.syncState.message).toBe(
      'Synchronizacja się nie powiodła. Dane na tym urządzeniu są nietknięte.'
    );
    expect(state.syncState.phase).toBe('error');
  });

  it('names being offline instead of blaming the sync, and skips it in the background', async () => {
    const state = await connected();
    vi.stubGlobal('navigator', { onLine: false });
    try {
      h.engine.sync.mockResolvedValue({ status: 'error', message: 'network' });

      // An explicit click still tries, and gets a sentence that says what to expect.
      await state.syncNow({ interactive: true });
      expect(state.syncState.message).toContain('Jesteś offline');
      expect(state.syncState.message).toContain('sama, gdy wróci połączenie');

      // A background sync does not even reach the engine — there is nothing for it to do.
      h.engine.sync.mockClear();
      await state.syncNow();
      expect(h.engine.sync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an abandoned conflict prompt as harmless and stays idle', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue({ status: 'cancelled' });

    await state.syncNow();
    expect(state.syncState.message).toBe('Synchronizacja przerwana. Nic nie zostało zmienione.');
    expect(state.syncState.phase).toBe('idle');
  });

  it('clears the message on the next success', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue({ status: 'error', message: 'network' });
    await state.syncNow();
    expect(state.syncState.message).not.toBe('');

    h.engine.sync.mockResolvedValue(ok());
    await state.syncNow();
    expect(state.syncState.message).toBe('');
    expect(state.syncState.phase).toBe('idle');
  });
});

describe('a different Google account', () => {
  it('surfaces the mismatch and does not mark the session connected', async () => {
    const state = await load();
    const other = { id: 'sub-2', label: 'ktos.inny@example.com' };
    h.engine.sync.mockResolvedValue({ status: 'foreign-account', account: other, storedSub: 'sub-1' });

    await state.connectDrive();

    expect(state.syncState.foreignAccount).toEqual({ account: other, storedSub: 'sub-1' });
    expect(state.syncState.phase).toBe('idle');
    expect(state.syncState.message).toContain('inne');
  });

  it('carries the explicit acceptance through to the engine and clears the warning', async () => {
    const state = await connected();
    const other = { id: 'sub-2' };
    h.engine.sync.mockResolvedValue({ status: 'foreign-account', account: other, storedSub: 'sub-1' });
    await state.syncNow();
    h.engine.sync.mockResolvedValue(ok({ account: other }));

    await state.useDifferentAccount();

    expect(state.syncState.foreignAccount).toBeNull();
    expect(h.engine.sync.mock.calls.at(-1)?.[0]?.acceptAccount).toBe(true);
    expect(state.syncState.account).toEqual(other);
  });
});

describe('the conflict prompt', () => {
  const conflicts: DayConflict[] = [{ date: '2026-09-01', local: undefined, remote: undefined }];

  it('publishes the conflicts to the UI and hands the answer back to the engine', async () => {
    const state = await connected();
    let answered: ReadonlyMap<string, 'local' | 'remote'> | null | undefined;
    h.engine.sync.mockImplementation(async (options: SyncOptions) => {
      answered = await options.resolveConflicts?.(conflicts);
      return ok();
    });

    const running = state.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.syncState.conflicts).toEqual(conflicts);

    state.resolveConflicts(new Map([['2026-09-01', 'remote']]));
    await running;

    expect(answered?.get('2026-09-01')).toBe('remote');
    expect(state.syncState.conflicts).toBeNull();
  });

  it('passes a dismissal through as null', async () => {
    const state = await connected();
    let answered: ReadonlyMap<string, 'local' | 'remote'> | null | undefined;
    h.engine.sync.mockImplementation(async (options: SyncOptions) => {
      answered = await options.resolveConflicts?.(conflicts);
      return { status: 'cancelled' };
    });

    const running = state.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    state.resolveConflicts(null);
    await running;

    expect(answered).toBeNull();
    expect(state.syncState.conflicts).toBeNull();
  });

  it('closes a prompt left open by a sync that failed underneath it', async () => {
    const state = await connected();
    h.engine.sync.mockImplementation(async (options: SyncOptions) => {
      void options.resolveConflicts?.(conflicts);
      await Promise.resolve();
      return { status: 'error', message: 'network' };
    });

    await state.syncNow();
    // A dialog still on screen with no sync behind it can never be dismissed.
    expect(state.syncState.conflicts).toBeNull();
  });
});

describe('background triggers', () => {
  it('collapses a burst of edits into one sync, four seconds later', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());

    state.scheduleSync();
    state.scheduleSync();
    state.scheduleSync();

    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.engine.sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.engine.sync).toHaveBeenCalledTimes(1);
  });

  it('ignores an edit while Drive is disconnected', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue(ok());

    state.scheduleSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.engine.sync).not.toHaveBeenCalled();
  });

  it('syncs when the tab comes back, when the network returns, and every five minutes', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());
    const stop = state.startAutoSync();

    dom.fire('document', 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.sync).toHaveBeenCalledTimes(1);

    dom.fire('window', 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(h.engine.sync).toHaveBeenCalledTimes(3);

    stop();
  });

  it('stays quiet while the tab is hidden', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());
    const stop = state.startAutoSync();
    dom.hide();

    dom.fire('document', 'visibilitychange');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(h.engine.sync).not.toHaveBeenCalled();

    dom.show();
    stop();
  });

  it('removes every listener and the timer when it is torn down', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());

    const stop = state.startAutoSync();
    expect(dom.registered()).toBe(2);

    stop();
    expect(dom.registered()).toBe(0);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(h.engine.sync).not.toHaveBeenCalled();
  });
});

describe('resuming on start-up', () => {
  it('makes no request at all for a device that never connected Drive', async () => {
    const state = await load();

    await state.resumeSync();

    expect(h.engine.sync).not.toHaveBeenCalled();
    expect(state.syncState.phase).toBe('idle');
  });

  it('syncs silently for a device that has connected before', async () => {
    const state = await load();
    h.profile.value = { googleSub: 'sub-1' };
    h.engine.sync.mockResolvedValue(ok());

    await state.resumeSync();

    expect(h.engine.sync).toHaveBeenCalledTimes(1);
    expect(h.engine.sync.mock.calls[0]?.[0]?.interactive).toBe(false);
    expect(state.syncState.connected).toBe(true);
  });

  it('says nothing when the Google session has simply lapsed', async () => {
    const state = await load();
    h.profile.value = { googleSub: 'sub-1' };
    h.engine.sync.mockResolvedValue({ status: 'unauthenticated', message: 'no token' });

    await state.resumeSync();

    // Not signed in right now is ordinary, not an error worth a red banner on load.
    expect(state.syncState.phase).toBe('idle');
    expect(state.syncState.message).toBe('');
  });
});

describe('the renewal deferred to a user gesture', () => {
  it('retries once on the first tap after a start-up renewal failed', async () => {
    const state = await load();
    h.profile.value = { googleSub: 'sub-1' };
    h.engine.sync.mockResolvedValue({ status: 'unauthenticated', message: 'no token' });

    await state.resumeSync();
    expect(h.engine.sync).toHaveBeenCalledTimes(1);

    // GIS may need a user activation it cannot have on load; the first tap carries one.
    h.engine.sync.mockResolvedValue(ok());
    dom.fire('window', 'pointerdown');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.engine.sync).toHaveBeenCalledTimes(2);
    // Silent: this path renews a standing grant, it never asks for consent.
    expect(h.engine.sync.mock.calls[1]?.[0]?.interactive).not.toBe(true);
    expect(state.syncState.connected).toBe(true);
    // The listener is gone the moment it fires: a tap is a retry, not a sync trigger.
    expect(dom.registered()).toBe(0);
  });

  it('does not turn every tap into a request when the grant is really gone', async () => {
    const state = await load();
    h.profile.value = { googleSub: 'sub-1' };
    h.engine.sync.mockResolvedValue({ status: 'unauthenticated', message: 'no token' });

    await state.resumeSync();
    dom.fire('window', 'pointerdown');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.sync).toHaveBeenCalledTimes(2);

    // The second failure re-arms nothing; the user is now looking at „Połącz konto ponownie".
    dom.fire('window', 'keydown');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.sync).toHaveBeenCalledTimes(2);
    expect(dom.registered()).toBe(0);
    expect(state.syncState.message).toContain('wygasło');
  });

  it('defers nothing after a sign-in the user watched fail', async () => {
    const state = await load();
    h.engine.sync.mockResolvedValue({ status: 'unauthenticated', message: 'popup closed' });

    await state.connectDrive();

    // The click already carried an activation, so a silent retry would only repeat it.
    expect(dom.registered()).toBe(0);
    expect(state.syncState.message).toBe('Nie udało się połączyć z Dyskiem Google.');
  });

  it('arms nothing on a device that has never connected Drive', async () => {
    const state = await load();

    await state.syncNow();

    expect(dom.registered()).toBe(0);
  });
});

describe('disconnecting', () => {
  it('ends the Google session and forgets it without touching local data', async () => {
    const state = await connected();

    state.disconnectDrive();

    expect(h.backend.signOut).toHaveBeenCalledTimes(1);
    expect(state.syncState.connected).toBe(false);
    expect(state.syncState.account).toBeNull();
    expect(state.syncState.message).toBe('');
    expect(state.syncState.foreignAccount).toBeNull();
  });

  it('stops background syncs until the user connects again', async () => {
    const state = await connected();
    h.engine.sync.mockResolvedValue(ok());
    state.disconnectDrive();

    await state.syncNow();
    expect(h.engine.sync).not.toHaveBeenCalled();

    await state.connectDrive();
    expect(h.engine.sync).toHaveBeenCalledTimes(1);
  });
});

describe('isRemoteEmpty', () => {
  it('asks the engine', async () => {
    const state = await load();
    h.engine.isRemoteEmpty.mockResolvedValue(true);

    await expect(state.isRemoteEmpty()).resolves.toBe(true);
  });
});
