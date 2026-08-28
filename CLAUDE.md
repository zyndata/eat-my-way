# Eat My Way — project guidance

Personal meal-planning calendar PWA (Polish UI). Pure client-side SPA (Vite + Svelte 5 + TS),
IndexedDB as source of truth, Google Drive `appDataFolder` as sync layer, BYO Gemini key for
recipe import, served as static files by Caddy in Docker. No application backend.

- Full specification and phase breakdown: [PLAN.md](PLAN.md)
- Progress, decisions, open questions: [STATE.md](STATE.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## Workflow rules

- **One phase per conversation**, started via `/phase N`. Never continue into the next phase
  in the same conversation.
- **STATE.md is the single source of truth** for progress and decisions. Update it before and
  after every phase.
- Any **deviation from PLAN.md must be recorded in STATE.md** before proceeding.
- **Conventional commits**; push after each phase.
- **End-of-phase ritual:** update STATE.md → CHANGELOG.md entry → commit → push →
  plain-language summary → go/no-go statement for the next phase.
- **Code and comments in English. All user-facing UI text in Polish.**
- **Minimal dependencies** — every package must justify itself; this app holds user credentials.
