# Security policy

## Supported versions

Only the latest released version is supported. Report against it whenever possible.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**Security → Advisories → Report a vulnerability** in this repository.

Please do not open a public issue for a security problem.

Expect an initial response within 14 days.

## What this app holds

Eat My Way has no backend and no server-side account. Everything sensitive lives in the user's
browser and in their own Google Drive:

- a **Gemini API key**, held in an encrypted vault (Argon2id → AES-GCM);
- a **Google OAuth token** with the `drive.appdata` scope — access to this app's private Drive
  folder only, never to the rest of the user's Drive;
- the user's meal history, recipes and nutrition goals.

The vault's master password is never stored and cannot be recovered. The decrypted vault key
exists only in page memory for the duration of the session.

When sync adopts the vault from Drive, the copy this device held is kept locally so the swap can
be undone (STATE.md decision 150). It is the same ciphertext under the same protection, it is
never uploaded, and it is discarded as soon as the user restores it or writes a vault here.

The data export in settings (*Zapisz kopię*) writes a JSON file holding the goals, recipes,
tags, custom ingredients and planned days — and **deliberately not the vault**. A backup file
ends up in Downloads, in mail attachments and in other people's cloud drives; an API key does
not travel that way. An export that contained the key, in any form, would be a vulnerability.

The service worker precaches the application bundle and the bundled USDA ingredient data, and
nothing else: it declares no `runtimeCaching`, so no OAuth popup, token response, Drive
document or Gemini request is routed through it, and none can land in a cache. A change that
adds runtime caching has to answer that question again before it lands.

## Scope

Security-relevant problems are most likely to look like:

- a path by which the **Gemini API key or the decrypted vault key escapes memory** — into
  `localStorage`, the service worker cache, a log line, an error report, a URL, or an outbound
  request to anything other than the Gemini endpoint;
- a **weakening of the vault**: KDF parameters below the documented ones, a nonce reused across
  AES-GCM encryptions, a verifier check that leaks key material, or a downgrade to the
  unencrypted mode without explicit user consent;
- a **Content-Security-Policy regression** — anything that reintroduces `unsafe-inline` or
  `unsafe-eval`, or widens `connect-src` beyond `generativelanguage.googleapis.com`,
  `www.googleapis.com` and `accounts.google.com`. The policy does carry
  `script-src 'wasm-unsafe-eval'`, which is *not* `unsafe-eval`: it permits WebAssembly
  compilation and nothing else, and exists because the vault's Argon2id (hash-wasm, in a Web
  Worker) is WebAssembly. `script-src` and `frame-src` also allow
  `https://accounts.google.com` for Google Identity Services;
- **OAuth handling** that requests a broader scope than `drive.appdata`, leaks a token, or
  silently binds one Google account's data to another account's `sub`;
- **untrusted input treated as markup or code**: recipe text pasted by the user, JSON returned
  by Gemini, a file fetched from Drive, or a restored backup file rendered without escaping;
- **a service worker that caches more than the application bundle**, or a backup export that
  starts carrying the vault.

The `VITE_GOOGLE_CLIENT_ID` value ships inside the public bundle by design — an OAuth client ID
is not a credential. A *client secret* in the bundle would be a vulnerability; please report one
if you find it.

Bugs in Google Drive, Gemini or the browser itself belong to their respective vendors.
