# Eat My Way — Plan & Specification

## Product

**Eat My Way** — a personal meal-planning calendar PWA. Single user (the account owner; small
circle of separate users, each with their own Google account and data). The user plans meals per
day; the app computes daily totals of kcal, protein, carbs, and fat and compares them against the
user's goals. Works in the browser on desktop and Android (responsive, installable PWA).
UI language: Polish.

Out of scope for MVP: Cookidoo integration (planned later — architecture must not block it),
meal photos (data model supports them now, UI later), multi-profile support (never needed —
always exactly one person per account).

## Architecture

- Pure client-side SPA. No application backend. The only server is **Caddy** in Docker serving
  static files (host machine is weak — irrelevant, nothing computes server-side).
- **TLS is terminated by nginx** on the deploy host, which already owns 80/443 for another site;
  Caddy listens on plain HTTP `:8080`, published on `127.0.0.1` only, and remains the single
  source of the security headers. The production bundle is built in CI and shipped as a
  prebuilt `dist/` — the VM never runs a bundler. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **IndexedDB is the source of truth.** Google Drive (`appDataFolder`) is a sync layer behind a
  `StorageBackend` interface: `read`, `write`, `getRemoteVersion`, `authenticate`. Drive is the
  first implementation; others may come later.
- All third-party calls go directly from the browser (Gemini and Drive APIs support CORS).
- App must work fully offline except sync and Gemini calls.

## Stack

- Vite + **Svelte 5** + TypeScript (SPA, no SSR)
- Tailwind CSS v4; **Bits UI** for headless accessible components (modals, dropdowns, focus traps)
- **Dexie** over IndexedDB (schema migrations)
- **hash-wasm** for Argon2id (run in a Web Worker) + native WebCrypto for AES-GCM
- **vite-plugin-pwa** (installable, offline via service worker)
- **svelte-spa-router** (hash-based routing — no server rewrites needed)
- **svelte-dnd-action** for drag & drop (set ~200 ms touch delay so list scrolling doesn't
  trigger drags)

## Security

- CSP without `unsafe-inline` / `unsafe-eval`. `connect-src` limited to:
  `generativelanguage.googleapis.com`, `www.googleapis.com`, `accounts.google.com`
  (extend only when a new source is added).
- Gemini API key must never leak into logs or error reporters.
- Decrypted vault key lives only in memory for the session.

## Storage layout (Drive `appDataFolder`)

```
vault.json           # encrypted credentials (Gemini API key; later Cookidoo)
profile.json         # goals, model choice, locale, encryptVault flag, Google account `sub`
recipes.json         # recipe library
ingredients.json     # user's custom ingredients + PL-name→id match corrections
days/2026-09.json    # one file per month: { "2026-09-03": Day, ... }
```

- Merge granularity is **per day**: before every write, `files.get` with
  `fields=modifiedTime,id`; if remote is newer → fetch, merge per-day, then write. Conflict on
  the *same day* → ask the user, never guess.
- Future: photos as separate Drive files (client-side canvas resize to ~1200 px, WebP,
  ~100–200 kB), referenced by `photoFileId`.

## Vault

- Default: encrypted with a **master password** → Argon2id (≈64 MB, 3 iterations, parallelism 1,
  in a Web Worker) → AES-GCM.
- Versioned format: `{"v":1,"kdf":"argon2id","params":{...},"salt":"...","data":"..."}` —
  KDF params stored in the file, not in code.
- Store an encrypted known verifier string to distinguish "wrong password" from
  "corrupted file".
- Optional **unencrypted mode**, chosen consciously behind a prominent warning; encrypted is the
  default. Mode transitions (enable/disable encryption, change password) = read →
  re-encrypt/decrypt → write; disabling asks for a second confirmation.
- No recovery: say so at vault **creation** time, one clear sentence.
- After 3 failed unlock attempts: explain the password is unrecoverable and that starting over
  loses only vault contents — calendar and recipes live outside the vault and survive.
- Calendar/recipes must be usable without unlocking the vault; unlock is required only for
  Gemini calls.

