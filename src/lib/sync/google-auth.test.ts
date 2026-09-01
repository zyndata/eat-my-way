import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Google Identity Services never runs in a test, so what is asserted here is the contract
 * `google-auth.ts` keeps *around* it: a build without a client id talks to Google not at all,
 * a silent renewal never asks for a prompt, two callers share one popup, and every failure
 * path leaves the module able to try again. None of that is visible from the sync engine's
 * tests, and all of it is on the path between "user clicks connect" and "a token exists".
 *
 * The module holds its token, its client and its in-flight request in module scope, so each
 * test imports a fresh copy through `load()`.
 */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface InitConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
}

interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

/** The GIS surface the module uses, plus a record of everything it was asked to do. */
class FakeGis {
  readonly configs: InitConfig[] = [];
  /** The `prompt` override of every `requestAccessToken` call, in order. */
  readonly prompts: (string | undefined)[] = [];
  readonly revoked: string[] = [];

  readonly accounts = {
    oauth2: {
      initTokenClient: (config: InitConfig) => {
        this.configs.push(config);
        return {
          requestAccessToken: (overrides?: { prompt?: string }) => {
            this.prompts.push(overrides?.prompt);
          }
        };
      },
      revoke: (token: string, done?: () => void) => {
        this.revoked.push(token);
        done?.();
      }
    }
  };

  /** Answer the request GIS is currently sitting on. */
  respond(response: TokenResponse): void {
    const config = this.configs.at(-1);
    if (config === undefined) throw new Error('No token client was created');
    config.callback(response);
  }

  /** The popup-was-dismissed path, which arrives on a different callback entirely. */
  fail(message: string): void {
    const config = this.configs.at(-1);
    if (config === undefined) throw new Error('No token client was created');
    config.error_callback?.({ type: 'popup_closed', message });
  }
}

interface Harness {
  gis: FakeGis;
  /** Every `<script>` the module put in the document. */
  scripts: FakeScript[];
  /** Make the next script load fail instead of succeeding. */
  breakScript(): void;
}

function installDom(): Harness {
  const gis = new FakeGis();
  const scripts: FakeScript[] = [];
  let broken = false;

  const win: { google?: FakeGis } = {};
  const document = {
    createElement: (): FakeScript => ({ src: '', async: false, onload: null, onerror: null }),
    head: {
      append(script: FakeScript): void {
        scripts.push(script);
        // The real script tag resolves asynchronously; so does this one, or the module's
        // `scriptPromise` would settle before anything could observe it pending.
        queueMicrotask(() => {
          if (broken) {
            broken = false;
            script.onerror?.();
            return;
          }
          win.google = gis;
          script.onload?.();
        });
      }
    }
  };

  Object.assign(globalThis, { window: win, document });

  return {
    gis,
    scripts,
    breakScript(): void {
      broken = true;
    }
  };
}

type AuthModule = typeof import('./google-auth');

/**
 * `vi.resetModules()` rebuilds the whole graph, `backend.ts` included, so the error class the
 * fresh module throws is not the one a static import at the top of this file would name.
 * The rebuilt class is captured here and used for every `instanceof`.
 */
let NotAuthenticated: typeof import('./backend').NotAuthenticatedError;

async function load(clientId = 'test-client.apps.googleusercontent.com'): Promise<AuthModule> {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  vi.resetModules();
  NotAuthenticated = (await import('./backend')).NotAuthenticatedError;
  return import('./google-auth');
}

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  harness = installDom();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

describe('drive configuration', () => {
  it('reports an unconfigured build and reaches Google on no code path', async () => {
    const auth = await load('');

    expect(auth.isDriveConfigured()).toBe(false);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(NotAuthenticated);
    // The promise this module makes: no client id means no script tag, not a failed request.
    expect(harness.scripts).toHaveLength(0);
  });

  it('reports a configured build when a client id is present', async () => {
    const auth = await load();
    expect(auth.isDriveConfigured()).toBe(true);
  });
});

