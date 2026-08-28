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

## One-time server setup

1. Create the deploy directory:
   ```bash
   sudo mkdir -p /var/www/eatmyway
   sudo chown "$USER":"$USER" /var/www/eatmyway
   ```
2. Point DNS: `eatmyway.gorny.dev` → the VM's public IP.
3. nginx site (`/etc/nginx/sites-available/eatmyway`), then `certbot --nginx -d eatmyway.gorny.dev`:
   ```nginx
   server {
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
4. The service worker and the OAuth flow both require HTTPS — verify certbot succeeded before
   testing anything to do with Drive or the PWA.

## GitHub repository configuration

**Secrets** (Settings → Secrets and variables → Actions → *Secrets*):

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | Private key of a deploy user that can write `/var/www/eatmyway` and run `docker` |
| `SSH_KNOWN_HOSTS` | Output of `ssh-keyscan <host>` — pins the server's host key |
| `SSH_USER` | Deploy user name |
| `SSH_HOST` | Server host or IP |

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
| Old version still served after a deploy | Service worker cache — hard-reload; check the workflow actually reached the `deploy` job |
