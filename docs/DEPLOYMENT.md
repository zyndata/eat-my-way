# Deployment

Production lives at **https://eatmyway.gorny.dev**, on the same VM as szok.gorny.dev.

## Shape of the deployment

```
GitHub tag vX.Y.Z
      │
      ├─ build    npm ci → check → test → build          (dist/ artifact, built in CI)
      ├─ release  git-cliff → CHANGELOG.md on main + GitHub Release
      └─ deploy   rsync dist/ + Dockerfile + Caddyfile → docker build → docker run
                                                                  │
                          nginx :443 (TLS, eatmyway.gorny.dev) ───┘ 127.0.0.1:8080
```

The bundle is built **in CI, never on the server** — the VM is small and should not run a
bundler. The image is `FROM caddy` plus the prebuilt `dist/`; Caddy serves static files and sets
the security headers. Nothing computes server-side: there is no backend.

**TLS is terminated by nginx**, not by Caddy, because nginx already owns 80/443 on that host for
szok.gorny.dev. Caddy therefore listens on plain HTTP on `:8080` inside the container, published
only on `127.0.0.1`. (This is a deliberate deviation from the original plan, which assumed Caddy
would hold 443 with automatic HTTPS — see [STATE.md](../STATE.md).)

## Cloudflare sits in front

Every name in the `gorny.dev` zone is **proxied by Cloudflare** (orange cloud), so the certificate
a browser sees is Cloudflare's, not ours. The Let's Encrypt certificate secures only the
Cloudflare → origin hop. Two consequences that are easy to trip over:

- **Inbound port 80 is closed** at the Google Cloud VPC firewall (the VM has no host firewall —
  `ufw` is not installed and the `iptables` INPUT policy is `ACCEPT`). HTTP-01 validation
  therefore cannot work: Cloudflare cannot reach the origin on `:80` and answers `522`.
  Certificates use **DNS-01** instead (see below).
- **Cloudflare's WAF challenges non-browser clients**, answering `403` with a
  `cf-mitigated: challenge` header. A plain `curl` — including one from CI — can get this
  instead of the app. When debugging, bypass the edge entirely from the server itself:
  ```bash
  curl -I --resolve eatmyway.gorny.dev:443:127.0.0.1 https://eatmyway.gorny.dev/
  ```

Three Cloudflare rules make this workable, and all three matter:

- **WAF custom rule `Deploy health check`** — skips every protection for requests carrying the
  `X-Deploy-Check` header with the `DEPLOY_CHECK_TOKEN` value, so the workflow's final assertion
  can reach the app. Deliberately keyed on the header rather than on the path `/`, which would
  have left the home page unprotected.
- **WAF custom rule `Certbot`** — skips protections for `/.well-known/acme-challenge/`, kept as
  a fallback should HTTP-01 ever be needed again.
- **Cache rule `PWA shell - bypass cache`** — bypasses the edge cache for `/`, `/index.html`,
  `/sw.js` and `/manifest.webmanifest`. Cloudflare caches `.js` by default, which would put the
  service worker — the file that governs the app's own caching — into a second, independent
  cache layer. Hashed assets under `/assets/` are safe to cache and are left alone.

SSL/TLS mode is **Full (strict)**, which the origin can satisfy now that every certificate on the
VM is valid and renews unattended.

## One-time server setup

1. Create the deploy directory:
   ```bash
   sudo mkdir -p /var/www/eatmyway
   sudo chown "$USER":"$USER" /var/www/eatmyway
   ```
2. Point DNS: `eatmyway.gorny.dev` → the VM's public IP, as an **A record only**. Do not add an
   `AAAA`: the VM has no global IPv6 address (`ip -6 addr show scope global` is empty), and a
   stale `AAAA` makes Cloudflare try an origin that does not answer.
