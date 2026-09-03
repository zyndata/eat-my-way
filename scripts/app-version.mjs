// @ts-nocheck — a Node-only build helper. The app's type environment deliberately carries no
// Node globals (see the note in playwright.config.ts), and this file is the reason
// vite.config.ts does not have to break that rule to learn which build it is producing.
/**
 * Who a build is: the release it came from, the commit it was built at, and when.
 *
 * The git tag is the source of truth for the version — package.json is not bumped per release
 * (CLAUDE.md: a release is a `vX.Y.Z` tag on main), so it is only the last resort.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A released version is exactly the SemVer tag the deploy workflow was triggered by. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** What `git describe` may answer with: a tag, optionally with how far past it we are. */
const DESCRIBED = /^v\d+\.\d+\.\d+(-|$)/;

/** Ask git something, or accept that this checkout cannot answer (a tarball, a stale image). */
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
  } catch {
    return null;
  }
}

/**
 * On a tagged CI build `GITHUB_REF_NAME` *is* the release, and it is read first because
 * `actions/checkout` clones shallowly enough that `git describe` cannot be relied on. Locally
 * `git describe` gives the last release plus how far past it this build is
 * (`v1.1.1-3-gab12cd4`), which is exactly what makes a report from a dev build useful.
 */
function version() {
  const ref = process.env.GITHUB_REF_NAME;
  if (ref !== undefined && RELEASE_TAG.test(ref)) return ref;

  // No `--always`: without it git says nothing when the checkout has no tags, and with it says
  // the commit hash — which the app would then show under „Wersja aplikacji" as if a hash were
  // a version. That is exactly what every CI build of `dev` displayed, because
  // `actions/checkout` clones without tags unless told otherwise (STATE.md decision 235).
  const described = git('describe', '--tags', '--dirty');
  if (described !== null && DESCRIBED.test(described)) return described;

  // Last resort, for a checkout with no git at all. It can lag a release: nothing bumps it
  // automatically, so treat it as „this build could not say", not as an authority.
  const url = new URL('../package.json', import.meta.url);
  return `v${JSON.parse(readFileSync(url, 'utf8')).version}`;
}

/** The exact commit, for the case where two builds carry the same version string. */
function commit() {
  const sha = process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
  return sha ? sha.slice(0, 7) : 'unknown';
}

/** The `define` block vite.config.ts freezes into the bundle. */
export function versionDefines() {
  return {
    __APP_VERSION__: JSON.stringify(version()),
    __APP_COMMIT__: JSON.stringify(commit()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString())
  };
}