## Google / OAuth

- Google login is identity + Drive access only (there is no OAuth path to Gemini; key is pasted
  manually).
- Drive scope: `drive.appdata` (user base far below the 100-user unverified cap — no
  verification needed).
- Store the Google `sub` in profile.json; if the connected account's `sub` differs from stored →
  tell the user explicitly instead of silently creating a fresh profile.
- Handle revoked/expired refresh tokens: re-auth flow that never touches local IndexedDB data;
  sync resumes after login.

## Gemini

- BYO API key, stored in the vault. Model name configurable in settings (default
  `gemini-2.5-flash`) — free-tier catalogs change, never hardcode.
- New AI Studio keys are auth-keys (fine); show a clear error message if an old "Standard" key
  is rejected (API refuses those since Sept 2026).
- Role: **intent parser and recipe importer only.** Given a pasted recipe/URL text, Gemini
  returns structured JSON: `{ingredients:[{name, amount, unit, state}], instructions}` —
  **never nutrition numbers** (repeatability beats plausibility; the same meal must always
  compute identically).
- Ingredient matching: app code matches parsed names to the local nutrition DB. Provide Gemini a
  controlled vocabulary (candidate ids) so it returns a `fdcId`, not free text. Persist user
  corrections in `ingredients.json` (PL name → id) so matching becomes deterministic over time.
- Gemini may be a required feature (tiny trusted user group), but everything except
  recipe-import must work without it.

## Nutrition data

- Bundle a curated subset of **USDA FoodData Central** (Foundation + SR Legacy; CC0 public
  domain — attribution requested, no permission needed): ~800–1500 common ingredients, macros
  per 100 g, ~200–400 kB JSON, loaded into IndexedDB on first run. No runtime FDC API calls
  (no CORS, 1000 req/h limit, keys in repos get revoked).
- Maintain a Polish-name→fdcId mapping file (Polish inflection breaks fuzzy search).
- `state: raw | cooked` is part of the model from day one (300 g raw potatoes ≠ 300 g cooked;
  USDA has separate entries).
- Frying fat: recipes must carry a concrete amount ("odrobina oliwy" is 100–200 kcal) — parser
  must be instructed to quantify, plus manual field.
- Open Food Facts as a later second source for branded Polish products (has CORS).

## Data model

```ts
interface Macros { kcal: number; protein: number; carbs: number; fat: number } // grams

interface Ingredient {
  id: string;              // "usda:1097473" | "custom:uuid"
  name: string;            // Polish display name
  aliases: string[];
  state: 'raw' | 'cooked';
  per100g: Macros;
  source: 'usda' | 'off' | 'custom';
}

interface Recipe {
  id: string;
  name: string;
  photoFileId?: string;    // future; separate Drive file
  instructions: string;
  items: RecipeItem[];     // ALWAYS per 1 portion
  tags: string[];          // normalized keys
  createdAt: string;
  updatedAt: string;
}

interface RecipeItem {
  ingredientId: string;
  amount: number;
  unit: 'g' | 'ml' | 'szt';
  gramsPerUnit?: number;   // for 'szt' (1 egg = 58 g)
  macroOverride?: Macros;  // manual per-100g override at point of use
}

interface Tag { key: string; label: string; useCount: number }
// key = lowercase, diacritics stripped; label = as first typed. Normalize on save.

interface PlannedMeal {
  id: string;
  recipeId: string;
  cookingScale: number;    // affects DISPLAYED ingredient amounts only
  portionsEaten: number;   // affects MACROS only; default 1
  macroSnapshot: Macros;   // frozen per-1-portion values at add time
}

interface Day {
  date: string;            // "2026-09-03"
  meals: PlannedMeal[];    // array order IS the display order (no order field)
  goalSnapshot?: Macros;   // captured when first meal is added to the day
}

interface Profile {
  goals: Macros;
  geminiModel: string;
  encryptVault: boolean;
  locale: 'pl';
  googleSub?: string;
}
```

**Formulas (invariants):**

