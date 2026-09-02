# Development

This project is developed from **two machines — Windows and Linux**. Everything needed to work
on it lives in the repository; nothing is configured per machine outside `.env.local` and your
own git identity.

## Setup (identical on both machines)

```bash
git clone https://github.com/zyndata/eat-my-way.git
cd eat-my-way
cp .env.example .env.local     # `copy` on Windows cmd; Copy-Item in PowerShell
npm ci
npm run dev                    # http://localhost:5173
```

Node version: see [.nvmrc](../.nvmrc). With `nvm` (either platform): `nvm use`.

## npm scripts

These are the interface to the project — prefer them over raw commands, because they are the
same on both machines and in CI.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR. **Does not apply the production CSP.** |
| `npm run build` | Production bundle into `dist/` |
| `npm run build:nutrition` | Regenerate the bundled USDA subset (see below). Dev-time only. |
| `npm run build:icons` | Regenerate the PWA icons in `public/icons/` (see below). Dev-time only. |
| `npm run check:nutrition` | Assert the committed subset matches the mapping, without downloading. |
| `npm run preview` | Serve the built bundle locally (still no CSP headers) |
| `npm run check` | `svelte-check` + TypeScript |
| `npm test` | Vitest, one pass. Data-layer unit tests (`src/**/*.test.ts`). |
| `npm run test:watch` | The same suite in watch mode. |
| `npm run test:e2e` | Playwright: the login and sync flows in a real browser (`e2e/`). |
| `npm run test:e2e:csp` | The same specs against the Caddy container, under the production CSP. |
| `npm run docker:up` | `build` + rebuild and start the Caddy container on :8080 |
| `npm run screenshots` | Retake the README screenshots against a running build. Dev-time only. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from commits (git-cliff) |

## The bundled nutrition database

`src/lib/nutrition/ingredients.json` is **generated and committed**. It is the curated USDA
FoodData Central subset the app imports into IndexedDB on first run; nothing fetches FoodData
Central at runtime.

```
data/pl-ingredients.tsv          hand-curated: Polish name -> fdcId, aliases, raw/cooked
        +  two pinned USDA releases (downloaded to data/usda/, gitignored, SHA-256 checked)
        |
        v  npm run build:nutrition
src/lib/nutrition/ingredients.json   the bundle the browser fetches
src/lib/nutrition/meta.ts            version, source ids and attribution, for the UI
```

- **`data/pl-ingredients.tsv` is the file you edit.** It decides both which USDA entries are
  bundled and what they are called in the Polish UI. Four tab-separated columns:
  `fdcId`, `name`, `aliases` (`|` separated), `state` (`raw` or `cooked`).
- **Never reuse or renumber an `fdcId`.** It becomes the ingredient's permanent id
  (`usda:<fdcId>`), and planned meals reference it forever.
- The generated files are **regenerated, never hand-edited**, exactly like `CHANGELOG.md`.
  `npm run check:nutrition` fails if they drift from the mapping.
- The build is reproducible: the releases are pinned by URL *and* SHA-256, rows are written in
  `fdcId` order and every macro is rounded the same way, so the same inputs give byte-identical
  output on both machines.
- The first run downloads ~10 MB into `data/usda/`. Later runs reuse it; `--offline` refuses to
  download at all.
- Bumping to a newer Foundation Foods release means changing the URL, the digest, the release id
  and `DATA_VERSION` in `scripts/build-nutrition.mjs` together — `DATA_VERSION` is what makes
  existing installs re-import.

## The PWA icons

`public/icons/*.png` is **generated and committed**, like the nutrition bundle. They are drawn
by [`scripts/build-icons.mjs`](../scripts/build-icons.mjs) — plain arithmetic plus Node's own
`zlib`, no image library and no design-tool export nobody can reproduce. The brand colour is
the `oklch(62% 0.16 145)` of `--color-accent` in `src/app.css`, converted in the script, so
changing the token and re-running is all it takes to recolour the set.

They are committed because the production image is built from `dist/` in CI, which must not
depend on this script having run.

## The screenshots in the README

`docs/screenshots/*.png` come from [`scripts/screenshots.mjs`](../scripts/screenshots.mjs),
which drives a real build on a phone-sized viewport. It needs a server:

```bash
npm run docker:up
npm run screenshots            # or BASE_URL=http://localhost:4173 npm run screenshots
```

## Cross-platform rules

These exist because the same checkout is edited on Windows and Linux:

- **Line endings are LF in the repository.** [.gitattributes](../.gitattributes) enforces this;
  do not disable `core.autocrlf` handling or commit CRLF into tracked text files. If git ever
  reports a whole file as modified with no visible change, that is a line-ending problem.
- **No absolute paths and no drive letters** in code, config, scripts or committed settings.
  Paths are relative to the repository root.
- **No platform-only scripts in the build path.** Automation goes into npm scripts (Node), not
  into `.ps1` or `.sh` files. A step that cannot be expressed cross-platform belongs in Docker.
- **File names are case-sensitive on Linux.** `Recipe.svelte` and `recipe.svelte` are the same
  file on Windows and two different ones on the server. Match the import to the file exactly.
- **Docker Desktop (Windows) and Docker Engine (Linux)** both run `docker compose` the same way;
  the compose file must not depend on either.
- Do not commit `.env.local`, `node_modules/`, `dist/`, or `.claude/settings.local.json`.

## The service worker

`vite-plugin-pwa` generates `dist/sw.js` at build time. Two things about it are deliberate and
easy to undo by accident:

