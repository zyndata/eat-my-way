import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * Google, faked at the network boundary.
 *
 * Nothing in `src/` is stubbed or given a test-only seam: the app under test runs its real
 * `google-auth.ts`, its real `drive.ts` and its real sync engine, and talks to them over real
 * `fetch` calls. Only the two things the test cannot own are replaced — the Google Identity
 * Services script and the Drive REST API.
 *
 * The GIS stub is served from `https://accounts.google.com/gsi/client`, the same URL the real
 * one comes from, so the production CSP (`script-src ... https://accounts.google.com`) accepts
 * it unchanged. That is the point: the e2e run exercises the shipped policy, not a relaxed one.
 */

const GIS_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** What the browser-side GIS stub reads. Tests mutate it through `setGoogleSession`. */
export interface GoogleSession {
  /** Whether the user is signed in to Google in this browser at all. */
  signedIn: boolean;
  /** Whether this app already holds a grant — what makes a silent renewal possible. */
  consented: boolean;
  /** Make the consent popup come back empty, as if the user closed it. */
  dismissPopup: boolean;
  /** The access token the next successful request hands out. */
  token: string;
  /** Seconds, as GIS reports it. */
  expiresIn: number;
}

export const DEFAULT_SESSION: GoogleSession = {
  signedIn: true,
  consented: false,
  dismissPopup: false,
  token: 'e2e-token-1',
  expiresIn: 3600
};

interface StoredFile {
  id: string;
  name: string;
  content: string;
  modifiedTime: string;
}

export interface DriveRequest {
  method: string;
  /** Path plus query, with the origin stripped — readable in an assertion. */
  url: string;
}

/**
 * An in-memory `appDataFolder` behind the real Drive REST surface.
 *
 * Deliberately as permissive as Drive itself: it does **not** reject a stale write. Drive has
 * no conditional update, which is exactly why `drive.ts` re-reads `modifiedTime` immediately
 * before every upload. Enforcing it here would hide whether that guard actually runs.
 */
export class FakeDrive {
  private readonly files = new Map<string, StoredFile>();
  private seq = 0;
  /** Every request that reached "Google", for tests that assert on traffic. */
  readonly requests: DriveRequest[] = [];
  /** Tokens the API still accepts. Drop one to simulate a revoked or expired grant. */
  readonly validTokens = new Set<string>([DEFAULT_SESSION.token]);
  /**
   * How many times the page fetched the Google Identity Services script. Zero is the promise
   * `google-auth.ts` makes to a user who has never connected Drive.
   */
  identityLoads = 0;

  account = { permissionId: 'sub-1', emailAddress: 'test@example.com', displayName: 'Test' };
  /**
   * When true every request fails the way a dropped connection does. Playwright's own
   * `setOffline` cannot be used here: these requests are answered by a route handler and
   * never reach the network, so they would succeed regardless.
   */
  offline = false;

  private stamp(): string {
    this.seq += 1;
    // RFC 3339, distinct and ordered — the client compares these for equality only.
    return new Date(Date.UTC(2026, 8, 1, 0, 0, this.seq)).toISOString().replace('Z', '.000Z');
  }

  /** Seed or overwrite a file the way another device would have left it. */
  put(name: string, content: string): void {
    const existing = this.files.get(name);
    const id = existing?.id ?? `file-${this.files.size + 1}`;
    this.files.set(name, { id, name, content, modifiedTime: this.stamp() });
  }

  get(name: string): string | undefined {
    return this.files.get(name)?.content;
  }

  /** The folder as JSON, for asserting on what actually landed on Drive. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.files.values()].map((file) => [file.name, JSON.parse(file.content) as unknown])
    );
  }

  names(): string[] {
    return [...this.files.keys()].sort();
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  /** Pull the rug: every later call with this token gets Drive's 401 envelope. */
  revokeToken(token: string): void {
    this.validTokens.delete(token);
  }

