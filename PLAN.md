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
- **One exception, and only one: transcribing a nutrition table off a photographed package**
  (Phase 12). The rule above forbids *invented* values entering a calculation. There, the
  numbers are printed on the package, the user reads and corrects them in the form before
  anything is stored, and what gets saved is an ordinary `custom:*` ingredient whose values
  never change again — so every meal still computes identically. A scanned value that the
  model could not read comes back empty, never as `0`.
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
- Open Food Facts as a later second source for branded Polish products (has CORS — confirmed,
  `access-control-allow-origin: *`). Scoped and scheduled in Phase 12, stage B: a barcode scan
  that fills one custom ingredient, deferred behind a written trigger, and never a bulk import
  into the curated USDA bundle.

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
  updatedAt?: string;      // custom rows only; absent means "written before Phase 10"
}

interface Recipe {
  id: string;
  name: string;
  photoFileId?: string;    // future; separate Drive file
  instructions: string;
  items: RecipeItem[];     // ALWAYS per 1 portion
  tags: string[];          // normalized keys
  sourceUrl?: string;      // the page it was imported from, cleaned of tracking parameters
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

interface MealSlot {
  id: string;
  label: string;           // "Śniadanie" — the user's own wording
  tagKeys: string[];       // ANY of these; empty = any recipe
  share: number;           // share of the day's goal; normalized across slots
}

interface MealPlanTemplate { slots: MealSlot[] }

interface Profile {
  goals: Macros;
  geminiModel: string;
  encryptVault: boolean;
  locale: 'pl';
  googleSub?: string;
  mealPlan?: MealPlanTemplate;  // the planner's day template (Phase 13); absent = the default
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
/ingredients            the user's own ingredients
/settings               settings
/setup                  first-run wizard
```

- **Mobile:** bottom nav (Kalendarz / Przepisy / Składniki / Ustawienia); everything else is bottom sheets
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
- **Ingredients screen:** the user's own (`custom:*`) ingredients, with the number of recipes
  using each; search over the same index the autocomplete uses; a toggle reveals the bundled
  base read-only, where the only action is „Kopiuj i edytuj". Editing and creating happen in a
  bottom sheet over the list, not in a route of their own.
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
      unchanged. *(Measured: the second half holds; „the same draft" does not, for the reason
      below — a link is resolved into text and then imported by a second model call.)*
- [ ] Importing the same text twice yields identical drafts (determinism). *(Measured and **not
      met** — STATE.md decision 153. Everything the app controls is deterministic and asserted
      by tests; the model is not, and two identical pastes differ on household measures. Left
      worded as intended rather than rewritten to what was achieved.)*
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
   Inside a section the existing ranking applies; untagged recipes get their own section, and a
   recipe carrying three tags appears under each of them — so the header counts deliberately sum
   to more than the number of recipes.

   One thing left to settle while building it (STATE.md decision 145): the order of the sections
   themselves — alphabetical, by the tag's `useCount`, or by recent activity. „Bez tagu" goes
   last whichever wins, because it is the absence of a category rather than one of them.
   *Settled while building: the tag's `useCount`, descending — STATE.md decision 157.*
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
6. **Smarter fitting to the day's budget** (STATE.md decisions 65 and 148). Both halves build on
   the Phase 5 filter (`filterByBudget`, `dayBudget`) and both are now settled:

   - **Half a portion is the only suggestion.** A recipe that does not fit whole but fits at half
     is offered as „zmieści się przy pół porcji"; anything that needs less than half is not
     offered at all. One rule, one fraction, nothing to misread on a plate — quarters were
     considered and rejected (decision 148).
   - **The remaining macros are shown, not ranked on.** The sheet header states what is left of
     each goal („zostało 620 kcal · 40 g białka"); the list keeps the decision 46 order. The app
     reports the gap and lets the user choose, rather than recommending a recipe because of it.
7. **Shopping-list export** next to the `cookingScale` control in the meal view (decision 62):
   the scaled ingredient list, with the same ingredient summed when the scope covers more than one
   meal.

   The transport is settled (STATE.md decision 144): **`navigator.share()`, falling back to the
   clipboard** where the browser has no Web Share. Neither is a network request, so **the CSP is
   unchanged** and nothing here may widen it. A direct authenticated call to the user's own Home
   Assistant `todo.add_item` is **rejected** — a per-user host cannot be expressed in a policy
   baked into the image, and the ways around that are worse than the feature.

   What is still to decide, and must be recorded before the code: the **scope** — one meal, a
   whole day or a week — with the same ingredient summed across meals inside it.
   *Settled before the code: all three, with the meal scope in the meal view and the day and
   week scopes in the day screen's menu — STATE.md decision 158.*
8. **Audit the Polish ingredient mapping for silently wrong entries** (STATE.md open question 9
   and decision 143). Not a comfort feature, and worth doing *first* in this phase: it is the
   only item here that changes the numbers the app exists to produce, and every day of use adds
   meals computed from whatever is wrong. The work is data, not code.

   Go through the highest-traffic Polish staples — dairy, meats, groats and rice, bread, flours,
   fats — and compare each bundled per-100 g figure against what that product actually is in
   Poland. A wrong entry is fixed in `data/pl-ingredients.tsv` (a different `fdcId`, a corrected
   Polish name, a misleading alias removed, or the name split into the variants a shopper
   actually distinguishes), then `npm run build:nutrition` regenerates the bundle and
   `DATA_VERSION` is bumped so existing installs re-import.

   The known case to start from: „twaróg" resolves to `172181 Twaróg chudy` at 72 kcal, 10.3 g
   protein and 6.7 g carbohydrate — neither the fat level a Polish shopper means by „twaróg",
   nor a plausible profile for twaróg chudy at all. Frozen `macroSnapshot`s are not rewritten by
   any of this, so the audit corrects the future without touching recorded history.

### Acceptance criteria

- [ ] The grouped view lists every recipe at least once; a recipe with several tags appears in
      each of its sections and untagged recipes are not lost.
- [ ] Renaming a tag updates every recipe carrying it and leaves no orphaned `key`; merging two
      tags leaves one tag whose `useCount` equals the number of recipes that now carry it (test).
- [ ] A duplicated recipe is independent: editing the copy provably leaves the original and every
      existing `macroSnapshot` untouched.
- [ ] A recipe that exceeds the remaining budget at one portion but fits at half is offered as
      „zmieści się przy pół porcji"; one that does not fit at half is not offered at all.
- [ ] The picker header states what is left of every goal macro, and turning the budget filter on
      provably does not reorder the list.
- [ ] The shopping list sums the same ingredient across meals in the chosen scope and reflects
      `cookingScale`, not `portionsEaten`.
- [ ] Every staple the audit examined is recorded in STATE.md as either confirmed or corrected,
      with the „twaróg" case among the corrected ones; `check:nutrition` passes against the
      regenerated bundle and `DATA_VERSION` is bumped.
- [ ] The CSP is unchanged, or the widening is recorded in STATE.md and verified with zero console
      violations under `npm run docker:up`.
- [ ] All UI text in Polish; code/comments in English.

## Phase 10 — Składniki i pełna kopia danych

Custom ingredients already exist and already sync — `source: 'custom'`, decision 53 — but they
can only ever be *created*, from an empty autocomplete inside the recipe editor, and are never
seen again except as a suggestion. A name typed wrong is permanent and pollutes every future
search; a value typed wrong can only be worked around with a `macroOverride` repeated in every
recipe that uses it; `aliases`, indexed since schema v2, has no way of ever being filled. This
phase gives those rows a screen of their own.

Two rules shape every task below.

**Editing is for `custom:*` rows only.** A bundled `usda:*` row must not be edited in place, for
two independent reasons: `importBundledNutrition` writes the whole bundle with `bulkPut`
whenever `NUTRITION_DATA_VERSION` rises, so the edit would be silently overwritten at the next
data refresh; and `syncSnapshot` deliberately uploads nothing but `custom` rows, so the edit
would live on one device while every other one kept the old number. A wrong bundled entry is
fixed in `data/pl-ingredients.tsv` and rebuilt (Phase 9 task 8), not patched locally.

**No operation may change a number without saying so.** Recipe macros are computed live from
the ingredient table, but a planned meal holds a frozen `macroSnapshot`, and the only path that
rewrites one is `refreshFutureSnapshots`. Anything here that moves a recipe's per-portion macros
must therefore raise the same „zaktualizować przyszłe dni?" question a recipe edit raises, or
the recipe screen and the calendar will quietly disagree.

The backup rides along (task 9) because it is the same subject seen from the other end: this
phase is about the user's own data being editable, correctable and recoverable, and an export
that leaves out the one thing nobody can retype from memory is none of those. The comfort
items reported alongside it are Phase 11.

### Tasks

1. **`/ingredients` screen, a fourth item in the navigation** (bottom nav on mobile, sidebar on
   desktop). It lists the user's own ingredients with name, `state`, per-100 g kcal and the
   number of recipes using each — all four already available from `ingredientSearchIndex()`,
   which returns the wire-shape ingredient alongside its `useCount`, so the list needs no new
   query. A search field reuses `rankCandidates`, so the screen ranks exactly like the
   autocomplete does. „Nowy składnik" creates one from here, which is what makes the existing
   form reachable outside the recipe editor.

2. **Editing a custom ingredient**, in a bottom sheet over the list: name, `state`, the four
   per-100 g values, and — new — `aliases`, which improves both the autocomplete and Gemini's
   ingredient matching and until now could not be filled at all. `CustomIngredientForm` is
   extended rather than duplicated: the recipe editor keeps calling it for creation, the new
   screen calls it for both.

3. **The bundled base is visible but read-only, behind a toggle** („Pokaż składniki z bazy"),
   with exactly one action on such a row: **„Kopiuj i edytuj"**, which opens the form seeded
   with the source's values and `state`, a name of „<nazwa> (kopia)" and **no aliases**, and
   saves a fresh `custom:<uuid>`. Copying the aliases would put two rows with the same alias
   into one autocomplete and into Gemini's candidate list, which is the failure this phase is
   supposed to reduce, not create. The copy carries no link back to its source: `Ingredient`
   stays the shape it is.

4. **Every macro field must be filled before an ingredient can be saved; `0` counts as filled.**
   Today `CustomIngredientForm` maps an untouched field to `0`, so an ingredient saved „to
   finish later" reads as 0 kcal in every recipe that uses it and nothing ever says so. The
   draft therefore holds `number | null` (the decision-54 pattern) and saving stays disabled,
   with a stated reason, until the name and all four numbers are present. This changes the
   existing creation path in the recipe editor too, on purpose.

5. **A macro change asks the same question a recipe edit asks.** After the four values change,
   find the recipes using the ingredient, count the planned meals from today onwards, and offer
   „zaktualizuj przyszłe dni" — running `refreshFutureSnapshots` for each affected recipe.
   Declining leaves every snapshot alone. Days before today are never touched, by the same rule
   that governs a recipe edit. A change to name, `state` or aliases alone moves no number and
   raises no question.

6. **Deleting is either free or a replacement — never a silent zero.** `deleteIngredient` is new
   and refuses, in the repository and not only in the UI, to remove an ingredient a recipe still
   refers to: an item pointing at a missing id falls back to `ZERO_MACROS`, which would drop a
   recipe's numbers without a word.

   - **Nothing uses it** → a plain confirmation, and it is gone.
   - **Something uses it** → the dialog names **every** recipe that does, each a link into its
     editor, and offers „Zastąp innym składnikiem" as the primary action: an autocomplete picks
     the replacement, one transaction rewrites `ingredientId` in every matching item across
     every recipe, and the old row is then deleted. The rest of each item — `amount`, `unit`,
     `gramsPerUnit`, any `macroOverride` — is left exactly as it was; only the identity changes.
     Affected recipes get a new `updatedAt`, and the whole operation ends in the task-5
     question, because a replacement is a macro change.
   - **Deleting an in-use ingredient without replacing it is not offered at all.** The recipe
     list is the manual way out; when the last use is gone, the cheap path appears by itself.

7. **Corrections must not outlive what they point at.** `corrections` maps a normalized Polish
   name to an ingredient id and `resolveName` trusts it without checking that the id still
   resolves, so a deleted ingredient would leave the next Gemini import matching a name to
   nothing. A replacement repoints every correction to the new id; a plain delete removes the
   corrections that named the deleted row.

8. **`Ingredient` gains an optional `updatedAt`, and the ingredient merge stops preferring the
   local copy.** Custom ingredients are resolved with `localWins`, whose comment states the
   premise this phase removes: „entities that are only ever added to". Once they are editable,
   two devices that both edited one row would silently keep whichever synced last, with no
   conflict and no prompt. Every write from this phase stamps `updatedAt`, the resolver becomes
   the timestamped one recipes already use, and a row with no timestamp counts as the older
   side. The field is not indexed, so Dexie needs no new schema version and no migration; rows
   written before this phase stay valid and simply lose to any edited copy.

9. **The backup carries everything, including the vault.** „Kopia danych" is the way out for a
   user who does not sync, and it currently leaves out the one thing that cannot be recreated
   from memory: the Gemini API key. Decision 137 kept the vault out of the file; that is
   reversed here, because a copy the user has to complete by hand afterwards is not a copy, and
   because `syncSnapshot` already carries `vaultFile` verbatim to Drive — the exclusion only
   ever weakened the offline path.

   The file gains `vault` (the raw `vaultFile` text, exactly as the device holds it) and
   `settings` (`recipeSort`, `recipeGrouped`). Everything else it needs is already there:
   goals, the model, the encryption flag and the locale all live in `profile`.

   What it still must not carry, each for its own reason: the bundled USDA rows (they belong to
   the build and are re-imported on first run), `deviceId` (it keys the per-device Gemini tally,
   and two devices sharing one id would corrupt a counter that merges by taking the larger
   value), `driveAccountLabel` (it describes a connection the restoring device may not have),
   and the sync bookkeeping — `syncBaseline` and `driveFiles` — which `restoreBackup` already
   clears, and which would otherwise let the next merge read a restored row as a deletion.

   Restoring a vault reuses the swap that already exists: the previous `vaultFile` is kept in
   `vaultFileReplaced` (decisions 93 and 150) so the exchange can be undone, which matters
   precisely because the restored vault may carry a different master password and cannot then
   be opened on this device at all. `googleSub` from the file is **not** adopted over a
   `googleSub` this device already has, so restoring a copy onto a machine connected to another
   account does not fake the wrong-account check.

   `BACKUP_VERSION` stays at 1, by the rule the file itself states: an older build reading a
   newer file drops sections it does not know, which is incomplete, not wrong — and refusing
   the whole file would take a user's recipes away to protect them from missing a key.

   The export must say, at the moment of export and not in small print, what the file now
   holds: with vault encryption on, the key travels encrypted and the restore asks for nothing
   extra; with encryption **off**, the key is in the file in the clear and the file must be
   treated like a password.

10. **Sync and merge coverage for what this phase introduces**: an edited ingredient converging
    on the newer copy rather than the local one; a deletion propagating to the other device
    instead of being resurrected by it — `applyMergedData` already treats the merged custom map
    as the complete picture and deletes anything missing from it, which is the behaviour to pin
    down with a test; and a replacement arriving as a recipe change and an ingredient deletion
    in the same sync.

### Acceptance criteria

- [ ] The screen lists every `custom:*` ingredient with a correct count of the recipes using it,
      and the count matches what the recipe editor's autocomplete reports.
- [ ] A `usda:*` row offers no way to change its values; „Kopiuj i edytuj" produces a `custom:*`
      row that survives a forced re-import of the bundle, and the original is untouched.
- [ ] An ingredient cannot be saved with any macro field left blank, and an explicitly entered
      `0` saves — including from the recipe editor's creation path.
- [ ] Changing an ingredient's macros offers „zaktualizuj przyszłe dni"; accepting rewrites the
      snapshots of every affected recipe from today onwards, declining rewrites none, and days
      before today are provably unchanged either way (test).
- [ ] Deleting an unused ingredient needs one confirmation; deleting a used one lists every
      recipe that uses it and cannot proceed without a replacement, including when attempted
      through the repository directly.
- [ ] After a replacement, no recipe item refers to the old id, every `amount`, `unit`,
      `gramsPerUnit` and `macroOverride` is unchanged, and no correction points at the deleted
      ingredient (test).
- [ ] Two devices editing the same custom ingredient converge on the newer edit, and a deletion
      on one device is not resurrected by the other (merge tests).
- [ ] A backup taken on one device and restored on an empty one reproduces the recipes, the
      custom ingredients, the days, the goals, the model, the list settings and the Gemini key,
      with no step left for the user beyond entering the master password when the key is first
      needed.
- [ ] Restoring a backup whose vault has a different master password can be undone, and the
      device's own `googleSub`, `deviceId` and Drive account label survive the restore.
- [ ] Exporting with vault encryption off states plainly that the file contains the API key in
      the clear; exporting with it on states that the key travels encrypted.
- [ ] A file exported by this version still restores in a build that predates it, minus the
      sections that build does not know.
- [ ] The CSP is unchanged, or the widening is recorded in STATE.md and verified with zero
      console violations under `npm run docker:up`.
- [ ] All UI text in Polish; code/comments in English.

## Phase 11 — What daily use reported

Seven things reported from real use after 1.0. They are grouped into one phase because they
share a shape rather than a subject: each is a place where the app is doing the right thing and
saying the wrong one, or saying nothing at all. None of them touches a stored number, which is
what separates them from Phase 10 and lets them be built in any order.

Three of them — the install box, the missing wizard and the API-key address that is not a link
— name something the user cannot reach from where they are standing. One is the app doing long
work in silence. Two are comfort it never offered: a dark theme, and the way back to the page a
recipe came from. The last one is not in the app at all: the repository's own About box, empty
since the first commit.

### Tasks

1. **The install box says nothing when it has nothing to offer.** Reported from real use: on
   Android the section explains how to install the app while no „Zainstaluj aplikację" button
   appears, so the screen is a dead end that reads like a broken feature. The section renders
   only when it can actually offer something — the captured prompt, or the iOS instruction
   („Udostępnij → Do ekranu początkowego"), which is genuinely actionable — and renders
   nothing otherwise. iOS is recognised without a UA string by `'standalone' in navigator`,
   the same signal `isStandalone()` already uses. The offline note is not install advice and
   stays when it is true.

   **And fix the reason the button was missing, once it is known.** Reported against Chrome on
   Android at https://eatmyway.gorny.dev, which is the case that cannot be explained away:
   `beforeinstallprompt` is Chromium's own event, so a missing button there is either a
   condition Chrome deliberately imposes or a real installability failure. The static
   configuration has already been checked and is **not** the cause (STATE.md decision 190), so
   the phase starts from the device, in this order:

   - **Rule out the two conditions Chrome imposes by design.** It fires the event in neither an
     incognito tab nor for an app that is already installed — and in the second case the tab
     also fails `display-mode: standalone`, so today's copy tells a user who *has* installed
     the app that their browser cannot install it. A normal tab and a device with no Eat My
     Way icon are the baseline for every check below.
   - **Read the browser's own verdict** rather than guessing: Lighthouse's installability
     audit against the live URL, and `chrome://inspect` from a desktop for the console of the
     real tab. Chrome states which criterion fails, if one does.
   - **Then fix what it names.** A failing criterion is a bug in the manifest, the icons or the
     service worker and is fixed here; Chrome's engagement heuristic (the event can wait for a
     real visit rather than the first paint) is not a bug and is recorded as the answer.

