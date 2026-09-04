import { registerSW } from 'virtual:pwa-register';

/**
 * The two things a browser tells an installed app about itself: that a new version is waiting,
 * and that it may be installed.
 *
 * Both are deliberately explicit. The service worker is registered with `registerType: 'prompt'`,
 * so a new bundle never takes over a tab someone is typing in — it waits until they say so.
 * The install prompt is captured rather than shown, because a banner that appears the second a
 * first-time visitor lands is the thing everyone dismisses without reading.
 */

/**
 * `beforeinstallprompt` is Chromium-only and not in the DOM lib, so it is described here
 * rather than pulled in with a dependency.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const pwaState = $state<{
  /** A newer bundle is installed and waiting for the tab to hand over. */
  updateReady: boolean;
  /** Everything needed to run offline is in the cache. */
  offlineReady: boolean;
  /** The browser offered an install prompt and we are holding it. */
  installable: boolean;
  /** The app is running from a launcher rather than a browser tab. */
  installed: boolean;
  /**
   * The browser has this app installed, but we are looking at it in a tab. Best-effort:
   * `navigator.getInstalledRelatedApps()` exists on Chromium only, so `false` means „installed
   * elsewhere, or the browser would not say" and never „definitely not installed".
   */
  installedElsewhere: boolean;
  /**
   * The platform whose install route is a menu item we can describe rather than a prompt we
   * can fire. iOS Safari has no `beforeinstallprompt` and never will, and „Udostępnij → Do
   * ekranu początkowego" is a real instruction — unlike „look in your browser's menu", which
   * is what the section used to say to everyone else (STATE.md decision 189).
   */
  ios: boolean;
  /**
   * A Chromium browser on a phone: the other platform whose install route is a menu item.
   * Chrome on Android withholds `beforeinstallprompt` until a visit its engagement heuristic
   * counts as real (STATE.md decision 219), and until then this app had nothing to say to the
   * one platform where „⋮ → Dodaj do ekranu głównego" is a path that exists (decision 222).
   */
  androidMenu: boolean;
  /**
   * The browser gave us a registration, so „sprawdź aktualizacje" is a question that can be
   * asked. False in `npm run dev`, where the worker is deliberately not registered.
   */
  canCheckUpdates: boolean;
}>({
  updateReady: false,
  offlineReady: false,
  installable: false,
  installed: false,
  installedElsewhere: false,
  ios: false,
  androidMenu: false,
  canCheckUpdates: false
});

/** Resolved by `registerSW`; calling it activates the waiting worker and reloads. */
let update: ((reload?: boolean) => Promise<void>) | null = null;

/** The captured `beforeinstallprompt` event. A browser allows it to be used exactly once. */
let installEvent: BeforeInstallPromptEvent | null = null;

/** The service worker registration, once there is one. The only thing that can be asked. */
let registration: ServiceWorkerRegistration | null = null;

/** When the last check finished, so returning to the app does not re-ask on every glance. */
let lastCheck = 0;

/** How stale an answer may be before returning to the app asks again. A manual check ignores it. */
const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * What a check found. `unavailable` means there is no worker to ask, not that nothing is new;
 * `blocked` means the origin answered and what came back was not this app.
 */
export type UpdateCheck =
  | 'update-ready'
  | 'current'
  | 'offline'
  | 'blocked'
  | 'failed'
  | 'unavailable';

/**
 * A path the service worker deliberately does not answer — `navigateFallbackDenylist` in
 * `vite.config.ts` keeps it out of the navigation route, and the server resolves it to the app
 * like any other unknown path. Opening it is therefore a real navigation to the origin, which
 * is the only way a challenge in front of the origin can put its question to a human.
 */
export const NETWORK_CHECK_PATH = '/polaczenie';