3. Write the nginx site to `/etc/nginx/sites-available/eatmyway.gorny.dev`, symlink it into
   `sites-enabled`, and reload. **The file must be pure ASCII** — see the warning below.
   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name eatmyway.gorny.dev;

       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
       # Do not add security headers here. The CSP and friends come from Caddy
       # inside the container; setting them again in nginx produces duplicate,
       # conflicting headers and browsers then enforce the intersection.
   }
   ```
4. Obtain the certificate over DNS-01 (see the next section), then confirm certbot added the
   `listen 443 ssl` block and the `ssl_certificate` lines to that same file.
5. The service worker and the OAuth flow both require HTTPS — verify the certificate is live
   before testing anything to do with Drive or the PWA.

> **Keep nginx config files ASCII-only.** certbot's nginx parser is Python and rejects any file
> that is not valid UTF-8 with `Could not read file … due to invalid character`, after which it
> reports `Could not automatically find a matching server block` and refuses to install. A
> terminal not set to UTF-8 (PuTTY defaults to a Latin charset) turns a pasted `—` or `ą` into a
> single invalid byte. nginx itself does not care, so `nginx -t` passes and the breakage only
> surfaces months later, when a renewal fails. Set PuTTY to UTF-8 under
> Window → Translation, and avoid non-ASCII characters in these files entirely.

## Certificates (DNS-01 via Cloudflare)

Because port 80 is unreachable from outside, certbot authenticates by writing a TXT record
through the Cloudflare API. This is also what makes renewal unattended — the `--manual` plugin
these certificates originally used can never renew from a timer, and silently let several
certificates expire.

```bash
sudo apt install python3-certbot-dns-cloudflare
sudo mkdir -p /root/.secrets/certbot
sudo nano /root/.secrets/certbot/cloudflare.ini   # dns_cloudflare_api_token = <token>
sudo chmod 600 /root/.secrets/certbot/cloudflare.ini
```

The API token comes from the Cloudflare *Edit zone DNS* template, scoped to the `gorny.dev` zone.
Use an editor, not a heredoc, so the token does not land in shell history.

```bash
sudo certbot --authenticator dns-cloudflare --installer nginx \
  --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d eatmyway.gorny.dev
