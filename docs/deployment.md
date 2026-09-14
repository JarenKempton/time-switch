# Production deployment

CI validates each pull request once and validates the resulting `main` commit. After the `main` CI run succeeds, **Deploy production** starts automatically and, when configured, waits for approval from the `production` GitHub environment. Manual dispatch remains available as a recovery path.

## One-time GitHub setup

Create a GitHub environment named `production`, add yourself as its required reviewer, and add these environment secrets:

| Secret                  | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns `jarenkempton.dev`           |
| `CLOUDFLARE_API_TOKEN`  | Narrow token allowed to deploy this Worker and its routes |

## One-time Cloudflare Access setup

The Worker deliberately fails closed when Cloudflare Access identity is absent. Configure Access at the hostname level because Worker-level Access currently does not support WebSocket upgrades, and `/api/v1/live` uses a WebSocket.

Create two self-hosted Access applications or path rules, in this order of specificity:

1. `time.jarenkempton.dev/device/*` — Bypass. This narrowly exposes only the device namespace. Provisioning requires a short-lived, one-time token and subsequent requests require that device's HMAC signature.
2. `time.jarenkempton.dev` — Allow only Jaren's identity. Leaving the path empty protects the hostname root and every path, including the dashboard, browser API, CSV exports, and live WebSocket.

Cloudflare applies the most specific matching application path. Do not add a wider bypass rule and do not place device endpoints under `/api/*`.

Set `ACCESS_TEAM_DOMAIN` in `cloud/wrangler.jsonc` to the account's Access team URL and set `ACCESS_AUD` to the dashboard application's audience tag. These values are identifiers, not secrets. The Worker verifies every forwarded `Cf-Access-Jwt-Assertion` against the team's public keys, expected issuer, and expected audience before serving the dashboard or browser API.

## Release flow

1. Merge a reviewed pull request after CI is green.
2. CI validates the exact `main` commit. Firmware compilation runs only on pull requests that modify `firmware/`; ordinary web and API changes skip it.
3. A successful `main` CI run starts **Deploy production** for that commit.
4. Approve the `production` environment deployment when prompted.
5. Wrangler uploads the Worker, web assets, checked-in browser firmware image, source maps, and Durable Object declaration. It does not rebuild firmware or repeat the CI test suite.
6. A deliberately invalid provisioning request confirms the device route, Durable Object, SQLite storage, and checked-in Drizzle migrations are usable without creating data or exposing a credential. The check retries briefly while Cloudflare propagates the new Worker version.

The deployment job is concurrency-locked and never cancels an in-progress production release. Use **Actions → Deploy production → Run workflow** only when an automatic deployment needs to be retried.

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
BASE_URL=https://time.jarenkempton.dev pnpm smoke
```

The smoke response and structured Worker logs contain request and version IDs but no request bodies, query strings, identities, or secrets.
