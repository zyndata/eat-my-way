# Eat My Way 🍽️

*Polish: „Jem po swojemu"*

A personal meal-planning calendar that runs entirely in your browser. Plan what you cook and
eat on each day; the app adds up kcal, protein, carbs and fat and shows them against your
goals. Installable as a PWA on Android and desktop, and usable offline.

The interface is in **Polish**. The code, comments and documentation are in English.

> **Status: in development.** The app is being built phase by phase — see
> [PLAN.md](PLAN.md) for the specification and [STATE.md](STATE.md) for what is done so far.
> Nothing is released yet.

## What makes it different

- **Your data stays yours.** There is no application backend. IndexedDB in your browser is the
  source of truth; Google Drive's private `appDataFolder` is only a sync layer, so the data is
  visible to this app and to nobody else — not even to a server of mine, because there isn't one.
- **The numbers are repeatable.** Nutrition comes from a bundled subset of the USDA FoodData
  Central database, computed locally. The same meal always produces the same calories. AI is
  used *only* to parse a pasted recipe into structured ingredients — never to invent nutrition
  values.
- **History is frozen.** Each planned meal stores a snapshot of its macros, so editing a recipe
  today never rewrites what you ate last month.
- **Bring your own key.** The optional Gemini recipe import uses *your* API key, stored in a
  vault encrypted with Argon2id + AES-GCM. The decrypted key never leaves your browser's memory.

## Stack

| Layer | Choice |
|---|---|
| App | Vite + Svelte 5 + TypeScript (SPA, hash routing, no SSR) |
| UI | Tailwind CSS v4, Bits UI (headless, accessible) |
| Local storage | Dexie over IndexedDB |
| Crypto | hash-wasm (Argon2id, in a Web Worker) + WebCrypto (AES-GCM) |
| Sync | Google Drive `appDataFolder` behind a `StorageBackend` interface |
| AI | Gemini (BYO key) — recipe parsing only |
| Serving | Caddy in Docker, static files only |
| Deploy | GitHub Actions → build in CI → rsync + versioned `docker build` on the server |

## Running it locally

Requires Node (the version in [.nvmrc](.nvmrc)) and, for the container check, Docker.

```bash
git clone https://github.com/zyndata/eat-my-way.git
cd eat-my-way
cp .env.example .env.local     # add your Google OAuth client ID (optional until Phase 6)
npm ci
npm run dev                    # http://localhost:5173
```

To see the app exactly as it is served in production — including the Content-Security-Policy,
which the dev server does not apply:

```bash
npm run docker:up              # build + container on http://localhost:8080
```

Working on the project itself: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
Deploying it: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | What is in it |
|---|---|
| [PLAN.md](PLAN.md) | The full specification and the phase-by-phase plan |
| [STATE.md](STATE.md) | Phase status, decisions taken, open questions |
| [CLAUDE.md](CLAUDE.md) | Working rules for this repository |
| [CHANGELOG.md](CHANGELOG.md) | Generated from Conventional Commits by git-cliff |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability, and what the threat model is |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, Windows + Linux, conventions |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Server layout, secrets, releases, rollback |

## Credits

Nutrition data: **U.S. Department of Agriculture, Agricultural Research Service,
[FoodData Central](https://fdc.nal.usda.gov/)** — public domain (CC0), attribution requested.
The app bundles a curated subset of the SR Legacy (2018-04) and Foundation Foods (2026-04-30)
releases, built by [`scripts/build-nutrition.mjs`](scripts/build-nutrition.mjs) from the
mapping in [`data/pl-ingredients.tsv`](data/pl-ingredients.tsv); the Polish names and synonyms
are our own work. This project is not endorsed by the USDA.

## License

[MIT](LICENSE) © 2026 Lukasz Gorny