```
displayed amount = item.amount × cookingScale
meal macros      = macroSnapshot × portionsEaten
day total        = Σ meal macros
```

`cookingScale` never touches calories. History is frozen: editing a recipe never silently
changes past days; on recipe edit, ask whether to update *future* planned days only.

## Copy operations

All copies are deep copies with new ids **including `macroSnapshot`** (never recomputed — a copy
is independent of later recipe edits).

- `duplicateMeal(dayDate, mealId)` — same day
- `copyMealToDays(mealId, targetDates[])`
- `copyDay(sourceDate, targetDates[])` — if target non-empty: ask replace/append, default append
- Shared date multi-select component: mini calendar, shortcuts "jutro", "cały przyszły tydzień"
- "Cooking for 2 days" shortcut in meal view next to cookingScale: checkbox "dodaj też jutro" →
  sets scale and creates tomorrow's copy with `portionsEaten = 1`

## Screens & navigation

Routes (hash-based):

```
/                       today
/day/:date              day view
/day/:date/:mealId      meal view
/recipes                library
/recipes/:id/edit       editor
/settings               settings
/setup                  first-run wizard
```

- **Mobile:** bottom nav (Kalendarz / Przepisy / Ustawienia); everything else is bottom sheets
  and pushed views. **Desktop:** narrow sidebar; day view + meal detail side by side. Same
  components, different container layout.
- **Calendar:** horizontally scrollable week strip on top (each day: kcal progress ring),
  today's content directly below. Month grid as a toggle (overview only).
- **Day view:** sticky compact header `1847 / 2000 kcal` + three P/C/F bars; meal cards (name,
  kcal, portions, drag handle); FAB "Dodaj posiłek"; swipe-left on card → Powiel / Kopiuj
  do... / Usuń. Day header ⋮ menu → Kopiuj dzień do... / Wyczyść dzień. Empty day hint:
  "Skopiuj z innego dnia".
- **Recipe picker:** bottom sheet — search field + tag chips, sorted by recently/frequently
  used, "Nowy przepis" at bottom.
- **Meal view order:** name (photo header later) → recipe (ingredients + instructions) →
  cookingScale control (amounts rescale live) → portionsEaten + per-portion macros →
  collapsible per-ingredient macro breakdown.
- **Recipe editor:** name; tags with autocomplete from existing; ingredient rows (autocomplete
  field → pick → amount+unit; macros auto-filled, pencil icon to override); live per-portion
  macro sum; instructions textarea; "Wklej przepis z internetu" → Gemini parse.
- **Autocomplete:** local over IndexedDB (no API). Diacritic-normalized index (ł→l, ą→a…),
  prefix matches ranked above infix, previously-used ingredients first.
- **Settings:** goals (with Mifflin-St Jeor calculator, overridable), Gemini key, model, vault
  encryption toggle + password change, Drive account, data export.
- **Vault unlock:** separate screen, shown only when a Gemini call needs the key.

## First-run wizard

Shown when Drive is connected and `appDataFolder` has no data.

1. Connect Google Drive (OAuth, check appDataFolder)
2. No data found → "Utwórz nowy profil" / "Mam już dane na innym koncie"
3. Master password (before the API key — key goes inside). Encrypted by default; opting out
   requires an explicit warning acknowledgment. State clearly: password is unrecoverable.
4. Gemini API key — link to AI Studio + a live test request so the user sees it works
5. Goals — skippable ("ustawię później", defaults 2000 kcal / 100 P / 250 C / 70 F);
   calculator available
6. Done → today's day view

---

# Phases

Local-first ordering: the app is usable locally after phases 1–5, before sync/vault (6) — Drive
can land late without blocking daily use. One phase per conversation via `/phase N`.
Progress is tracked in [STATE.md](STATE.md).

## Phase 1 — Scaffold & Docker

### Tasks

1. Initialize Vite + Svelte 5 + TypeScript SPA (no SSR), strict TS config.
2. Add Tailwind CSS v4 and Bits UI; verify the production build needs no `unsafe-inline`
   styles/scripts.
