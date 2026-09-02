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
}>({
  updateReady: false,
  offlineReady: false,
  installable: false,
  installed: false
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
 * Register the service worker and start listening for install events. Called once from
 * `main.ts`, before the app mounts — `beforeinstallprompt` fires early and is not replayed.
 */
export function startPwa(): void {
  pwaState.installed = isStandalone();

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
    pwaState.installed = true;
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