describe('requesting a token', () => {
  it('asks for a silent grant by default and an explicit consent when interactive', async () => {
    const auth = await load();

    const silent = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token-1', expires_in: 3600 });
    await expect(silent).resolves.toBe('token-1');
    expect(harness.gis.prompts).toEqual(['']);

    auth.forgetAccessToken();
    const interactive = auth.getAccessToken({ interactive: true });
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token-2', expires_in: 3600 });
    await expect(interactive).resolves.toBe('token-2');
    expect(harness.gis.prompts).toEqual(['', 'consent']);
  });

  it('passes the appdata scope and the client id, and never a broader scope', async () => {
    const auth = await load('my-client.apps.googleusercontent.com');

    const request = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await request;

    expect(harness.gis.configs).toHaveLength(1);
    expect(harness.gis.configs[0]?.client_id).toBe('my-client.apps.googleusercontent.com');
    expect(harness.gis.configs[0]?.scope).toBe(auth.DRIVE_APPDATA_SCOPE);
    expect(auth.DRIVE_APPDATA_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
  });

  it('reuses a live token without asking GIS again', async () => {
    const auth = await load();

    const first = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await first;

    await expect(auth.getAccessToken()).resolves.toBe('token');
    expect(auth.hasAccessToken()).toBe(true);
    expect(harness.gis.prompts).toHaveLength(1);
  });

  it('renews a minute before the token actually expires', async () => {
    const auth = await load();

    const first = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'old', expires_in: 3600 });
    await first;

    // 3600 - 60 of margin: still in hand at 3539s, gone at 3541s.
    vi.setSystemTime(Date.now() + 3_539_000);
    expect(auth.hasAccessToken()).toBe(true);
    await expect(auth.getAccessToken()).resolves.toBe('old');
    expect(harness.gis.prompts).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2_000);
    expect(auth.hasAccessToken()).toBe(false);
    const renewed = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'new', expires_in: 3600 });
    await expect(renewed).resolves.toBe('new');
    expect(harness.gis.prompts).toHaveLength(2);
  });

  it('treats a response without expires_in as one hour', async () => {
    const auth = await load();

    const first = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token' });
    await first;

    vi.setSystemTime(Date.now() + 3_539_000);
    expect(auth.hasAccessToken()).toBe(true);
    vi.setSystemTime(Date.now() + 2_000);
    expect(auth.hasAccessToken()).toBe(false);
  });

  it('shares one popup between two callers that ask at the same time', async () => {
    const auth = await load();

    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });

    await expect(first).resolves.toBe('token');
    await expect(second).resolves.toBe('token');
    // One request, one consent window — not two stacked on top of each other.
    expect(harness.gis.prompts).toHaveLength(1);
  });
});

describe('failures', () => {
  it('turns an error response into NotAuthenticatedError carrying Google’s description', async () => {
    const auth = await load();

    const request = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ error: 'access_denied', error_description: 'The user refused' });

    await expect(request).rejects.toBeInstanceOf(NotAuthenticated);
    await expect(request).rejects.toThrow('The user refused');
    expect(auth.hasAccessToken()).toBe(false);
  });

  it('treats a dismissed popup as a failed sign-in, not a crash', async () => {
    const auth = await load();

    const request = auth.getAccessToken({ interactive: true });
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.fail('Popup window closed');

    await expect(request).rejects.toBeInstanceOf(NotAuthenticated);
    expect(auth.hasAccessToken()).toBe(false);
  });

  it('lets a later attempt succeed after a rejected one', async () => {
    const auth = await load();

    const failed = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.fail('dismissed');
    await expect(failed).rejects.toBeInstanceOf(NotAuthenticated);

    // The in-flight promise has to be cleared, or every later sync joins a dead request.
    const retried = auth.getAccessToken({ interactive: true });
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await expect(retried).resolves.toBe('token');
  });

  it('retries the script load from scratch after a network failure', async () => {
    const auth = await load();
    harness.breakScript();

    await expect(auth.getAccessToken()).rejects.toThrow(/could not be loaded/);
    expect(harness.scripts).toHaveLength(1);

    const retried = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await expect(retried).resolves.toBe('token');
    expect(harness.scripts).toHaveLength(2);
  });

  it('loads the GIS script once, however many tokens are asked for', async () => {
    const auth = await load();

    const first = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'one', expires_in: 3600 });
    await first;

    auth.forgetAccessToken();
    const second = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'two', expires_in: 3600 });
    await second;

    expect(harness.scripts).toHaveLength(1);
    expect(harness.gis.configs).toHaveLength(1);
  });
});

describe('ending the session', () => {
  it('forgets the token without telling Google', async () => {
    const auth = await load();

    const request = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await request;

    auth.forgetAccessToken();
    expect(auth.hasAccessToken()).toBe(false);
    expect(harness.gis.revoked).toEqual([]);
  });

  it('revokes the grant and drops the token', async () => {
    const auth = await load();

    const request = auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    harness.gis.respond({ access_token: 'token', expires_in: 3600 });
    await request;

    await auth.revokeAccess();
    expect(harness.gis.revoked).toEqual(['token']);
    expect(auth.hasAccessToken()).toBe(false);
  });

  it('does not load GIS to revoke a session that never existed', async () => {
    const auth = await load();

    await auth.revokeAccess();
    expect(harness.scripts).toHaveLength(0);
    expect(harness.gis.revoked).toEqual([]);
  });
});