  private byId(id: string): StoredFile | undefined {
    for (const file of this.files.values()) if (file.id === id) return file;
    return undefined;
  }

  private static parseMultipart(body: string): { metadata: { name?: string }; content: string } {
    const boundary = body.slice(2, body.indexOf('\r\n'));
    const parts = body
      .split(`--${boundary}`)
      .map((part) => part.replace(/^\r\n/, ''))
      .filter((part) => part.length > 0 && part !== '--\r\n' && part !== '--');
    const bodies = parts.map((part) => {
      const blank = part.indexOf('\r\n\r\n');
      return part.slice(blank + 4).replace(/\r\n$/, '');
    });
    const [metadata = '{}', content = ''] = bodies;
    return { metadata: JSON.parse(metadata) as { name?: string }, content };
  }

  /** `name = 'days/2026-09.json' and trashed = false` → the name. */
  private static nameFromQuery(q: string | null): string | null {
    const match = q?.match(/name = '((?:[^'\\]|\\.)*)'/);
    if (match?.[1] === undefined) return null;
    return match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  /** Install this fake as the handler for every googleapis.com request the page makes. */
  async install(context: BrowserContext): Promise<void> {
    await context.route('https://www.googleapis.com/**', (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    this.requests.push({ method: request.method(), url: url.pathname + url.search });

    if (this.offline) {
      await route.abort('internetdisconnected');
      return;
    }

    const authorization = (await request.headerValue('authorization')) ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!this.validTokens.has(token)) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] }
        })
      });
      return;
    }

    const json = (body: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    const path = url.pathname;

    if (path === '/drive/v3/about') {
      await json({ user: this.account });
      return;
    }

    if (path === '/drive/v3/files') {
      const wanted = FakeDrive.nameFromQuery(url.searchParams.get('q'));
      const files = [...this.files.values()]
        .filter((file) => wanted === null || file.name === wanted)
        .map((file) => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime }));
      await json({ files });
      return;
    }

    const fileId = path.startsWith('/drive/v3/files/') ? path.slice('/drive/v3/files/'.length) : null;
    if (fileId !== null) {
      const file = this.byId(fileId);
      if (file === undefined) {
        await json({ error: { message: 'File not found' } }, 404);
        return;
      }
      if (request.method() === 'DELETE') {
        this.files.delete(file.name);
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: file.content });
        return;
      }
      await json({ id: file.id, name: file.name, modifiedTime: file.modifiedTime });
      return;
    }

    if (path.startsWith('/upload/drive/v3/files')) {
      const uploadId = path.slice('/upload/drive/v3/files'.length).replace(/^\//, '');
      const { metadata, content } = FakeDrive.parseMultipart(request.postData() ?? '');
      const target = uploadId === '' ? undefined : this.byId(uploadId);
      const name = target?.name ?? metadata.name;
      if (name === undefined) {
        await json({ error: { message: 'No name' } }, 400);
        return;
      }
      this.put(name, content);
      const written = this.files.get(name);
      await json({ id: written?.id, name, modifiedTime: written?.modifiedTime });
      return;
    }

    await json({ error: { message: `Unhandled ${request.method()} ${path}` } }, 500);
  }
}

/**
 * The GIS stub. It runs in the page, so it is written as a string; `__emwGoogle` is the dial
 * the test turns, and `__emwGoogle.prompts` records what the app asked for — an empty prompt
 * is the silent renewal, `consent` is the popup.
 */
