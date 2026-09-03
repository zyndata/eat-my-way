import { repository } from './repository';

/**
 * The light/dark choice (PLAN.md Phase 11 task 4).
 *
 * Three facts shape this module:
 *
 * - **The choice belongs to the device, not to the account.** It lives in `meta`, by the same
 *   argument that put `recipeSort` there: how a screen is drawn is a property of the screen in
 *   front of you, and a phone and a laptop may reasonably disagree. `meta` never travels to
 *   Drive; it does travel in the backup (STATE.md decisions 187, 195).
 * - **It has to be applied before the first paint**, and the production CSP allows no inline
 *   bootstrap script, so `main.ts` is the earliest point anything of ours runs. Only a
 *   synchronous read gets there in time, so the choice is mirrored into `localStorage` while
 *   IndexedDB stays the source of truth.
 * - **Every storage access is wrapped.** A browser with site data blocked throws on the mere
 *   mention of `localStorage` (STATE.md decision 173).
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

/** What is actually painted. „Jak system" resolves to one of these. */
export type ResolvedTheme = 'light' | 'dark';

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value);
}

/** The `localStorage` mirror. Read synchronously on boot; IndexedDB corrects it a tick later. */
const STORAGE_KEY = 'emw.theme';

/** `--color-accent` in the light theme; `--color-surface` in the dark one. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#529888',
  dark: '#22211f'
};

export const themeState = $state<{ choice: ThemeChoice; resolved: ResolvedTheme }>({
  choice: 'system',
  resolved: 'light'
});

/** Web storage throws outright in a browser with site data blocked; treat that as "no store". */
function store(): Storage | undefined {
  try {
    return (globalThis.localStorage as Storage | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

function readMirror(): ThemeChoice | undefined {
  try {
    const raw = store()?.getItem(STORAGE_KEY);
    return isThemeChoice(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeMirror(choice: ThemeChoice): void {
  try {
    store()?.setItem(STORAGE_KEY, choice);
  } catch {
    // A full or blocked store costs one frame of the wrong theme on the next load, nothing more.
  }
}

const darkQuery = (): MediaQueryList | undefined =>
  typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice;
  return darkQuery()?.matches === true ? 'dark' : 'light';
}

/**
 * Put the resolved theme on the document.
 *
 * `data-theme` drives the palette; the two `<meta>` tags drive what the *browser* paints around
 * it. `index.html` carries a light value for both, because it is parsed before this runs — left
 * alone they would keep the form controls, the scrollbars and the installed app's status bar
 * light around a dark page, which reads as a bug in the app.
 */
function paint(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;

  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme !== null) scheme.setAttribute('content', resolved);

  const color = document.querySelector('meta[name="theme-color"]');
  if (color !== null) color.setAttribute('content', THEME_COLOR[resolved]);
}

function apply(choice: ThemeChoice): void {
  themeState.choice = choice;
  themeState.resolved = resolveTheme(choice);
  paint(themeState.resolved);
}

/**
 * Called from `main.ts` before the app mounts. Reads the mirror synchronously so the first
 * paint is already right, then catches up with IndexedDB, which is the source of truth and may
 * disagree after a backup restore on another tab.
 */
export function startTheme(): void {
  apply(readMirror() ?? 'system');

  // „Jak system" follows the OS live: the setting can change while the app is open.
  darkQuery()?.addEventListener('change', () => {
    if (themeState.choice === 'system') apply('system');
  });

  void repository
    .getMeta('theme')
    .then((stored) => {
      if (stored === undefined) return;
      if (stored !== themeState.choice) apply(stored);
      writeMirror(stored);
    })
    .catch(() => {
      // No database yet, or one that refused to open. The mirror already answered.
    });
}

/** Change the theme. Applied at once, then written to both stores. */
export async function setTheme(choice: ThemeChoice): Promise<void> {
  apply(choice);
  writeMirror(choice);
  await repository.setMeta('theme', choice);
}