3. Add svelte-spa-router with hash-based routes: `/`, `/day/:date`, `/day/:date/:mealId`,
   `/recipes`, `/recipes/:id/edit`, `/settings`, `/setup` — each rendering a placeholder screen
   with its Polish title.
4. Responsive layout shell: mobile bottom nav (Kalendarz / Przepisy / Ustawienia), desktop
   narrow sidebar; same route components in both containers.
5. `Dockerfile` (`FROM caddy:2-alpine`, copying the prebuilt `dist/` — no bundler on the
   server) + `docker-compose.yml` (container `eatmyway-dev`, published on `127.0.0.1:8080`) +
   `Caddyfile` listening on `:8080` (plain HTTP; nginx terminates TLS in production) with
   security headers: CSP without `unsafe-inline`/`unsafe-eval`, `connect-src` limited to
   `generativelanguage.googleapis.com`, `www.googleapis.com`, `accounts.google.com`, plus
   `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
6. npm scripts: `dev`, `build`, `preview`, `check` (svelte-check), `test` (placeholder until
   Phase 2), `docker:up` (`build` + `docker compose up --build -d`), `changelog` (git-cliff).
   Add `git-cliff` as a devDependency so the changelog is reproducible on both machines.
7. Remove the temporary "is the app scaffolded yet?" guard from
   `.github/workflows/ci.yml` — from this phase on, CI has a real project to check.

### Acceptance criteria

- [ ] `npm run dev` serves the shell; all 7 routes render their placeholder with Polish titles.
- [ ] Resizing the browser switches bottom nav (narrow) ↔ sidebar (wide) without reload.
- [ ] `npm run build` succeeds with zero TS/svelte-check errors.
- [ ] `npm run docker:up` serves the built shell on http://localhost:8080; response headers
      include the CSP exactly as specified, and the app functions under it (zero CSP
      violations in the console on every route).
- [ ] CI is green on `dev` with the guard removed (install → check → test → build).
- [ ] Works from a clean checkout on both Windows and Linux (no absolute paths, LF endings,
      no platform-only scripts).
- [ ] No dependency outside the stack list without a STATE.md decision entry.

## Phase 2 — Local data layer

### Tasks

1. Define all data model types (`Macros`, `Ingredient`, `Recipe`, `RecipeItem`, `Tag`,
   `PlannedMeal`, `Day`, `Profile`) in `src/lib/types.ts` matching the spec exactly.
2. Dexie database with schema/migration setup: tables for ingredients, recipes, tags, days,
   profile (single row), and a meta/kv table (schema versions, sync bookkeeping).
3. Macro computation module (pure functions): per-item macros (unit handling incl. `szt` with
   `gramsPerUnit`, `macroOverride` precedence), per-recipe per-portion sum, meal macros
   (`macroSnapshot × portionsEaten`), day totals, displayed amounts
   (`item.amount × cookingScale`).
4. Copy operations as pure + persistence functions: `duplicateMeal`, `copyMealToDays`,
   `copyDay` (replace/append semantics) — deep copies, new ids, `macroSnapshot` carried over,
   never recomputed.
5. `goalSnapshot` logic: captured from profile goals when the first meal is added to a day.
6. Tag normalization: `key` = lowercase + diacritics stripped, `label` = as first typed,
   `useCount` maintenance.
7. Set up Vitest; unit tests covering the invariants:
   - `cookingScale` never changes macros.
   - `meal macros = macroSnapshot × portionsEaten`; `day total = Σ meal macros`.
   - Copies keep `macroSnapshot` identical and get new ids; editing the source recipe
     afterwards changes nothing in the copies.
   - `szt` conversion via `gramsPerUnit`; `macroOverride` wins over ingredient `per100g`.
   - Tag normalization (Polish diacritics).

### Acceptance criteria

- [ ] `npm test` runs the invariant suite green.
- [ ] Dexie DB opens with versioned schema; a migration step is proven to run exactly once.
- [ ] All computation functions are pure (no DB access) and covered by tests.
- [ ] `svelte-check`/`tsc` clean.

## Phase 3 — Nutrition DB & autocomplete

### Tasks

1. Build script (`scripts/`, run at dev time, not runtime) producing the bundled USDA subset:
   Foundation + SR Legacy, ~800–1500 common ingredients, macros per 100 g, target 200–400 kB
   JSON. Include raw/cooked variants as separate entries with `state` set.
2. Polish-name→fdcId mapping file (checked into repo, hand-curated + script-assisted); merged
   into the bundled JSON as `name`/`aliases`.
3. First-run import: load bundled JSON into IndexedDB once (guarded by a meta flag + data
   version for future re-imports).
4. Diacritic normalization utility (ł→l, ą→a, ś→s, ż/ź→z, ć→c, ę→e, ń→n, ó→o) + normalized
   search index stored alongside ingredients.
5. Autocomplete component (headless logic + UI): local IndexedDB queries only, prefix matches
   ranked above infix, previously-used ingredients first; keyboard and touch accessible.
6. USDA attribution note (FDC is CC0; attribution requested) in an about/credits placeholder.

### Acceptance criteria

- [ ] Build script is reproducible: same inputs → byte-identical JSON; output size 200–400 kB.
- [ ] Fresh browser profile: first load imports the DB exactly once; second load skips import
      (verified via meta flag).
- [ ] Typing `zolty ser` (no diacritics) finds „ser żółty"; prefix beats infix in ranking; an
      ingredient used in a recipe ranks above unused ones. Covered by unit tests on the search
      logic.
- [ ] Raw and cooked variants of at least potato, rice, chicken breast exist as separate
      entries.
- [ ] No runtime network calls for nutrition data (verified offline).

## Phase 4 — Recipes

### Tasks

1. Recipe library screen `/recipes`: list with search + tag chips, sorted by
   recently/frequently used; "Nowy przepis".
2. Recipe editor `/recipes/:id/edit`: name; tags with autocomplete from existing tags
   (normalization on save); ingredient rows (autocomplete → pick → amount + unit `g`/`ml`/`szt`
   with `gramsPerUnit` field for `szt`); macros auto-filled from DB with pencil icon opening a
   per-100g `macroOverride` editor; live per-portion macro sum; instructions textarea.
   "Wklej przepis z internetu" button present but disabled/stub (Gemini lands in Phase 7).
3. Items are always per 1 portion — editor copy states this („Składniki na 1 porcję").
4. Recipe edit vs history: editing a recipe used in planned days prompts whether to update
   *future* days' `macroSnapshot`s only; past days never change. (Days UI arrives in Phase 5;
   implement and test the data-layer behavior now.)
5. Delete recipe flow: warn when referenced by planned meals (meals keep working via snapshot);
   record the chosen behavior in STATE.md.

### Acceptance criteria

- [ ] Create → edit → search → filter-by-tag round trip works entirely offline.
- [ ] Per-portion macro sum updates live while editing amounts/units/overrides and matches the
      Phase 2 pure functions (test).
- [ ] Tag typed as „Śniadanie" matches existing key `sniadanie` and does not create a
      duplicate; `useCount` increments.
- [ ] Editing a recipe with the "update future days" answer changes future `macroSnapshot`s
      and provably leaves past days untouched (test).
- [ ] All UI text in Polish; code/comments in English.

## Phase 5 — Calendar & day view

### Tasks

1. Calendar `/` and `/day/:date`: horizontally scrollable week strip (each day: kcal progress
   ring vs goals), selected day's content below; month grid toggle (overview only).
2. Day view: sticky compact header `1847 / 2000 kcal` + three P/C/F progress bars (vs
   `goalSnapshot`, falling back to profile goals for empty days); meal cards (name, kcal,
   portions, drag handle); FAB „Dodaj posiłek".
3. Add-meal bottom sheet (recipe picker): search + tag chips, sorted by recently/frequently
   used, „Nowy przepis" at the bottom; adding creates `PlannedMeal` with frozen
   `macroSnapshot` and triggers `goalSnapshot` capture on first meal.
   The sheet header shows what is left of the day („Zostało 620 kcal") and a „Zmieści się w limicie"
   toggle filters the list to recipes at or below that, at one portion, keeping the ranking inside
   the filter (STATE.md decision 64). An exhausted budget says „Limit dzienny już wykorzystany" and
   leaves the full list; a day with no goal hides the toggle.
4. Drag & drop reorder with svelte-dnd-action, ~200 ms touch delay; array order is the display
   order.
5. Swipe-left on meal card → Powiel / Kopiuj do... / Usuń; day header ⋮ → Kopiuj dzień do... /
   Wyczyść dzień; empty-day hint „Skopiuj z innego dnia".
6. Shared date multi-select component (mini calendar; shortcuts „jutro", „cały przyszły
   tydzień") wired to `copyMealToDays` / `copyDay` (replace/append prompt, default append).
7. Meal view `/day/:date/:mealId`: name → recipe (ingredients + instructions) → cookingScale
   control with live-rescaled displayed amounts → portionsEaten + per-portion macros →
   collapsible per-ingredient breakdown; „dodaj też jutro" checkbox next to cookingScale
   (sets scale, creates tomorrow's copy with `portionsEaten = 1`).

### Acceptance criteria

- [ ] Changing `cookingScale` visibly rescales ingredient amounts and provably does not change
      day totals; changing `portionsEaten` changes totals accordingly.
- [ ] Reorder via drag persists across reload; touch scroll on the list does not start a drag.
- [ ] Copy-day into a non-empty day asks replace/append and defaults to append; copies remain
      unchanged after editing the source recipe.
- [ ] `goalSnapshot` is captured on first meal add and shown in the header even after profile
      goals change later.
- [ ] With meals already planned, the picker's remaining-budget toggle shows exactly the recipes
      whose per-portion kcal fit what is left, and behaves as specified with no goal and with an
      exhausted budget.
- [ ] Week strip rings reflect day totals vs goals; today is reachable from anywhere in ≤2
      taps.
- [ ] Fully offline-capable; app remains usable with no vault and no Drive connection.

## Phase 6 — Drive sync & vault

### Tasks

1. `StorageBackend` interface (`read`, `write`, `getRemoteVersion`, `authenticate`) + Google
   Drive `appDataFolder` implementation (scope `drive.appdata` only). Google Identity Services
   token flow; no secrets in the repo.
2. File layout per spec: `vault.json`, `profile.json`, `recipes.json`, `ingredients.json`,
   `days/YYYY-MM.json` (one file per month).
3. Sync engine: before every write `files.get` with `fields=modifiedTime,id`; if remote newer →
   fetch, merge per-day, write. Same-day conflict → user prompt (never guess), showing both
   versions.
4. Vault: Argon2id via hash-wasm in a Web Worker (≈64 MB, 3 iterations, parallelism 1) →
   AES-GCM via WebCrypto; versioned format
   `{"v":1,"kdf":"argon2id","params":{...},"salt":"...","data":"..."}` with params read from
   the file; encrypted known-verifier string to distinguish wrong password from corruption.
5. Vault modes: encrypted default; unencrypted opt-out behind a prominent warning; transitions
   (enable/disable/change password) = read → re-encrypt/decrypt → write; disabling asks for a
   second confirmation; decrypted key held in memory only; "no recovery" sentence at creation.
6. Unlock screen shown only when a Gemini call needs the key; after 3 failed attempts explain
   unrecoverability and that only vault contents are lost (calendar/recipes survive).
7. First-run wizard `/setup` per spec (steps 1–6; Gemini key step does a live test request —
   actual parsing arrives in Phase 7).
8. Edge cases: connected account `sub` ≠ stored `sub` → explicit message, never a silent fresh
   profile; revoked/expired token → re-auth flow that never touches local IndexedDB; sync
   resumes after login.

### Acceptance criteria

- [ ] Two browsers, same account: edits to *different* days on both sides merge without any
      prompt; edits to the *same* day trigger the conflict prompt and honor the choice.
- [ ] Wrong password shows a wrong-password message (verifier path); a corrupted `vault.json`
      shows a distinct corruption message.
- [ ] KDF params are read from the file: a vault written with different params still unlocks.
- [ ] Encrypt→decrypt→re-encrypt transitions preserve the Gemini key; disabling encryption
      requires two confirmations.
- [ ] Calendar and recipes fully usable with the vault locked.
- [ ] Foreign `sub` and revoked-token flows behave per spec (manual test script recorded in
      STATE.md).
- [ ] `connect-src` still lists only the three allowed hosts. Google Identity Services also
      needs `script-src https://accounts.google.com` and `frame-src https://accounts.google.com`
      — add exactly those, record the widening in STATE.md, and verify zero CSP violations
      through the whole OAuth flow under `npm run docker:up`.

