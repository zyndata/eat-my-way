# The bundle is built in CI (or by `npm run docker:up` locally) and copied in as
# a prebuilt dist/. The deploy target is a small VM and never runs a bundler.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist/ /srv/

EXPOSE 8080
