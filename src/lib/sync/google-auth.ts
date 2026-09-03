import { NotAuthenticatedError } from './backend';

/**
 * Google Identity Services, token flow.
 *
 * The app is a static bundle with no backend, so there is no place to keep a client secret
 * and no authorization-code exchange: GIS hands the page a short-lived access token directly.
 * That has one consequence worth stating plainly — **there is no refresh token in the
 * browser**, so "revoked or expired refresh token" (PLAN.md) is here simply "the next silent
 * token request fails", and the answer is the same: ask again, interactively, touching
 * nothing in IndexedDB. See STATE.md decision 90.
 *
 * The token itself never reaches IndexedDB or Drive. It is kept in memory and mirrored into
 * `sessionStorage`, which is what makes a page reload keep the session: GIS will not reliably
 * hand a token back to a script running at page load — its token flow can fall back to a
 * window, and a window opened without a user gesture is blocked — so a reload that had to ask
 * Google again ended up signed out. The mirror is deliberately `sessionStorage` and not
 * `localStorage`: closing the tab still ends the session, exactly as before. See STATE.md
 * decision 173.
 */

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/** Renew this many seconds before the token actually expires. */
const EXPIRY_MARGIN_SECONDS = 60;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void;
}

interface GoogleIdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        prompt?: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

/** True when the build carries an OAuth client id at all. */
export function isDriveConfigured(): boolean {
  return GOOGLE_CLIENT_ID.trim().length > 0;
}

let scriptPromise: Promise<GoogleIdentityServices> | null = null;

/**
 * Load `gsi/client` on demand rather than from `index.html`: a user who never connects Drive
 * makes no request to Google at all, and the app keeps working offline until they do.
 */
