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
  `www.googleapis.com` and `accounts.google.com`;
- **OAuth handling** that requests a broader scope than `drive.appdata`, leaks a token, or
  silently binds one Google account's data to another account's `sub`;
- **untrusted input treated as markup or code**: recipe text pasted by the user, JSON returned
  by Gemini, or a file fetched from Drive rendered without escaping.

The `VITE_GOOGLE_CLIENT_ID` value ships inside the public bundle by design — an OAuth client ID
is not a credential. A *client secret* in the bundle would be a vulnerability; please report one
if you find it.

Bugs in Google Drive, Gemini or the browser itself belong to their respective vendors.
