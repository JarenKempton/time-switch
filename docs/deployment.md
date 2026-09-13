# Production deployment

The production release is intentionally manual. CI validates every branch and pull request; the **Deploy production** workflow deploys only after a person starts it and, when configured, approves the `production` GitHub environment.

## One-time GitHub setup

Create a GitHub environment named `production`, add yourself as its required reviewer, and add these environment secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns `jarenkempton.dev` |
| `CLOUDFLARE_API_TOKEN` | Narrow token allowed to deploy this Worker and its routes |
| `DEVICE_HMAC_SECRET` | Random shared key used only by the Worker, deployment smoke test, and ESP32 |

Generate the device key with `openssl rand -hex 32`. Do not commit it or place it in a normal Wrangler variable. The workflow passes it through Wrangler's encrypted-secret input.

## One-time Cloudflare Access setup

The Worker deliberately fails closed when Cloudflare Access identity is absent. Configure Access at the hostname level because Worker-level Access currently does not support WebSocket upgrades, and `/api/v1/live` uses a WebSocket.

Create two self-hosted Access applications or path rules, in this order of specificity:

1. `time.jarenkempton.dev/device/*` — Bypass. This narrowly exposes only the device namespace; every request there must still pass the Worker's HMAC validation.
2. `time.jarenkempton.dev/*` — Allow only Jaren's identity. This protects the dashboard, browser API, CSV exports, and live WebSocket.

Cloudflare applies the most specific matching application path. Do not add a wider bypass rule and do not place device endpoints under `/api/*`.

## Release flow

1. Merge an reviewed pull request after CI is green.
2. Open **Actions → Deploy production → Run workflow** against the intended commit or branch.
3. Approve the `production` environment deployment.
4. The workflow repeats formatting, type, test, migration, build, and Wrangler dry-run checks.
5. Wrangler uploads the Worker, assets, source maps, Durable Object declaration, and encrypted device secret.
6. The signed `/device/v1/health` smoke test confirms the route, HMAC configuration, Durable Object, SQLite storage, and checked-in Drizzle migrations are usable.

The deployment job is concurrency-locked and never cancels an in-progress production release.

## Local release checks

From `cloud/`:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test
pnpm migrate:generate
git diff --exit-code -- drizzle
pnpm deploy:check
```

To test an already-deployed environment without exposing the dashboard:

```sh
BASE_URL=https://time.jarenkempton.dev \
DEVICE_ID=desk-panel \
DEVICE_HMAC_SECRET='the-configured-secret' \
pnpm smoke
```

The smoke response and structured Worker logs contain request and version IDs but no request bodies, query strings, identities, or secrets.
