/**
 * Who this build is, in the three values a bug report needs: the release it came from, the
 * commit it was built at, and when. All three are frozen into the bundle by `vite.config.ts`
 * — nothing here reads the network or the filesystem at runtime.
 *
 * It matters more than usual for a PWA: a service worker can keep an old build alive on a
 * device long after a release, so „which version am I actually looking at" is a question the
 * app has to be able to answer about itself.
 */

/** The release tag, or a `v1.1.1-3-gab12cd4` description of a build made past one. */
export const APP_VERSION = __APP_VERSION__;

/** Short commit SHA, `'unknown'` where the build had no git and no CI environment. */
export const APP_COMMIT = __APP_COMMIT__;

/** Build time, ISO-8601. */
export const APP_BUILT_AT = __APP_BUILT_AT__;

/** `v1.1.1` → `1.1.1`; anything else is shown as it is. */
export const APP_VERSION_LABEL = APP_VERSION.replace(/^v/, '');

const BUILT_AT_FORMAT = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

/** The build date in Polish, or `null` if the stamp is unreadable. */
export function builtOn(): string | null {
  const at = new Date(APP_BUILT_AT);
  return Number.isNaN(at.getTime()) ? null : BUILT_AT_FORMAT.format(at);
}