   Whatever the verdict, the „already installed, opened in a tab" state gets its own copy
   instead of the dead-end sentence — best-effort, via `navigator.getInstalledRelatedApps()`
   where the browser has it, and by saying nothing where it does not.

2. **The first-run wizard also opens on a database that has never been used.** Today it is
   gated on one thing only — a sync that found an empty `appDataFolder` — so a user who never
   connects Drive never sees it, and lands on the calendar with default goals of
   2000/100/250/70, no Gemini key, and nothing having asked. That is PLAN.md's own condition
   working as written, and it is a gap that grew with task 9: the user without Drive is
   exactly the user the export exists for.

   The wizard therefore also opens when the local database has never been used — no recipes,
   no days, no vault, and a profile still identical to `DEFAULT_PROFILE` — and the Drive step
   becomes skippable („Pominę na razie"), leaving goals and the optional Gemini key.

   Two details decide whether this is an improvement or an irritation:

   - **It must not greet a device that is about to pull an account.** A second device is also
     „never used" for the few seconds before its first sync lands, so the local trigger waits
     until `resumeSync()` has had its say; a sync that pulls data cancels the wizard.
   - **Skipping must stick.** The Drive-driven flag lives in memory and is cleared by the
     wizard, which is enough when a sync sets it every time. A locally triggered wizard needs
     a `meta` key instead, or every reload reopens it. `meta` never travels to Drive, which is
     right here: it records that *this browser* has been through the wizard.

3. **Connecting to Drive must look like work in progress, not like a dead button.** Reported
   from real use: signing in and syncing announce themselves with one grey line
   („Synchronizacja z Dyskiem…"), while the buttons that started it merely go to
   `opacity-50`. A dimmed button with static text is indistinguishable from a broken one, and
   the first sync after connecting is the longest one the app ever runs.

   - **A shared spinner component**, used in the sync indicator, in the Drive status row and
     inside the buttons that are working. It animates from a class in the bundled stylesheet,
     never an inline `style` — the production CSP has no `'unsafe-inline'` for styles
     (decision 71) — carries `aria-hidden="true"` so the live region is not read twice, and
     stands still under `prefers-reduced-motion`.
   - **Feedback where the user is looking.** „Połącz Dysk Google" and „Synchronizuj teraz"
     keep their place and show the spinner with a label of their own („Łączenie…",
     „Synchronizacja…") instead of only dimming.
   - **Name the step, since there is no percentage to show.** Drive reports no totals, but the
     two stages are distinguishable and feel different: waiting on the Google window, and
     then reading and writing the account's files. `SyncPhase` (or a label beside it) gains
     that distinction, and the connect path sets it around the backend's `authenticate` call.
   - **A finished sync stays silent.** The indicator's existing rule holds — a badge that is
     always lit is one nobody reads. What changes is how loud „in progress" is, not how long
     it lasts.

4. **A dark theme, chosen in Settings.** The groundwork is already done and that is what keeps
   this small: every colour in the app comes from seven tokens in `@theme` (`src/app.css`), so
   a dark theme is those seven redefined under `:root[data-theme="dark"]` in `@layer base` —
   plain CSS in the bundled stylesheet, which the production CSP allows and an inline `style`
   would not.

   - **Three choices**: „Jasny", „Ciemny", „Jak system", with the system setting as the
     default and `prefers-color-scheme` deciding it.
   - **Stored in `meta`, not in `Profile`**, by the same argument that put `recipeSort` there:
     how a screen is drawn belongs to the device in front of you, not to the account. It
     therefore travels in the backup's `settings` section (Phase 10 task 9) and never to Drive.
   - **Applied before the first paint.** This CSP allows no inline bootstrap script, so
     `main.ts` is the earliest possible point; the choice is mirrored into `localStorage` —
     every access wrapped, as decision 173 requires — so that read is synchronous, while
     IndexedDB stays the source of truth.
   - **`index.html` hardcodes `<meta name="color-scheme" content="light">` and a light
     `theme-color`.** Both have to follow the theme, or the browser's own chrome, its form
     controls and its scrollbars stay light around a dark app.
   - **Re-check, do not assume, every colour that is not a token**: `--color-ink-muted` at 52%
     lightness fails on a dark surface, and the literal Tailwind colours in the app — the
     amber warnings, the red delete button, the dialogs' `backdrop:bg-black/40` — plus the
     SVG bars and rings that carry their own fills, all need looking at.
   - Verified in the container under the production CSP, not with `npm run dev`, because a
     stylesheet is exactly what `dev` does not test faithfully.

5. **An imported recipe remembers where it came from.** `importRecipe` is handed the link, uses
   it, and drops it: `ImportedRecipe` has no field for it, so a recipe that came from a page
   can never be traced back to that page. `Recipe` gains an optional `sourceUrl`, which the
   editor fills when the import began with a link and leaves empty when it began with pasted
   text or with a hand-written recipe. Being optional, it costs no schema version, no
   migration, and nothing in the Drive format: `readRecipesDocument` keeps the fields it does
   not know, and the backup carries recipes verbatim.

   Shown as a „Źródło" row in the recipe editor and in the meal view's recipe section, as a
   link the user can follow back to the original — and can also clear, because a recipe edited
   beyond recognition no longer comes from anywhere. It shows the **host**, not the whole URL:
   a 200-character link is unreadable on a phone. `target="_blank"` with
   `rel="noopener noreferrer"`.

   **The URL is cleaned before it is stored**, by a `cleanSourceUrl` beside `normalizeUrl` in
   `gemini/parse.ts`, with unit tests:

   - A **deny-list**, never an allow-list: `utm_*` and the known click ids — `fbclid`,
     `gclid`, `dclid`, `msclkid`, `twclid`, `yclid`, `igshid`, `mc_cid`, `mc_eid`, `_ga`,
     `ref_src`, `si`. Anything else stays. A query parameter is often the recipe's identity
     (`?p=1234`), so dropping what we do not recognise would break the link the row exists to
     offer.
   - The path is never rewritten and the fragment is kept — `#skladniki` is part of where the
     recipe is on the page.
   - **Only `http` and `https` are ever stored.** The value comes from something the user
     pasted and ends up in an `href`, so any other scheme is refused outright rather than
     rendered.

6. **The Gemini key field links to where a key is made.** Both screens that ask for the key name
   the address and neither makes it clickable: Settings says „Klucz utworzysz w Google AI Studio
   (aistudio.google.com)" as plain text, and the wizard's step 4 puts
   `aistudio.google.com/apikey` in a `<span>`. PLAN.md's own wizard spec asks for „link to AI
   Studio" (Screens & navigation, first-run wizard step 4), so this is an unrecorded deviation
   being closed rather than a new feature.

   Both become real links to **`https://aistudio.google.com/apikey`** — the page that creates a
   key, not the studio's front door, where finding it is a further hunt. Same treatment as the
   recipe source row in task 5: `target="_blank"` with `rel="noopener noreferrer"`, placed
   directly under the input, which is where someone is standing when they discover they have no
   key. This widens nothing in the CSP: the policy governs what the page loads and connects to,
   not where a link may take the browser.

7. **Fill in the repository's About box on GitHub.** `zyndata/eat-my-way` has an empty
   description, an empty homepage and no topics, so the one panel every visitor reads before
   the README says nothing at all — and the deployed app is not linked from anywhere on the
   page. Set all three: a one-line description drawn from the README's own opening sentence
   rather than newly invented, so the two never drift apart; the homepage to
   `https://eatmyway.gorny.dev`; and topics that describe what it actually is (`pwa`, `svelte`,
   `typescript`, `indexeddb`, `meal-planner`, `offline-first`).

   The description is in **English**, like the README and unlike the app: the interface is
   Polish, the repository is a public codebase and its documentation has been English
   throughout. Repository metadata is not in the build, so this is one `gh repo edit` recorded
   in STATE.md — not a code change, and nothing here ships in a tag.

### Acceptance criteria

- [x] On a browser that offers no install prompt and is not iOS, the settings screen shows no
      install instructions at all; on iOS the „Do ekranu początkowego" instruction is still
      there, and where the prompt exists the button still works.
      *(Verified in full, on the reporting device. The button appears on Chrome on Android
      against v1.1.0 and installs the app — so no installability criterion was ever failing and
      the original report was a transient state — and the „already installed, opened in a tab"
      line shows afterwards. STATE.md decisions 219 and 220.)*
- [x] A fresh browser profile with no Drive connection reaches the wizard, can skip the Drive
      step, and does not see it again after skipping — while a second device that syncs an
      existing account is never sent there.
- [x] Connecting Drive shows moving feedback on the button that was pressed, names the stage it
      is in, and leaves nothing lit once the sync finishes; the animation stops under
      `prefers-reduced-motion` and the status is announced once, not twice.
- [x] The theme choice survives a reload and is applied before the first paint, „Jak system"
      follows the OS setting live, and the browser chrome, form controls and scrollbars are
      dark alongside the app.
- [x] Every screen is legible in the dark theme, including the amber sync warnings, the red
      delete button, the macro bars and rings, and the modal backdrops — checked under
      `npm run docker:up` with zero CSP violations.
- [x] A recipe imported from a link stores its cleaned source and offers it as a link showing
      the host; one imported from pasted text or written by hand shows no source row, and the
      row can be cleared.
- [x] `cleanSourceUrl` strips `utm_*` and the known click ids while leaving every other
      parameter, the path and the fragment untouched, and refuses any scheme that is not
      `http`/`https` (tests).
- [x] Both the settings key field and the wizard's key step offer a working link straight to
      the AI Studio page that creates a key.
- [x] The GitHub repository shows a description, a homepage pointing at the live app, and
      topics; the description says the same thing as the README's opening line.
- [x] The CSP is unchanged, or the widening is recorded in STATE.md and verified with zero
      console violations under `npm run docker:up`.
- [x] All UI text in Polish; code/comments in English.

## Phase 12 — Skanowanie opakowania

Adding a custom ingredient means typing five things off the back of a package: a name and four
numbers that are already printed, in a fixed layout, on every product sold in the EU. The
phone that would type them has a camera pointed at the table. This phase makes the camera do
it — the user photographs the nutrition table, the fields fill themselves, and what could not
be read stays empty.

**The phase ships in two stages, and the second one may never be built.** Stage A reads the
printed table with the Gemini key the app already holds; stage B adds a barcode scan against
Open Food Facts as a free shortcut for packaged products. A is first because it covers every
package — every product has a table, not every product is in a database — and because it needs
no new dependency, no new host in the CSP and no camera permission. B is deferred behind a
condition stated below rather than a date, because its whole value is saving Gemini requests,
and nobody yet knows whether those requests are scarce in practice.

**One rule from this document is being bent, and this is the record of it.** „Gemini … returns
structured JSON … **never nutrition numbers** (repeatability beats plausibility; the same meal
must always compute identically)" — see the Gemini section. That rule protects a specific
thing: a recipe's macros must not depend on what a model guessed on a given day. It is not
bent here, because nothing in this phase computes anything. Gemini is asked to **transcribe
numbers that are printed on a package**, into a form the user reads, corrects and saves once.
After the save the ingredient is an ordinary `custom:*` row with fixed values, and every meal
using it computes deterministically forever. The prohibition is on *invented* values entering
a calculation; a transcription the user confirms before it is stored is a different act. The
Gemini section is amended to say so, rather than left to contradict this phase.

### Stage A — the photo (built in this phase)

#### Tasks

1. **A „Zeskanuj opakowanie" button in the ingredient form.** `CustomIngredientForm.svelte` is
   used from two places and owns no I/O of its own (its own header comment), so the scan
   follows that: the form renders the button and the result, and the caller supplies the
   function that performs it. That keeps the recipe editor's inline use and „Składniki"'s
   bottom sheet on one code path, and keeps the form testable without a network.

   The camera is reached with `<input type="file" accept="image/*" capture="environment">`,
   **not** `getUserMedia`. On a phone that opens the system camera, with framing, focus and a
   confirm step already built and better than anything we would write; on a laptop it opens a
   file picker, which is the honest behaviour there — a webcam pointed at a package by hand
   photographs a blurred one. It also asks nothing of `Permissions-Policy`, whose `camera=()`
   in the `Caddyfile` governs `getUserMedia`. **That last claim is verified under
   `npm run docker:up` before the task is called done, not assumed** — `npm run dev` applies
   no CSP and no permissions policy, and this is exactly the class of thing it fails to test.

2. **The photo is downscaled in the browser before it is sent.** A modern phone camera
   produces 3–12 MB; the readable part is a table occupying a fraction of it. A canvas
   resample to at most 1024 px on the long edge and JPEG at ~0.8 keeps the digits legible,
   cuts the upload to a couple of hundred kilobytes and holds the image cost near the
   per-image floor Google charges. `img-src` already allows `blob:` and `data:`, so the
   preview needs no CSP change either. The original file is never stored — not in IndexedDB,
   not on Drive.

3. **`gemini/client.ts` learns to send an image.** The request gains an optional image part
   alongside `prompt`, sent as `inlineData: { mimeType, data }` in the same `parts` array. Every
   existing rule of that module holds unchanged and is the reason it is extended rather than
   duplicated: the key travels in `x-goog-api-key`, no response body is ever quoted into an
   error, the `DETERMINISTIC` config still applies, and the polish error sentences already map
   every status this call can return. `connect-src` already permits
   `generativelanguage.googleapis.com` — **this feature widens the CSP nowhere.**

4. **`gemini/scan.ts`, beside `parse.ts` and `match.ts`.** The prompt, the `responseSchema` and
   a pure reader that turns the answer into an `IngredientDraft`, following the shape those two
   modules already established: the model returns JSON, and the deterministic half lives on
   this side of the call, in functions with unit tests and no network.

   What the prompt has to get right is not the OCR — it is the label:

   - **The „w 100 g" column, never „na porcję" and never „%RWS".** Polish labels routinely
     print all three side by side, and the app's whole data model is per 100 g
     (STATE.md decision 53).
   - **kcal, not kJ.** EU labels lead with kilojoules; `2252 kJ / 539 kcal` must yield 539.
   - **„w tym cukry" and „w tym kwasy nasycone" are sub-entries**, not macros of their own. A
     naive read puts sugars into carbohydrates twice.
   - **Decimal comma**, and a value that is a range or „<0,5" resolves to the number a person
     would write.
   - **The product name from the front of the pack**, not the legal designation in six-point
     type.
   - **`state` is never guessed.** Raw versus cooked is not on a label; it stays the user's
     choice, defaulting as the form already defaults.

   And one rule that outranks all of them: **a field that could not be read comes back `null`,
   never `0`.** `IngredientDraft` already models the four macros as `number | null` precisely
   because „nie wpisano" and „zero" are different facts (decision 178), and a scan that
   silently returned `0` would recreate the exact bug that decision fixed, with a photograph as
   the alibi. The reader enforces this on the way out of the model, whatever the model sent:
   anything not a finite non-negative number becomes `null`.

5. **The result is a proposal, not a save.** The scan writes into the draft the user is looking
   at, the scanned fields are visibly marked as coming from the scan, and nothing is persisted
   until the ordinary „Zapisz składnik" is pressed. `draftProblem` is left exactly as it is:
   a partial scan leaves the button disabled with the sentence it already prints, which is the
   behaviour the user asked for — fewer fields to type, no fields silently invented. A second
   scan replaces the proposal; a field the user has edited by hand is not overwritten by it.

6. **It costs one request, and the app says so.** `REQUESTS_PER_IMPORT` in `gemini/usage.ts`
   gains a `scan: 1` entry so the counter keeps telling the truth about a budget that can be as
   small as 20 requests a day per model (decision 129), and the scan is reported through
   `onusage` on any answered call, including one whose parsing later fails — the same rule as
   decision 127. The three states that make this feature unavailable are handled where they
   occur rather than as a generic failure: **no key** sends the user to Settings, a **locked
   vault** goes through `requestUnlock()` like every other secret-using path, and **offline**
   says so through `isOffline()` and points out that the rest of the form still works.

7. **The user is told where the photograph goes, before they take it.** One line under the
   button: the photo is sent to Google's Gemini API with the user's own key, only when the
   button is pressed, and is not stored anywhere. This app holds credentials and its README
   makes claims about what it sends where; a feature that uploads a picture of something on
   your kitchen table does not get to be quiet about it. SECURITY.md gains the same sentence.

8. **Tests.** The reader and the normaliser are pure and get unit tests, including the cases
   the prompt is written against: kJ-only labels, a per-portion column present, sugars nested
   under carbohydrates, a comma decimal, a missing protein row (→ `null`, not `0`), and a
   model that answers with a string where a number belongs. The end-to-end path reuses
   `e2e/fake-gemini.ts` with a fixture answer, so CI never photographs anything and never
   spends a request.

#### Acceptance criteria

- [x] On a phone, „Zeskanuj opakowanie" opens the camera, and a photograph of a Polish
      nutrition table fills the name and the four macros with the values from the „w 100 g"
      column. — confirmed on Android 2026-09-04: the button opens the system camera, and a
      photographed carton filled the fields. STATE.md decisions 253–255.
- [x] A label that prints kilojoules first yields kilocalories; a label with a per-portion
      column next to the per-100 g one yields the per-100 g values. — verified 2026-09-04 with
      a live key against a real package printing „1207 kJ / 293 kcal" over a per-100 ml column,
      in four languages and rotated 90°: twelve calls across six models, every one 4/4 correct,
      and no invented product name. STATE.md decision 254.
- [x] A value the model could not read leaves its field empty, the save button stays disabled,
      and the form prints the reason it already prints — no field is ever filled with `0` by a
      scan.
- [x] Nothing is written to IndexedDB until „Zapisz składnik"; the photograph is not stored at
      all.
- [x] The scan counts as one request in the Gemini usage counter, including when the answer
      fails to parse.
- [x] With no key, a locked vault, or no network, the button explains which of the three it is
      and the rest of the form keeps working.
- [x] Verified under `npm run docker:up` with zero CSP or permissions-policy violations in the
      console, and **the `Caddyfile` is unchanged** — if it turns out it cannot be, the widening
      is recorded in STATE.md first.
- [x] All UI text in Polish; code and comments in English.

### Stage B — the barcode (deferred, with a written trigger)

Not built in this phase. It is written down here so that the decision to build it is a decision
about evidence rather than a fresh design session.

**The trigger.** Stage B is built when stage A is in daily use and one of these is true, each
recorded in STATE.md when observed: the free daily Gemini budget is actually being hit while
adding ingredients; the round trip is slow enough to be annoying at the shop shelf; or the
photo path proves unreliable on a class of packages (foil, curved, glossy) common enough to
matter. Absent those, stage A is the whole feature and B is a thing not to maintain.

**What it would be.** The camera reads an EAN, and the app looks it up in Open Food Facts —
the second nutrition source this document has planned since before 1.0 (see „Nutrition data",
and STATE.md open question 9a). Scoped to this one screen: it fills a `custom:*` draft, and it
does **not** bulk-import anything into the bundled USDA database, which stays curated.

**What was measured while planning, so it is not researched twice** (2026-09-04):

- `GET https://world.openfoodfacts.org/api/v2/product/<ean>.json` answers
  `access-control-allow-origin: *` — usable straight from the browser, no key, no proxy.
- The fields map onto `Macros` one-to-one: `energy-kcal_100g`, `proteins_100g` (plural),
  `carbohydrates_100g`, `fat_100g`, plus `product_name` and `brands`. Verified on a real
  Polish product (Masło extra, Mlekovita, EAN 5900512300108).
- Coverage: about **37 200** products tagged `countries_tags=poland`. Enough for supermarket
  staples, not enough to be the only path — which is the argument for A first.
- Limits: 15 read requests per minute per IP; a descriptive `User-Agent` is requested but a
  browser cannot set that header, so identification goes in `app_name` / `app_version` query
  parameters.
- The data is volunteer-entered and sometimes wrong, so it arrives as a proposal to be checked,
  under exactly the same rule as stage A: nothing is saved until the user presses save.

**What it would cost, and why that is not free.** `BarcodeDetector` exists in Chromium and in
**neither Safari/iOS nor Firefox**, so a cross-platform scan needs a WebAssembly decoder —
a new dependency in an app whose rule is that every package must justify itself. Aiming a
camera at a barcode needs a live preview, so this is the stage that requires `getUserMedia`
and therefore `Permissions-Policy: camera=(self)` in the `Caddyfile`, plus
`connect-src https://world.openfoodfacts.org` — two CSP-adjacent widenings, against zero for
stage A. Note also that `getUserMedia` needs a secure context: production and `localhost` are
fine, but testing from a phone against `http://<LAN-ip>:8080` will not work.

**What was rejected outright.** Local OCR with tesseract.js: measured at ~4.75 MB for the WASM
core plus ~4.77 MB for `pol.traineddata`, about **10 MB** of assets to download and cache in an
app whose entire precache is currently measured in hundreds of kilobytes — and in exchange, a
weaker read of a tabular layout than either path above, plus a table parser of our own to
maintain. Offline operation without a key is its only advantage, and it is not worth that
price. Recorded so it is not re-proposed.

## Phase 13 — Planer posiłków

Planning a day is the one part of this app that is still entirely manual. The calendar, the
recipe library and the goals are all in place, and the user still has to sit down, remember
what they ate last week, pick four recipes and check by hand whether the four add up to the
numbers in Settings. On a normal weekday that does not happen — the day ends up with two meals
entered in a hurry, or with none.

This phase makes the app answer the question it already has all the data for: **given my
goals, my recipes and what I have already eaten, what should the rest of the day look like?**
The user presses one button and gets a *proposal* — never a silent write — which they can
reroll, lock slot by slot, and accept.

**It is a selection problem, not a filter.** Recipes have fixed per-portion macros, so no
subset of a few dozen of them lands on a kcal target by itself. The knob that makes it solvable
is already in the data model: `portionsEaten` scales macros without touching the recipe. The
planner therefore chooses **a recipe and a portion count** per slot, and the portion count is
restricted to 0.5–2.0 in steps of 0.25 — outside that range the answer stops being something a
person would actually cook and eat.

### The three rules the solver obeys

1. **Calories first, the rest second.** kcal is the target; protein, carbohydrate and fat are
   tie-breakers between plans that already fit on calories, weighted well below it. This is a
   deliberate reversal of the symmetric "±X% on all four" design, and it is the user's call
   (STATE.md decision on 2026-09-04): a plan that hits the calorie target and is 12 g off on
   fat is a good plan; one that balances all four and misses by 400 kcal is not.

2. **The week is the unit of accounting, the day is the unit of sanity.** What must be close to
   the goal is the **weekly average**, not every individual day — that is how eating actually
   works, and it is what makes the solver succeed instead of shrugging. So: the weekly mean is
   the objective, and each day carries a **hard band of ±15%** around its own goal, so that
   "the average is fine" can never be bought with a 3000 kcal day beside a 1000 kcal one.

   A day planned on its own is not exempt from this. Its target is the daily goal **corrected by
   the balance of the week it falls in**: what the already-planned days of that week (Monday
   first — `weekStart`, decision 74) came to against what they should have, spread over the
   days of the week still unplanned, and clamped to ±10% of the daily goal so one heavy Sunday
   cannot starve the following Tuesday. The sheet says so in one line, in Polish, rather than
   silently moving the target.

3. **Freshness beats a perfect fit.** A plan that nails the numbers by proposing the same three
   dinners as last week is a worse answer than one that is 40 kcal off. Repetition is a cost,
   not a constraint: a recipe planned yesterday is very expensive, one planned ten days ago is
   nearly free, and one never planned is free. The data for it needs no new query —
   `recipeUsage(today)` already returns `lastPlannedDate` per recipe over a one-year window
   **including days planned ahead**, so a proposal also avoids colliding with what is already
   on the calendar for tomorrow. Within one day, the same recipe twice is forbidden outright.

### The template

The rules the planner follows are a **day template**, edited in Settings as rows — not as a
typed mini-language. One row per meal:

| Slot | Tagi | Udział |
|------|------|--------|
| Śniadanie | `owsianka`, `szybkie` | 25% |
| Obiad | `mięsne`, `wege` | 40% |
| Podwieczorek | `przekąska` | 10% |
| Kolacja | `lekkie` | 25% |

Tags within a row are alternatives — "any of these" — which is the semantics originally asked
for as `tag1, tag2; tag3; tag4`. It is stored that way and shown as rows, because a delimiter
that changes meaning between comma and semicolon is invisible in a text field and the app
already owns `TagInput.svelte` with tag autocompletion. A row with no tags means "any recipe".

**The share column is not decoration.** Without it the solver is free to put 1200 kcal into
breakfast and 300 into dinner and still claim the day is correct. Shares default to an even
split, are normalized rather than validated (three rows of 30% mean 33.3% each), and are a soft
cost, not a constraint.

### Data model

```ts
interface MealSlot {
  id: string;
  label: string;       // "Śniadanie" — the user's own wording, Polish
  tagKeys: string[];   // ANY of these; empty = any recipe
  share: number;       // share of the day's goal; normalized across slots
}

interface MealPlanTemplate { slots: MealSlot[] }

interface Profile { /* … */ mealPlan?: MealPlanTemplate }
```

`mealPlan` is **optional**, for the same reason `sourceUrl` and `Ingredient.updatedAt` are: it
costs no schema version, no migration and nothing in the Drive format, because
`readProfileDocument` keeps the fields it does not know. A profile without it gets the built-in
default template (four slots, 25/40/10/25) the first time the planner is opened.

Nothing is added to `PlannedMeal`. A meal does not know which slot it came from, and giving it
one would be a schema change, a sync concern and a migration in exchange for a label — the
sheet maps existing meals to slots **by position** and lets the user move them before
generating. That mapping is a UI concern that lives and dies inside one sheet.

**Excluded from planning, with no new field:** a recipe tagged `nie-planuj`. Exclusion is a
property the tag system already expresses, and it needs no column, no migration and no
settings screen.

### Tasks

1. **`src/lib/planner.ts` — the whole solver, pure.** No I/O, no clock, no database, in the
   shape `day.ts`, `goals.ts` and `calendar.ts` already established. It takes candidate recipes
   with their per-portion macros, a template, a per-day target, a usage map and a random source;
   it returns a proposal or a typed failure. Every rule above is a function with a unit test.

   **Randomness is injected, exactly as `IdFactory` is** (`ids.ts`): the tests pass a seeded
   generator and assert exact output, the UI passes `Math.random` and gets a different answer
   on every „Losuj ponownie". A solver that cannot be pinned in a test is a solver nobody can
   change later.

   The search is a randomized greedy with restarts: a few hundred draws, each filling every
   slot with a candidate sampled with probability weighted by fit, then choosing the portion
   step that best closes the remaining gap; the cheapest complete draw wins. A few hundred
   recipes cost single-digit milliseconds, which is the whole reason no LP solver, no
   dependency and no worker is involved.

   The cost function, in order of weight and each with its reason:

   - **kcal distance from the day target** — the objective (rule 1).
   - **protein, then carbohydrate and fat** — tie-breakers, an order of magnitude lower.
   - **repetition** — days since `lastPlannedDate`, decaying to zero over two weeks (rule 3).
   - **portion scaling away from 1.0** — 1.0 is free, 1.75 is not; a plan of whole portions is
     a better plan than one that is arithmetically identical and asks for three odd fractions.
   - **slot share** — how far each slot lands from its share of the day.

2. **Weekly balance, in `planner.ts` beside the day solver.** `weekDates(date)` gives the seven
   days; `dayGoals(day, profileGoals)` decides what each is judged against, so a day with a
   frozen `goalSnapshot` is scored against the goals it was planned under and history is not
   rewritten. The function returns the corrected target and the sentence the UI prints
   („W tym tygodniu masz zapas 640 kcal — rozłożony na 3 dni").

3. **Filling a day that is already half planned — the primary path, not a special case.**
   Existing meals are fixed input: their macros come off the target (`remainingMacros`), their
   slots are taken, and the solver fills what is left. „Zaplanuj dzień" and „Uzupełnij dzień"
   are the same code and the same button; only the label changes with whether the day is empty.

4. **Candidate filtering, and the two exclusions that would otherwise poison the search.**
   Recipes tagged `nie-planuj` are out. So are recipes whose items are incomplete
   (`isRecipeItemComplete`) or whose per-portion macros come to zero kcal — **a 0 kcal recipe is
   a perfect filler for any gap and would be proposed constantly**, which is the kind of thing
   that is obvious only after it happens. The sheet reports how many recipes were skipped and
   why, so the exclusion is visible rather than mysterious.

5. **`PlannerSheet.svelte` — the proposal, and the reason anyone will use this twice.** A
   `BottomSheet` listing the slots with the proposed recipe, its portion count and its macros,
   a bar against the day target, and the weekly line above it. Three controls:
   „Losuj ponownie" for the whole day, a **lock** per slot, and a **reroll of one slot** that
   respects every lock. Locking the dinner and rerolling the rest is the interaction that turns
   a black box into a tool. „Zastosuj" is the only thing that writes.

6. **Week mode in the same sheet.** „Zaplanuj tydzień" on the calendar generates the seven days
   left to right, carrying the running balance forward, then makes one repair pass over the
   worst day. Each day can be unticked before applying; a day that already has meals is
   **appended to, never replaced**, unless the user explicitly picks „zastąp" — the same choice
   `copyMealsInto` already models as `CopyMode`. Applying writes day by day through the
   existing repository operations, so `goalSnapshot` capture, tag counts and sync all behave
   exactly as they do for a meal added by hand. The payoff lands for free: a generated week
   feeds straight into the shopping list that already exists.

7. **„Za mało przepisów" is three different sentences.** A dead end that says only
   „nie da się" is the worst thing this feature could do. The failure is typed and named:

   - no recipe carries a slot's tags → name the slot and the tags;
   - the library is too small outright → say how many usable recipes there are;
   - nothing fits the tolerance → **show the best plan found anyway**, with the difference
     spelled out („najbliżej: +230 kcal, −18 g białka"), and let the user accept it or relax
     the tags with one tap.

8. **The template editor in Settings.** A „Planer posiłków" section: reorderable rows, each with
   a name, a `TagInput` and a share; add and remove a row; a reset to the default template.
   Saved into `profile.mealPlan`, which syncs with `profile.json` on the existing path.

9. **Tests.** `planner.test.ts` against a seeded generator: the weights, the portion steps, the
   repetition decay, the weekly correction and its clamp, the per-day band, each failure mode,
   and the two exclusions. `e2e/planner.spec.ts` for the sheet: plan an empty day, fill a
   half-planned one, lock and reroll a single slot, apply a week, and the „za mało przepisów"
   message. No network is involved anywhere in this phase — the planner never talks to Gemini.

### Acceptance criteria

- [ ] On a day with no meals, „Zaplanuj dzień" proposes one meal per template slot, respecting
      each slot's tags, and applying them lands the day's kcal within ±15% of its goal.
- [ ] On a day that already has two meals, „Uzupełnij dzień" leaves those two untouched and
      fills only the remaining slots, against the goal minus what is already there.
- [ ] Over a generated week, the **average** daily kcal is within ±5% of the goal, and **no
      single day** falls outside ±15% of its own.
- [ ] A day planned on its own inside a week that is already over or under budget gets a
      corrected target, the correction is clamped to ±10% of the daily goal, and the sheet
      states in Polish what it did.
- [ ] „Losuj ponownie" gives a different plan; a locked slot survives every reroll; rerolling
      one slot changes only that slot.
- [ ] No recipe appears twice in one proposed day, and a recipe planned in the last few days is
      not proposed while an equally good unused one exists.
- [ ] A recipe tagged `nie-planuj`, one with an incomplete ingredient, and one computing to
      0 kcal are never proposed, and the sheet says how many recipes it skipped.
- [ ] When nothing fits, the message names which of the three cases it is, and the
      out-of-tolerance case still shows the best plan found with its difference from the goal.
- [ ] Nothing is written to IndexedDB until „Zastosuj"; applying goes through the existing day
      operations, so `goalSnapshot`, `macroSnapshot`, tag counts and sync are unchanged.
- [ ] The solver is deterministic under a seeded generator, and `planner.ts` imports nothing
      that touches the database, the network or the clock.
- [ ] No new dependency, no CSP change, no `Caddyfile` change — verified under
      `npm run docker:up`.
- [ ] All UI text in Polish; code and comments in English.