## Phase 7 — Gemini import

### Tasks

1. Gemini client: BYO key from vault, model name from profile (default `gemini-2.5-flash`,
   never hardcoded elsewhere); key never logged or included in error reports.
2. Key test call (used by wizard step 4 and settings): clear Polish success/error messages,
   including a specific message for rejected old "Standard" keys.
3. „Wklej przepis z internetu": the input is **a link or pasted text** (STATE.md decision 63).
   A URL is retrieved on Gemini's side — the browser never fetches a third-party page, so the CSP
   does not change; unreachable URLs fall back to „wklej treść" with a clear Polish message. Either
   way Gemini returns structured JSON `{ingredients:[{name, amount, unit, state}], instructions}` —
   the prompt explicitly forbids nutrition numbers and requires quantified fats (no
   „odrobina oliwy").
4. Controlled-vocabulary matching: app selects candidate ingredient ids for each parsed name
   and asks Gemini to pick a `fdcId` from that list (or none); unmatched rows fall back to
   manual autocomplete in the editor.
5. Persist user corrections (PL name → id) in `ingredients.json` data so repeat imports match
   deterministically.
6. Import lands in the recipe editor as a draft for review — never saved without user
   confirmation.

### Acceptance criteria

- [ ] Pasting a known Polish recipe produces a draft with matched ingredients, amounts, units,
      and quantified fat; nutrition values come only from the local DB.
- [ ] A link to that same recipe produces the same draft as its pasted text; a URL the model cannot
      read fails with a Polish message that points at pasting the text, and `connect-src` is
      unchanged.
- [ ] Importing the same text twice yields identical drafts (determinism).
- [ ] Correcting a mismatch once makes the next import of that name match automatically.
- [ ] Invalid/revoked key → clear Polish error; the key string appears in no console output,
      no error object, no network log statement (code audit + grep).
- [ ] Changing the model name in settings takes effect without code changes.
- [ ] Everything except recipe import still works with no key / locked vault.

## Phase 8 — PWA & polish

### Tasks

1. vite-plugin-pwa: installable (manifest, icons, Polish name), offline via service worker;
   sensible update flow (new-version prompt, no silent breakage).
2. Verify full offline behavior: everything except sync and Gemini works with network off;
   graceful Polish messaging on the two online-only actions.
3. Install prompt UX (Android + desktop) and installability check.
4. Empty states for all screens, carrying the copy from STATE.md decision 61: the empty library
   offers both ways to fill it („Nowy przepis" and „Wklej przepis z internetu") and draws the line at
   *no recipe search and no guessed calories* — never at "no recipes from the internet"; the empty day
   hints „Skopiuj z innego dnia"; the recipe picker offers „Nowy przepis" when the library is
   empty; `/about` gains a „Jak to działa" section stating that Drive is a backup, not a source of
   recipes, and that the app cannot see the rest of the user's Drive.
5. Mifflin-St Jeor calculator in settings goals (sex, age, height, weight, activity factor),
   result overridable.
6. Data export in settings (single JSON download of all local data).
7. Final security pass: CSP re-verified in the Docker deployment (including the Google Identity
   Services sources added in Phase 6), `npm audit`, confirm the Gemini key and decrypted vault
   key never persist outside intended storage (grep for logging paths); USDA attribution in
   credits; review SECURITY.md against what the finished app actually does.
8. Docs: README screenshots and status, restore-on-new-device flow, final sweep of
   STATE.md; verify docs/DEVELOPMENT.md and docs/DEPLOYMENT.md still match reality.
9. First real release: tag `v1.0.0` via the `/release` skill and verify the deployed site.

### Acceptance criteria

- [ ] Lighthouse PWA checks pass; app installs on Android and desktop and launches standalone.
- [ ] Airplane mode: calendar, recipes, editing all work; sync and import fail with clear
      Polish messages and recover when back online.
- [ ] Calculator matches Mifflin-St Jeor reference values for test cases (unit test).
- [ ] Export file re-imports cleanly into a fresh profile (manual test recorded).
- [ ] `npm run docker:up` on a clean machine serves the final app with the exact CSP; zero
      console CSP violations across all screens.
- [ ] README covers install, deploy, and disaster recovery (new device, lost password).
- [ ] A `v1.0.0` tag runs the release workflow green and https://eatmyway.gorny.dev serves the
      new version.

## Phase 9 — Daily-use comfort

Post-`v1.0.0`. Everything here came out of the end-user review recorded in STATE.md decisions
58–62; none of it blocks daily use, and none of it may delay the first release.

### Tasks

1. **Grouped library view** `/recipes`: a toggle between the current flat, activity-ranked list
   (decision 46) and a view grouped by tag with section headers and counts („Śniadanie (7)").
   Inside a section the existing ranking applies. Settle open question 11 first: untagged recipes
   get their own section, and a recipe carrying three tags appears under each of them.
2. **Tag management in Settings**: rename (the `label` changes, the `key` is recomputed and
   recipes are rewritten), delete (removed from every recipe), merge two tags into one. `useCount`
   is recomputed after each operation, never patched.
3. **Duplicate a recipe** from the library and from the editor („Zapisz jako kopię") — a deep copy
   with a new id and „ (kopia)" appended to the name. This is the variant workflow (STATE.md
   decision 66): swapping rice for buckwheat already works through „Zmień" on the row, but it
   overwrites the recipe; a copy is what lets both versions exist.
4. **Sort options in the library**: recent activity (today's default), name, kcal per portion.
   The chosen order persists in the meta table.
5. **Reorder ingredient rows** in the recipe editor, following the `reorderMeals` pattern in
   `day.ts` (drag & drop, ~200 ms touch delay).
6. **Smarter fitting to the day's budget** (STATE.md decision 65): suggest a portion size when a
   recipe fits the remaining kcal only below one portion („zmieści się przy 0,75 porcji"), and rank
   by the remaining protein / carbs / fat rather than kcal alone. Both build on the Phase 5 filter.
7. **Shopping-list export** next to the `cookingScale` control in the meal view (decision 62):
   the scaled ingredient list, with the same ingredient summed when the scope covers more than one
   meal. Decide and record before writing code: the scope (meal / day / week), the transport
   (share sheet, clipboard, plain-text download, or an authenticated call to the user's own Home
   Assistant `todo.add_item`), and — if anything talks to a host directly — the `connect-src`
   consequence, which a header baked into the image cannot express for a per-user URL.

### Acceptance criteria

- [ ] The grouped view lists every recipe at least once; a recipe with several tags appears in
      each of its sections and untagged recipes are not lost.
- [ ] Renaming a tag updates every recipe carrying it and leaves no orphaned `key`; merging two
      tags leaves one tag whose `useCount` equals the number of recipes that now carry it (test).
- [ ] A duplicated recipe is independent: editing the copy provably leaves the original and every
      existing `macroSnapshot` untouched.
- [ ] A recipe that exceeds the remaining budget at one portion is offered with the portion that
      fits, and never with a portion that does not.
- [ ] The shopping list sums the same ingredient across meals in the chosen scope and reflects
      `cookingScale`, not `portionsEaten`.
- [ ] The CSP is unchanged, or the widening is recorded in STATE.md and verified with zero console
      violations under `npm run docker:up`.
- [ ] All UI text in Polish; code/comments in English.
