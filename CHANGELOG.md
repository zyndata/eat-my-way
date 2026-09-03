# Changelog

All notable changes to Eat My Way are documented here.
This file is generated from Conventional Commit messages by
[git-cliff](https://git-cliff.org) — edit the commit messages, not this file.
The format follows [Keep a Changelog](https://keepachangelog.com) and the
project adheres to [Semantic Versioning](https://semver.org).

## [1.4.1] - 2026-09-03

### Bug Fixes

- **build:** Stop a tagless checkout from calling a commit hash a version
- **pwa:** Trust the registration over a rejected update(), and say what failed

## [1.4.0] - 2026-09-03

### Bug Fixes

- **sync:** Pull the profile, refresh the screens and carry tag renames

### Features

- **icons:** Use the brand mark, and take the accent from it

## [1.3.0] - 2026-09-03

### Features

- **pwa:** Notice a new version instead of waiting to be reloaded

## [1.2.0] - 2026-09-03

### Features

- **about:** Show which build the app is running

## [1.1.1] - 2026-09-03

### Bug Fixes

- **ui:** Commit a suggestion on release, not on the press
- **pwa:** Name the Android install route while Chrome withholds the prompt
- **ingredients:** Give the replacement picker room for its suggestions

### Documentation

- Record that the live CSP violation is Cloudflare's edge script
- The Android install button works — open question 26 answered
- The "already installed" copy works too — Phase 11 fully verified
- **state:** Record decisions 221 and 222
- **state:** Record decision 223

## [1.1.0] - 2026-09-03

### Documentation

- Record that v1.0.0 shipped
- Plan phases 10 and 11
- Plan the repository About box as a Phase 11 task

### Features

- Phase 10 — składniki i pełna kopia danych
- Phase 11 — zgłoszenia z użytkowania

### Miscellaneous

- Update CHANGELOG
- Update CHANGELOG

## [1.0.0] - 2026-09-02

### Bug Fixes

- Save daily goals, which a $state proxy had always prevented
- Default to gemini-3.6-flash, which a new key can actually call
- Migrate profiles off the retired model and report the real quota
- Offer the right ingredients for a multi-word name, and drop import from the edit screen
- **editor:** Let "Zmień" on an ingredient row be undone
- **sync:** Keep the Drive session across a page reload

### Documentation

- Record the OAuth client ID as configured
- Record the goals bug and the first live Drive round trip
- The COOP window.closed warning does not break dismissal detection
- Settle open questions 6 and 8-12 after the phase-8 review
- Record where the open-questions review stopped
- Settle open question 14 as decision 148
- Settle open question 15 as decision 149
- Settle open question 18 as decision 151
- Settle open question 20 as decision 152
- Settle open question 21 as decision 153
- Write the model A/B protocol and close the open-questions pass
- Record the first model A/B and what the free tier did to it
- Record decisions 172-174

### Features

- Phase 6 — Drive sync & encrypted vault
- Phase 7 — import a recipe from a link or pasted text with Gemini
- Show what this account has spent on Gemini today
- Pick the Gemini model from a list, and count usage per model
- Phase 8 — installable offline PWA, data backup and the 1.0 polish
- **vault:** Keep the vault Drive overwrote, so the swap can be undone
- **backup:** Say what a restore replaces, not only what it brings in
- Phase 9 — daily-use comfort
- **gemini:** List only the models an import can use
- **gemini:** Default to gemini-3.5-flash-lite
- **sync:** Show how full the connected Google account is

### Miscellaneous

- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG

### Performance

- **recipes:** Count usage over a trailing year instead of the whole history

### Tests

- Cover the Drive login and sync flows end to end
- Cover the loop that turns an unmatched row into a permanent match
- Drive the meal-card swipe as a real touch gesture

### Merge

- Dev into main for v1.0.0

## [0.2.0] - 2026-08-31

### Bug Fixes

- „dodaj też jutro" can be unchecked, and the checkbox is no longer black

### Documentation

- Record end-user review, phase 9 and link-based recipe import
- Budget-aware recipe picker in phase 5, portion fitting in phase 9

### Features

- Phase 2 - local data layer over IndexedDB
- Phase 3 - bundled USDA nutrition database and ingredient autocomplete
- Phase 4 - recipe library and editor
- Phase 5 - calendar, day view and meal view
- Add privacy policy and terms pages

### Miscellaneous

- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Update CHANGELOG
- Merge dev for v0.2.0

## [0.1.0] - 2026-08-29

### CI/CD

- Authenticate the deploy health check past Cloudflare

### Documentation

- Record the server's Cloudflare, DNS-01 and VM operating constraints

### Features

- Phase 1 — scaffold, app shell and Caddy container

### Miscellaneous

- Scaffold project docs and workflow (PLAN, STATE, CHANGELOG, /phase command)
- Set up public repo, cross-platform conventions and release pipeline
- Update CHANGELOG

### Merge

- Dev into main for v0.1.0


