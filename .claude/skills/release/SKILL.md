---
name: release
description: Ship the current changes for Eat My Way — asks whether to do a LOCAL deploy (build + rebuild the eatmyway-dev Docker container) or a REMOTE release (tag a SemVer version on main to trigger the GitHub Actions changelog + GitHub Release + deploy to eatmyway.gorny.dev). Use when the user wants to release, deploy, ship, or publish the project.
---

# Release Eat My Way

Drive a release of the current working changes. There are two mutually exclusive
targets — **always ask the user which one first**, then execute only that path.

This project is developed from two machines (Windows and Linux). Prefer the npm
scripts and plain `git` — they behave identically on both. Where a raw shell
command is unavoidable, the PowerShell and POSIX forms are given side by side.

## Step 1 — Ask the target

Use the **AskUserQuestion** tool with one single-select question, header `"Cel wdrożenia"`,
and exactly these two options:

- **„Local deploy + reset kontenera"** — Commit on the current branch, build the bundle,
  rebuild the image and restart the `eatmyway-dev` Docker container. No GitHub push.
  Test on http://localhost:8080 — this is the only way to see the app under the **real
  production CSP**, which `npm run dev` does not apply.
- **„Release: tag SemVer + GitHub Action"** — Commit, merge into `main`, then create and push
  a **SemVer tag** (`vX.Y.Z`). The tag (not a plain `main` push) triggers
  `.github/workflows/deploy.yml`: build → git-cliff CHANGELOG + GitHub Release → rsync the
  built bundle + versioned `docker build` on the server → production eatmyway.gorny.dev.

Do not proceed until the user picks one (or gives custom direction).

## Step 2a — Local deploy + container reset

1. **Run the checks first** (local deploy has no CI gate, unlike the remote path):
   ```
   npm ci
   npm run check
   npm test
   ```
   If anything is red, STOP and fix it before deploying — do not restart the container on
   failing checks.
2. **Review & commit.** Run `git status` and `git diff --stat`. If there are uncommitted
   changes, stage and commit them on the **current branch** (usually `dev` — do not switch
   to `main`). Use **Conventional Commits**; end the message with:
   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
   If the tree is already clean, skip committing.
3. **Build and restart the container.** The image copies a prebuilt `dist/` (the server never
   runs a bundler), so the build must happen before `docker compose`:
   ```
   npm run build
   docker compose down
   docker compose up --build -d
   ```
   (`npm run docker:up` chains all three.)