const GIS_STUB = `
(function () {
  var state = window.__emwGoogle;
  function issue(config) {
    state.prompts.push(state.pending);
    config.callback({
      access_token: state.token,
      expires_in: state.expiresIn,
      scope: ${JSON.stringify(DRIVE_APPDATA_SCOPE)}
    });
  }
  function deny(config, type, message) {
    state.prompts.push(state.pending);
    if (config.error_callback) config.error_callback({ type: type, message: message });
    else config.callback({ error: type, error_description: message });
  }
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: function (config) {
          state.clients.push({ client_id: config.client_id, scope: config.scope });
          return {
            requestAccessToken: function (overrides) {
              var prompt = (overrides && overrides.prompt) || '';
              state.pending = prompt;
              // The real client answers out of band; so does this one, or the app would see
              // a token before its own promise exists.
              setTimeout(function () {
                if (prompt === 'consent') {
                  if (state.dismissPopup) return deny(config, 'popup_closed', 'Popup closed');
                  if (!state.signedIn) return deny(config, 'popup_closed', 'Not signed in');
                  state.consented = true;
                  state.persist();
                  return issue(config);
                }
                // A silent request never opens a window: without a live session and a
                // standing grant it simply fails.
                if (!state.signedIn || !state.consented) {
                  return deny(config, 'suppressed_by_user', 'No silent grant');
                }
                issue(config);
              }, 0);
            }
          };
        },
        revoke: function (token, done) {
          state.revoked.push(token);
          state.consented = false;
          state.persist();
          if (done) done();
        }
      }
    }
  };
})();
`;

export interface FakeGoogleOptions {
  session?: Partial<GoogleSession>;
}

/**
 * Put the fake Google in front of a browser context: the GIS script, the Drive API, and the
 * page-side dial both of them read. Two contexts sharing one `FakeDrive` are two devices
 * signed in to one account.
 */
export async function installFakeGoogle(
  context: BrowserContext,
  drive: FakeDrive,
  options: FakeGoogleOptions = {}
): Promise<void> {
  const session = { ...DEFAULT_SESSION, ...options.session };

  await context.addInitScript(
    ([initial]) => {
      const KEY = '__emwGoogleSession';
      // A Google grant outlives a page load, so this has to as well: without it every reload
      // would look like a browser that has never consented, and the silent-renewal path —
      // the one that runs on every real start-up — could not be tested at all.
      const stored: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
      const session = { ...initial, ...(typeof stored === 'object' && stored !== null ? stored : {}) };

      const state = {
        ...session,
        /** Reset per page load: these record what *this* load asked Google for. */
        prompts: [] as string[],
        clients: [] as { client_id: string; scope: string }[],
        revoked: [] as string[],
        pending: '',
        persist(): void {
          const { signedIn, consented, dismissPopup, token, expiresIn } = state;
          window.localStorage.setItem(
            KEY,
            JSON.stringify({ signedIn, consented, dismissPopup, token, expiresIn })
          );
        }
      };
      Object.defineProperty(window, '__emwGoogle', { value: state, writable: true, configurable: true });

      // Collected rather than thrown: a violation must fail the test that caused it, and
      // `securitypolicyviolation` has no other way of reaching the test process.
      const violations: string[] = [];
      Object.defineProperty(window, '__emwCsp', { value: violations, configurable: true });
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    },
    [session] as const
  );

  await context.route(GIS_URL, (route) => {
    drive.identityLoads += 1;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB });
  });

  await drive.install(context);
}

/** Change the Google session mid-test — sign the user out, revoke the grant, close the popup. */
export async function setGoogleSession(page: Page, patch: Partial<GoogleSession>): Promise<void> {
  await page.evaluate((update) => {
    const state = (window as unknown as { __emwGoogle: GoogleSession & { persist(): void } }).__emwGoogle;
    Object.assign(state, update);
    // Persisted so the change survives the reload the test is usually about to do.
    state.persist();
  }, patch);
}

/** The prompts GIS was asked for, in order. `''` is silent, `'consent'` is the popup. */
export async function googlePrompts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __emwGoogle: { prompts: string[] } }).__emwGoogle.prompts);
}

/** CSP violations the page reported. Meaningful when the run targets the Caddy container. */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __emwCsp?: string[] }).__emwCsp ?? []);
}
