# Eat My Way — project guidance

Personal meal-planning calendar PWA (Polish UI). Pure client-side SPA (Vite + Svelte 5 + TS),
IndexedDB as source of truth, Google Drive `appDataFolder` as sync layer, BYO Gemini key for
recipe import, served as static files by Caddy in Docker behind nginx at
https://eatmyway.gorny.dev. No application backend.

- Full specification and phase breakdown: [PLAN.md](PLAN.md)
- Progress, decisions, open questions: [STATE.md](STATE.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md) (generated — never hand-edited)
- Local setup and cross-platform rules: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Server, secrets, rollback: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Workflow rules

- **One phase per conversation**, started via `/phase N`. Never continue into the next phase
  in the same conversation.
- **STATE.md is the single source of truth** for progress and decisions. Update it before and
  after every phase.
- Any **deviation from PLAN.md must be recorded in STATE.md** before proceeding.
- **Conventional commits**; push after each phase.
- **A push is not finished until CI is green.** `ci.yml` runs on every push to `dev` and `main`
  and is the only check that runs somewhere other than the machine the work was done on — a
  green local run is evidence, not a substitute. After pushing, wait for the run
  (`gh run watch <id> --exit-status`) and report what it said. Never call work done while a run
  is pending or red.
- **End-of-phase ritual:** update STATE.md → **re-read README.md against what the phase
  changed** → regenerate CHANGELOG.md (`npm run changelog`) → commit → push → plain-language
  summary → go/no-go statement for the next phase.
- **The README is part of the phase, not an afterthought.** It is the only document a stranger
  reads, and nothing in CI can tell that it has started lying. Before closing a phase, check the
  three things that go stale: the status blockquote (which phases are done), any claim about
  what the app does or refuses to do — a reversed decision makes the README *wrong*, not merely
  thin — and the screenshots. Re-take those with `npm run screenshots` against a built app
  (`npm run docker:up`, or `BASE_URL=… npx vite preview`) whenever a screen in them changed:
  navigation, colours, or the screens themselves.
- **Code and comments in English. All user-facing UI text in Polish.**
- **Minimal dependencies** — every package must justify itself; this app holds user credentials.

## Repository conventions

- **Branches:** work on `dev`, merge to `main`, release by pushing a `vX.Y.Z` tag. A plain push
  to `main` does not deploy — only the tag does. Ship with the `/release` skill.
- **CHANGELOG.md is generated** by git-cliff from Conventional Commit messages. The commit
  message *is* the release note; edit messages, not the file.
- **Two machines (Windows + Linux)** share this checkout. LF line endings are enforced by
  `.gitattributes`; no absolute paths, no drive letters, no platform-only scripts in the build
  path; file names are case-sensitive on the server. Details in
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
- **Public repository.** Never commit a credential — no Gemini key, no OAuth client secret, no
  `.env`. Only `.env.example`. Everything under `VITE_*` ends up in the public bundle by design.
- `npm run dev` does **not** apply the production CSP. Anything that adds a script, style, font,
  image source or outbound request must be verified with `npm run docker:up` on
  http://localhost:8080 before release.