- **Registration is imported, not injected.** `injectRegister: null` in `vite.config.ts`, and
  `src/main.ts` imports `virtual:pwa-register`. The plugin's default is an inline `<script>`,
  which `script-src 'self'` blocks.
- **There is no `runtimeCaching`.** Workbox then handles navigations and precached assets and
  nothing else, so no OAuth popup, token response or Gemini call can ever land in a cache.
  Adding a runtime cache means thinking about that again first.

The worker is registered with `registerType: 'prompt'`: a new bundle installs in the background
and waits, and `UpdatePrompt.svelte` offers „Odśwież". Nothing reloads under the user's hands.

`npm run dev` does not run a service worker at all (`devOptions.enabled: false`) — test it with
`npm run docker:up` or `npm run preview`.

## Working on the app

The project is built **one phase per conversation** via the `/phase N` slash command, and shipped
via the `/release` skill. The rules are in [CLAUDE.md](../CLAUDE.md); the current status is in
[STATE.md](../STATE.md). Read STATE.md before starting anything — it is the source of truth for
what is done and which decisions have already been made.

Two things that are easy to get wrong when switching machines:

1. **Pull before you start.** `git fetch origin && git status -sb`. A phase started on a stale
   branch is a merge conflict in the making.
2. **STATE.md is the handover.** If you stop mid-phase on one machine, record where you stopped
   in STATE.md and commit — that file is how the other machine (and the next conversation)
   learns what happened.

## Commits and branches

- Branches: work on `dev`, merge to `main`, release by pushing a `vX.Y.Z` tag.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `ci:`,
  `build:`, `chore:`). The changelog is generated from these messages, so the message *is* the
  release note. Do not hand-edit `CHANGELOG.md`.
- Code and comments in English; all user-facing UI text in Polish.

## Testing the real Content-Security-Policy

`npm run dev` and `npm run preview` serve without the production headers, so a CSP violation
will not appear until deploy. Before releasing anything that adds a script, style, font, image
source or outbound request, run:

```bash
npm run docker:up
```

then open http://localhost:8080 and confirm the console shows **zero** CSP violations. Widening
the policy is a deliberate decision that must be recorded in [STATE.md](../STATE.md).

Use `http://localhost:8080`, not `http://127.0.0.1:8080`: only the former is an authorized
JavaScript origin on the Google OAuth client, and to Google the two are different origins.

There is **one known violation**, and only after the user clicks *Połącz Dysk Google*: Google
Identity Services applies an inline style inside its own transient iframe, which
`style-src 'self'` blocks. It leaves nothing in the DOM and does not affect the sign-in popup —
see STATE.md decision 88. Any violation from our own code is a real regression.

## End-to-end tests

`e2e/` drives the built app in Chromium:

| Spec | What it covers |
|---|---|
| `connect.spec.ts` | Connecting Drive, the silent renewal on reload, a revoked grant, disconnecting |
| `sync.spec.ts` | Two devices over one fake Drive: merging, the same-day conflict prompt, the debounced background push |
| `goals.spec.ts` | „Zapisz cele" end to end — the `$state`-proxy defect of decision 56 |
| `import.spec.ts` | The Gemini import: a paste, a link, a bad key, the usage counter |
| `pwa.spec.ts` | The app with the network gone, and the installability requirements |
| `backup.spec.ts` | „Zapisz kopię" on one device, „Wczytaj kopię" on a fresh one |
| `swipe.spec.ts` | The meal card's swipe-left, as a real touch gesture on a phone context |
| `screens.spec.ts` | Every route in one session, asserting no CSP violation and no console error |

The Drive flow is the deepest of them: connecting, the silent renewal on reload, a revoked
grant, a foreign account, two devices merging, the same-day conflict prompt, and the debounced
background push.

**No Google account is involved, and none can be.** Google is replaced at the network
boundary, not in the app:

- `https://accounts.google.com/gsi/client` is answered with a stub that implements
  `initTokenClient` and `revoke`. It is served from that same URL, so the production
  `script-src` accepts it exactly as it accepts the real one.
- `https://www.googleapis.com/**` is answered by `FakeDrive` in `e2e/fake-google.ts`, an
  in-memory `appDataFolder` behind the real Drive REST surface.

Everything in `src/` runs unmodified — the real `google-auth.ts`, the real `drive.ts`, the real
sync engine. There is no `?e2e=1` flag and no test-only seam in the app, which is the point: a
suite that swapped out the code it is meant to protect would prove nothing.

```bash
npm run test:e2e            # builds, serves on :4173, runs everything
npm run test:e2e -- --ui    # pick and step through individual specs
```

Two browser contexts sharing one `FakeDrive` are two devices signed in to one account, each
with its own IndexedDB. That is PLAN.md's two-browser acceptance criterion, run for real.

### Under the production CSP

`vite preview` sends no security headers, so the default run cannot catch a policy regression.
The specs collect `securitypolicyviolation` events and assert there were none, which only means
something when the headers are actually there:

```bash
npm run docker:up
npm run test:e2e:csp
```

### What is still not covered

The live round trip to Google itself — a real token, a real `appDataFolder`, Drive's real
`modifiedTime` semantics. Every request in this suite is answered locally, so the client is
checked against the API *as documented*, not as it behaves. This is covered on purpose by a hand
run rather than by a test: Google blocks automated sign-in, so the checklist lives in
[DEPLOYMENT.md](DEPLOYMENT.md#the-first-live-sign-in-run-once-then-record-it) and is run once on
production after `v1.0.0`. Open question 15 and decision 149 in [STATE.md](../STATE.md).
