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
| `npm run check:nutrition` | Assert the committed subset matches the mapping, without downloading. |
| `npm run preview` | Serve the built bundle locally (still no CSP headers) |
| `npm run check` | `svelte-check` + TypeScript |
| `npm test` | Vitest, one pass. Data-layer unit tests (`src/**/*.test.ts`). |
| `npm run test:watch` | The same suite in watch mode. |
| `npm run docker:up` | `build` + rebuild and start the Caddy container on :8080 |
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