/** True when the page is running as an installed app rather than in a browser tab. */
function isStandalone(): boolean {
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * iOS, told apart by the property Safari alone puts on `navigator` — the same signal
 * `isStandalone()` already reads, and the reason this needs no UA string. Every browser on iOS
 * is WebKit and inherits it, so this answers for Chrome and Firefox there too, which is
 * exactly right: they all install through the share sheet.
 */
function isIos(): boolean {
  return 'standalone' in navigator;
}

/**
 * A Chromium browser on a phone or tablet. `navigator.userAgentData` is Chromium-only and its
 * `mobile` hint is the browser's own answer to „am I on a phone", so this stays a capability
 * check rather than a UA string — the rule decision 189 set for iOS. Chrome and Samsung
 * Internet both answer, and both put installing behind the same menu.
 */
function isAndroidMenu(): boolean {
  return (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true;
}

/**
 * Ask the browser whether it already has this app installed. Chromium-only, and it answers
 * only for applications the manifest names in `related_applications` (STATE.md decision 208),
 * so an empty answer is „no information", never „not installed".
 */
async function findInstalledApp(): Promise<boolean> {
  const query = (
    navigator as { getInstalledRelatedApps?: () => Promise<unknown[]> }
  ).getInstalledRelatedApps;
  if (typeof query !== 'function') return false;
  try {
    return (await query.call(navigator)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Register the service worker and start listening for install events. Called once from
 * `main.ts`, before the app mounts — `beforeinstallprompt` fires early and is not replayed.
 */
export function startPwa(): void {
  pwaState.installed = isStandalone();
  pwaState.ios = isIos();
  pwaState.androidMenu = !pwaState.ios && isAndroidMenu();

  // Only interesting in a tab: inside the installed app the answer is already known.
  if (!pwaState.installed) {
    void findInstalledApp().then((found) => (pwaState.installedElsewhere = found));
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own bar; the app offers the prompt from Settings
    // instead, where there is room to say what installing actually does.
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    pwaState.installable = true;
  });

  window.addEventListener('appinstalled', () => {
    installEvent = null;
    pwaState.installable = false;
    pwaState.installedElsewhere = true;
  });

  update = registerSW({
    onNeedRefresh: () => (pwaState.updateReady = true),
    onOfflineReady: () => (pwaState.offlineReady = true),
    onRegisteredSW: (_url, found) => {
      if (found === undefined) return;
      registration = found;
      pwaState.canCheckUpdates = true;
    }
  });

  // The browser re-fetches the worker when a page is loaded — which an installed app, left
  // running for days, hardly ever is. Coming back to it is the moment that stands in for a
  // page load, so that is where the check goes (STATE.md decision 225).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < AUTO_CHECK_INTERVAL_MS) return;
    void checkForUpdate();
  });
}

/**
 * Ask the browser to re-fetch the worker and answer what it found.
 *
 * The answer is not in the promise: `update()` resolves when the *check* is done, and a worker
 * it found is still installing at that point. What settles it is what the registration is
 * holding afterwards — and only while a controller exists, because the very first worker of a
 * first visit is an installation, not an update.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const reg = registration;
  if (reg === null) return 'unavailable';

  try {
    await reg.update();
  } catch (error) {
    lastCheck = Date.now();
    // `update()` rejects for the fetch *and* for an installation that fails behind it. So the
    // registration is asked before the failure is believed: a worker that made it to `waiting`
    // is a found update, whatever the promise said (STATE.md decision 236).
    if (reg.waiting !== null && navigator.serviceWorker.controller !== null) return ready();
    // The one line that makes a report from a phone worth anything. It says what threw; the
    // screen still says only what the user can act on.
    console.warn('[eat-my-way] update check failed', error);
    return await diagnose(reg);
  }
  lastCheck = Date.now();

  if (navigator.serviceWorker.controller === null) return 'current';
  if (reg.waiting !== null) return ready();

  const installing = reg.installing;
  if (installing === null) return 'current';

  return await new Promise<UpdateCheck>((resolve) => {
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') resolve(ready());
      if (installing.state === 'redundant') resolve('current');
    });
  });
}

/**
 * Why the check failed, as far as the network will say.
 *
 * `update()` reports one rejection for situations the user has to answer differently, and
 * guessing between them was the whole trouble: „try again on a better connection" is advice
 * that can never work when the link is fine and something in front of the origin is refusing.
 * That refusal has a shape — the origin replies, and what it replies with is an HTML page
 * rather than the worker — and it is worth telling apart from a link that is simply not there
 * (STATE.md decision 238).
 *
 * The probe is the worker script itself: the exact request that just failed, two kilobytes, and
 * served from no cache, so the answer describes the network now rather than what was true when
 * the app was last reachable.
 */
async function diagnose(reg: ServiceWorkerRegistration): Promise<UpdateCheck> {
  if (!navigator.onLine) return 'offline';

  const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL;
  if (url === undefined) return 'failed';

  try {
    const response = await fetch(url, { cache: 'no-store' });
    const type = response.headers.get('content-type') ?? '';
    if (response.ok && /javascript|ecmascript/i.test(type)) return 'failed';
    console.warn(`[eat-my-way] worker fetch answered ${response.status} as "${type}"`);
    return 'blocked';
  } catch {
    // `navigator.onLine` said otherwise, but it only ever knew about the network interface.
    return 'offline';
  }
}

/** A waiting worker is exactly what the update bar means, so say it in both places at once. */
function ready(): UpdateCheck {
  pwaState.updateReady = true;
  return 'update-ready';
}

/** Hand the tab over to the waiting version. Reloads the page. */
export function applyUpdate(): void {
  pwaState.updateReady = false;
  void update?.(true);
}

/**
 * Show the browser's install prompt. Must be called from a user gesture, and the event it
 * uses is spent afterwards however the user answers.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = installEvent;
  if (event === null) return 'unavailable';

  installEvent = null;
  pwaState.installable = false;
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}