4. **Verify** the container is healthy and serving the new code:
   - `docker ps` shows `eatmyway-dev` as `Up`.
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/` → `200`
     (PowerShell: `(Invoke-WebRequest http://localhost:8080/ -UseBasicParsing).StatusCode`).
   - **Check the CSP header is present and unchanged:**
     `curl -sI http://localhost:8080/ | grep -i content-security-policy`
     (PowerShell: `(Invoke-WebRequest http://localhost:8080/ -UseBasicParsing).Headers['Content-Security-Policy']`).
   - Open the app and confirm **zero CSP violations** in the browser console — a violation
     here is a production bug that `npm run dev` will never show you.
   - `docker logs eatmyway-dev` for startup errors.
5. **If the host returns nothing while the container looks healthy,** something else is holding
   port 8080. Find and stop it:
   - PowerShell: `Get-NetTCPConnection -LocalPort 8080 -State Listen | Get-Process`
   - Linux: `ss -ltnp 'sport = :8080'`
6. Report the URL (http://localhost:8080) and the verified status, including the CSP result.

## Step 2b — Release: tag a SemVer version + GitHub Action

The deploy workflow triggers **only on a `vX.Y.Z` tag**, not on a plain `main` push. A release
is a deliberate, named, rollback-able act.

1. **Run the checks locally first** (`npm ci; npm run check; npm test; npm run build`) to fail
   fast — the same steps run in CI as the `build` job that gates the release, so a red tag would
   block everything downstream anyway. STOP and fix on failure.
2. **Review & commit** on the current branch (usually `dev`), same commit-message rule as above.
   Use **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `ci:`, …) — the
   changelog is generated from them, so the message *is* the release note.
3. **Sync the other machine's work first.** This project is developed from two machines; a stale
   local `main` is the most likely way to lose a commit here:
   ```
   git fetch origin
   git status -sb          # confirm dev is not behind origin/dev
   ```
4. **Merge into `main`:**
   ```
   git checkout main
   git pull --ff-only origin main
   git merge --no-ff dev
   git push origin main
   ```
   (If already on `main`, just commit.) This push alone does **not** deploy.
5. **Pick the next SemVer version.** Inspect commits since the last tag
   (`git describe --tags --abbrev=0` then `git log <last-tag>..HEAD --oneline`) and bump per
   [SemVer](https://semver.org): breaking → **major**, any `feat:` → **minor**, only
   `fix:`/`docs:`/chores → **patch**. Until the app is actually usable (Phase 5), stay in
   `v0.x`; the first release of the full MVP is **v1.0.0**. If unsure, confirm with the user.
6. **Tag and push the tag** (annotated) — this is what triggers the release:
   ```
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   git checkout dev
   ```
7. **Confirm the Action started** with the `gh` CLI. The workflow runs `build` → `release`
   (git-cliff CHANGELOG commit-back + GitHub Release) → `deploy`, each gated on the previous:
   ```
   gh run list --workflow=deploy.yml --limit 3
   gh run watch <run-id> --exit-status   # optional: stream until it finishes
   ```
8. Report the run URL/status, the **GitHub Release** URL (`gh release view v0.1.0 --web`), and —
   after success — that the change is live at https://eatmyway.gorny.dev (the workflow's last
   step already asserts HTTP 200; confirm the app loads with no CSP violations).

**Note on CHANGELOG.md:** the `release` job regenerates it via git-cliff and commits it back to
`main` as `chore(release): update CHANGELOG …`. After the run, `git checkout dev; git merge main`
(or `git pull` on dev) to bring that commit into `dev` so history stays linear — and so the
*other* machine picks it up on its next `git pull`.

## When a release goes wrong

Published tags are **protected by a repository ruleset** (`Protect release tags`, matching
`refs/tags/v*`: deletion and force-update blocked, **no bypass actors** — being the repo owner does
not exempt you). A failed release is therefore fixed *forward*, with a new patch version, never by
re-pointing the tag that broke:

```
git tag -f v1.6.2 && git push -f origin v1.6.2   # rejected by the ruleset — do not work around it
```

This is deliberate, not friction. `CHANGELOG.md` and the GitHub Release are generated *from* the
tag, and every rollback point on the server is a Docker image named after one. A moved tag leaves
all three quietly disagreeing about what a version actually contains. So when a release fails:

1. Commit the fix on `dev` as usual, then merge to `main` (Step 2b.4).
2. Tag the **next patch** version (`v1.6.3`, never a reused `v1.6.2`) and push that.
3. If the bad version already reached production, roll the server back to the previous image
   (see **Rollback** in Notes) while the new tag builds — do not leave production broken while
   waiting on the workflow.

`main` carries the same protection (deletion + force-push blocked). Ordinary pushes are unaffected,
including the release job's own `chore(release)` CHANGELOG commit-back.

## Notes

- Production deploy is outward-facing and hard to reverse — only run Step 2b after the user
  has explicitly chosen it in Step 1.
- Never push with `--no-verify`, never force-push `main`, and never delete or move a published
  tag. The last two are enforced by repository rulesets, not just convention — see
  **When a release goes wrong** above.
- **Rollback:** on the server, re-run the previous image (each release builds a version-tagged
  image alongside `:latest`):
  ```
  docker stop eat-my-way && docker rm eat-my-way
  docker run -d --name eat-my-way --restart unless-stopped \
    -p 127.0.0.1:8080:8080 eat-my-way:<previous-tag>
  ```
- **Never commit a credential.** No Gemini key, no OAuth client secret, no `.env` — only
  `.env.example`. `VITE_*` values end up inside the public bundle by design; treat anything
  that must stay private as vault content, not configuration.
- The deploy server, tag-based workflow, changelog (`cliff.toml` / `CHANGELOG.md`) and rollback
  details live in [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml),
  [docs/DEPLOYMENT.md](../../../docs/DEPLOYMENT.md) and [CLAUDE.md](../../../CLAUDE.md).
- A release is not a phase. `/phase N` implements one phase and ends; `/release` ships whatever
  is currently on the branch. Do not start phase work from inside this skill.