function loadGis(): Promise<GoogleIdentityServices> {
  scriptPromise ??= new Promise<GoogleIdentityServices>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve(window.google);
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve(window.google);
      else reject(new Error('Google Identity Services loaded without an OAuth client'));
    };
    script.onerror = () => {
      // Let a later attempt retry from scratch — this one may simply have been offline.
      scriptPromise = null;
      reject(new Error('Google Identity Services could not be loaded'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

interface Token {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Where the live token is mirrored so a reload finds it: per tab, gone when the tab closes. */
const TOKEN_KEY = 'emw.driveToken';
/**
 * The account the standing grant belongs to. Kept in `localStorage` because it has to outlive
 * the tab to be useful: it is passed to GIS as `hint` so a silent renewal on a browser with
 * several Google accounts signed in renews *this* one instead of failing on the ambiguity.
 * It is an e-mail address the app already stores in IndexedDB (`driveAccountLabel`), never a
 * credential.
 */
const HINT_KEY = 'emw.driveAccount';

/** Web storage throws outright in a browser with site data blocked; treat that as "no store". */
function store(kind: 'session' | 'local'): Storage | undefined {
  try {
    const value = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    return (value as Storage | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

function persist(next: Token | null): void {
  const session = store('session');
  if (session === undefined) return;
  try {
    if (next === null) session.removeItem(TOKEN_KEY);
    else session.setItem(TOKEN_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store costs this session its survival across a reload, nothing more.
  }
}

function restore(): Token | null {
  try {
    const raw = store('session')?.getItem(TOKEN_KEY);
    if (raw === undefined || raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { value, expiresAt } = parsed as { value?: unknown; expiresAt?: unknown };
    if (typeof value !== 'string' || typeof expiresAt !== 'number') return null;
    return { value, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Remember which account the grant is for. Called by the Drive backend once `about.get` has
 * said who is connected; cleared when the grant is revoked.
 */
export function rememberAccountHint(label: string | undefined): void {
  const local = store('local');
  if (local === undefined) return;
  try {
    if (label === undefined) local.removeItem(HINT_KEY);
    else local.setItem(HINT_KEY, label);
  } catch {
    // Same as above: a lost hint only costs a silent renewal, never correctness.
  }
}

function accountHint(): string | undefined {
  try {
    return store('local')?.getItem(HINT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

let token: Token | null = restore();
let client: TokenClient | null = null;
/** Set while a request is in flight, so two callers share one popup. */
let pending: Promise<string> | null = null;
/** Whether that request may open a window. A silent one cannot; see `getAccessToken`. */
let pendingInteractive = false;
/** Resolvers for the in-flight request; GIS answers through a single client callback. */
let settle: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null;

function valid(now: number): boolean {
  return token !== null && token.expiresAt > now;
}

/** Whether a token is in hand right now. Never triggers a request. */
export function hasAccessToken(): boolean {
  return valid(Date.now());
}

export function forgetAccessToken(): void {
  token = null;
  persist(null);
}

/** Drop the token and tell Google the grant is finished. */
export async function revokeAccess(): Promise<void> {
  const current = token?.value;
  token = null;
  persist(null);
  rememberAccountHint(undefined);
  if (current === undefined) return;
  const gis = await loadGis().catch(() => null);
  gis?.accounts.oauth2.revoke(current);
}

async function ensureClient(): Promise<TokenClient> {
  if (client !== null) return client;
  if (!isDriveConfigured()) {
    throw new NotAuthenticatedError('This build has no Google OAuth client id');
  }

  const gis = await loadGis();
  client = gis.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_APPDATA_SCOPE,
    callback: (response) => {
      const done = settle;
      settle = null;
      if (done === null) return;
      if (typeof response.access_token !== 'string' || response.error !== undefined) {
        done.reject(new NotAuthenticatedError(response.error_description ?? response.error ?? 'No token'));
        return;
      }
      const lifetime = (response.expires_in ?? 3600) - EXPIRY_MARGIN_SECONDS;
      token = { value: response.access_token, expiresAt: Date.now() + Math.max(lifetime, 0) * 1000 };
      persist(token);
      done.resolve(response.access_token);
    },
    error_callback: (error) => {
      const done = settle;
      settle = null;
      done?.reject(new NotAuthenticatedError(error.message ?? 'The Google sign-in was dismissed'));
    }
  });
  return client;
}

/**
 * A usable access token.
 *
 * `interactive: false` asks GIS for a silent grant (`prompt: ''`): it succeeds when the user
 * is signed in to Google and has already consented, and fails without ever showing a window.
 * That is what runs on page load, and what the stored token usually spares us entirely.
 * `interactive: true` opens the consent popup and is only ever reached from a click.
 *
 * The remembered account is passed as `hint` on the silent path only. It removes the one
 * ambiguity a silent renewal cannot resolve for itself — which of several signed-in Google
 * accounts to renew — while leaving the interactive popup free to offer all of them, which is
 * how a user switches account.
 */
export function getAccessToken(options: { interactive?: boolean } = {}): Promise<string> {
  const now = Date.now();
  const interactive = options.interactive === true;
  if (valid(now) && token !== null) return Promise.resolve(token.value);

  if (pending !== null) {
    // Whoever is waiting can use the token this request comes back with. Its *failure* is
    // another matter: a silent request has no user activation, so it cannot open the window
    // GIS falls back to — and inheriting that failure made a click report a sign-in that was
    // never attempted (STATE.md decision 230). A click waits, then asks for itself.
    if (!interactive || pendingInteractive) return pending;
    return pending.then(
      (value) => value,
      () => getAccessToken(options)
    );
  }

  pendingInteractive = interactive;
  pending = (async () => {
    const tokenClient = await ensureClient();
    const hint = interactive ? undefined : accountHint();
    return new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
      // '' lets Google skip the dialog when it already has an answer; 'consent' forces it.
      tokenClient.requestAccessToken({
        prompt: interactive ? 'consent' : '',
        ...(hint === undefined ? {} : { hint })
      });
    });
  })();

  return pending.finally(() => {
    pending = null;
    pendingInteractive = false;
  });
}
