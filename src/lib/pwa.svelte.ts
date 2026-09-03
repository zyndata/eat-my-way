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
}>({
  updateReady: false,
  offlineReady: false,
  installable: false,
  installed: false,
  installedElsewhere: false,
  ios: false,
  androidMenu: false
});

/** Resolved by `registerSW`; calling it activates the waiting worker and reloads. */
let update: ((reload?: boolean) => Promise<void>) | null = null;

/** The captured `beforeinstallprompt` event. A browser allows it to be used exactly once. */
let installEvent: BeforeInstallPromptEvent | null = null;

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
    onOfflineReady: () => (pwaState.offlineReady = true)
  });
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