```

`--installer nginx` matters: it records `installer = nginx` in the renewal config, so certbot
edits the vhost and reloads nginx after each renewal. Verify with:

```bash
sudo grep -H "authenticator\|installer" /etc/letsencrypt/renewal/*.conf   # dns-cloudflare + nginx
sudo certbot renew --dry-run
systemctl status certbot.service --no-pager                               # must not be "failed"
```

A Cloudflare WAF custom rule named *Certbot* skips all WAF components for
`/.well-known/acme-challenge/`, kept as a fallback should HTTP-01 ever be needed again.

## Operating the VM

The VM is a Compute Engine instance (`zyndata-one`, `us-east1-b`). Two operational rules, both
learned the hard way:

- **The public IP is a reserved static address** (`zyndata-one-ip`). It used to be ephemeral,
  which meant stopping the instance would have released it and broken every `A` record in the
  `gorny.dev` and `bbsliders.eu` Cloudflare zones at once. Use **Reset**, never **Stop**, if a
  reboot is ever needed on an instance whose address is ephemeral — Reset keeps the address.
- **Never let `needrestart` restart a network service.** After an `apt install`, its "Daemons
  using outdated libraries" dialog pre-selects `ifup@ens4.service`. Accepting that takes the
  interface down and does not bring it back: the instance still shows as running in the console,
  but SSH, the Cloud Console's own SSH, and every site on the host all go dark, and the only way
  back in is a Reset. Deselect anything network-related (`ifup@*`, `networkd-dispatcher`,
  `systemd-networkd`) with the spacebar; the rest are safe to restart.

## GitHub repository configuration

**Secrets** (Settings → Secrets and variables → Actions → *Secrets*):

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | Private key of a deploy user that can write `/var/www/eatmyway` and run `docker` |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan <host>` — pins the server's host key |
| `SSH_USER` | Deploy user name |
| `SSH_HOST` | The VM's raw IP. Not a hostname — every name in the zone is Cloudflare-proxied and would never reach port 22 |
| `DEPLOY_CHECK_TOKEN` | Shared secret sent as `X-Deploy-Check` by the health check, matched by a Cloudflare WAF skip rule |

**Variables** (same page → *Variables*):

| Variable | Value |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client ID. Public by design — it ships in the bundle. A client *secret* must never be added here. |

The Google OAuth client (Cloud Console → Credentials → *Web application*) needs both origins in
**Authorized JavaScript origins**: `http://localhost:5173` and `https://eatmyway.gorny.dev`.
Scope: `drive.appdata` only.

## Cutting a release

Use the `/release` skill — it drives both paths and checks the result. By hand:

```bash
git checkout main && git pull --ff-only origin main
git merge --no-ff dev && git push origin main   # this alone does NOT deploy
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0                          # this triggers the workflow
git checkout dev && git merge main              # pick up the CHANGELOG commit
```

Watch it: `gh run list --workflow=deploy.yml --limit 3`, then `gh run watch <id> --exit-status`.
The workflow's final step asserts that https://eatmyway.gorny.dev/ returns 200.

## The first live sign-in (run once, then record it)

Every Google request in the test suite is answered locally (STATE.md decision 107), so the client
is verified against the Drive API *as documented*, never as it behaves. This checklist is the
only thing that closes that gap — STATE.md open question 15, and decision 149 for why it is a
hand run rather than a `@live` spec.

Run it **once, on https://eatmyway.gorny.dev, with a throwaway Google account and a throwaway
day of data**, right after the `v1.0.0` release. Install the PWA on a phone in the same visit and
open question 26 is settled too. Write the outcome of each point into STATE.md — a point that
behaved as expected is as much a result as one that did not.

1. **The consent screen.** „Połącz z Google" from Settings. Check what Google actually names the
   scope, that the app is not flagged as unverified in a way that scares a user off, and that
   dismissing the popup leaves a readable Polish message rather than a stuck spinner.
2. **The identity line.** After consenting, Settings should name the account. It comes from
   `about.get`, the only identity an appdata-only grant exposes (`drive.ts`), and it is unverified
   whether Google fills `user.emailAddress` for this scope or only `permissionId` — if the label
   is empty or a bare id, that is the finding.
3. **A round trip.** Plan a meal, wait for the sync to settle, then reload with an empty cache and
   confirm it comes back. `appDataFolder` is invisible in the Drive UI, so the app is the only
   window onto it.
4. **The silent grant.** Close the tab and open it again. Load asks for a token with `prompt: ''`
   and must succeed without a popup; a popup here means the silent path does not work in
   practice, which is the whole premise of "no refresh token in the browser". **Watch the
   console** while it happens: `[GSI_LOGGER]: Failed to open popup window` has been seen once on
   a load that then succeeded (open question 20), and whether that is GIS noise or a silent path
   that genuinely needs a window can only be told here. Reload several times, with the popup
   blocker in its default setting, and record what the console says each time.
5. **Token expiry.** Leave the tab open for over an hour (the grant is ~3600 s minus the margin
   in `google-auth.ts`), then edit something. The sync must recover on its own. This is the point
   most likely to fail and the least likely to be noticed.
6. **A real conflict.** Two browsers, same account, both offline, both edit the same day, then
   both come back. Expect the same-day prompt the engine shows, driven by Drive's own
   `modifiedTime` — whose resolution and update semantics under a racing write are exactly what
   the fake cannot vouch for.
7. **Revocation.** „Odłącz" in Settings, then reload: the app must fall back to local-only with a
   readable message and must not lose the local database.

## Rollback

Every release builds `eat-my-way:<tag>` alongside `eat-my-way:latest`, so the previous version is
still on the server:

```bash
docker images eat-my-way
docker stop eat-my-way && docker rm eat-my-way
docker run -d --name eat-my-way --restart unless-stopped \
  --memory=256m --memory-swap=256m --cpus=0.5 \
  -p 127.0.0.1:8080:8080 eat-my-way:v0.1.0
```

Nothing user-owned lives on the server, so a rollback loses no data: the user's calendar is in
their browser's IndexedDB and their own Google Drive.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 502 from nginx | Container not running, or published on the wrong port — `docker ps` |
| Site loads, app blank, console full of CSP errors | The Caddyfile's policy is out of date with what the app now loads. Reproduce locally with `npm run docker:up` |
| Duplicate `Content-Security-Policy` headers | Security headers were also added to the nginx block — remove them there |
| Google login fails only in production | Origin missing from the OAuth client, or `VITE_GOOGLE_CLIENT_ID` not set as a repo variable at build time |
| Old version still served after a deploy | The service worker is registered `prompt`-style: an open tab keeps the running version until the user answers „Jest nowa wersja… → Odśwież". A closed-and-reopened tab picks it up on its own. If neither does, hard-reload and check the workflow actually reached the `deploy` job |
| `403` with a `cf-mitigated: challenge` header | Cloudflare's WAF answered, the request never reached the VM. Bypass the edge with `curl --resolve …:443:127.0.0.1` |
| `522` from Cloudflare | Cloudflare could not reach the origin — inbound `:80` is closed at the GCP VPC firewall, or a stale `AAAA` record points at a host that does not exist |
| certbot: `Could not automatically find a matching server block` | A non-UTF-8 byte in an nginx config file. Find it with `LC_ALL=C.UTF-8 grep -naxv '.*' <file>` |
| certbot: `An authentication script must be provided with --manual-auth-hook` | That certificate's renewal config still has `authenticator = manual`. Re-issue it with `--authenticator dns-cloudflare` |
| SSH times out, Cloud Console SSH fails with IAP `4003`, and every site is down, but the instance shows as running | The guest network is down — usually `needrestart` restarting `ifup@ens4`. Fix with **Reset** in the Compute Engine console |
| certbot: `orderNotReady` / `Order's status ("invalid")` on one certificate of a batch renew | Transient. Re-run `certbot renew`; the same certificate passes on its own and on the next batch. All five certificates on the VM were issued the same day, so they fall due together and renew in one batch — a single flake there is not a broken configuration |
