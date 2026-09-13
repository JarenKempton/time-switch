# Time Switch

A physical three-position desk switch for tracking work sessions. An ESP32-C3 converts left, center, and right switch positions into authenticated session events. A Cloudflare Worker stores the ledger in a SQLite-backed Durable Object and serves a live React dashboard.

The fingerprint authenticator remains a separate ESP32-S3 USB device. Keeping authentication and time tracking on separate controllers limits the security impact of either device and lets each be updated independently.

## Architecture

```text
ESP32-C3 desk switch
  ├─ GPIO3 / GPIO4 with internal pull-ups
  ├─ NVS configuration and offline FIFO
  └─ HTTPS + HMAC requests
              │
              ▼
Cloudflare Worker at time.jarenkempton.dev
  ├─ Hono routing and device-request validation
  ├─ serves the React + Vite + shadcn/ui dashboard
  └─ routes API calls to one Durable Object
              │
              ▼
SQLite Durable Object
  ├─ companies
  ├─ sessions (at most one active)
  ├─ hour_retrievals (one per "Get hours" action)
  └─ hibernating WebSockets for live dashboard updates
```

Pay periods are derived, not stored. Each company has a cadence and anchor date, and the dashboard derives the current range from them. Retrieving hours ("Get hours") is the one stored event: it closes a window, records the total the ledger produced at that moment, and states when the next period ends. That choice can be the next regular cutoff, the cutoff after that, a full cadence from today (which re-anchors the company), or a custom date. Once the chosen window lapses the regular cadence resumes. The most recent retrieval can be undone from History.

## Repository layout

- `firmware/` — ESP-IDF firmware for the ESP32-C3 time switch.
- `cloud/` — Cloudflare Worker, Durable Object, Drizzle schema/migrations, API, tests, and dashboard.
- `.github/workflows/ci.yml` — cloud checks and an ESP-IDF build.
- `.github/workflows/deploy.yml` — manually approved production deployment and signed smoke test.
- `docs/deployment.md` — exact GitHub and Cloudflare production setup.

## Hardware wiring

With the angled switch terminals on the right and A/B/C/D labeled counter-clockwise from the top:

| Switch terminal | ESP32-C3 Super Mini        |
| --------------- | -------------------------- |
| A               | GND                        |
| B               | GPIO4 — physical right     |
| C               | GPIO3 — physical left      |
| D               | Disconnected and insulated |

The firmware enables the ESP32's internal pull-ups. Do not apply an external voltage to either switch input.

## Cloud development

Requirements: Node.js 22+, pnpm 10, and a Cloudflare account for deployment.

```sh
cd cloud
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev --host 0.0.0.0
```

The dashboard has three views, switched with hash routes: `#/` (live session, per-company pay periods, recent sessions), `#/history` (range totals, retrieved hours, session corrections), and `#/settings` (companies, cadences, device IDs).

Put a random secret of at least 32 bytes in `.dev.vars` while developing. `.dev.vars` is ignored by Git.

Useful checks:

```sh
pnpm check
pnpm test
pnpm build
pnpm format:check
pnpm deploy:check
```

Drizzle is the schema and migration source of truth. After editing `cloud/src/db/schema.ts`, generate a new migration with:

```sh
pnpm migrate:generate
```

## Cloudflare deployment preparation

`cloud/wrangler.jsonc` declares the `time-switch` Worker, SQLite Durable Object, static assets, observability, source maps, and custom domain `time.jarenkempton.dev`. Hono defines both the public Worker boundary and Durable Object API routes; Drizzle owns the SQLite schema and migrations. The Worker does not contain a fallback dashboard password: all dashboard and browser API requests fail closed unless Cloudflare Access supplies an authenticated identity. `/device/*` remains separately protected by HMAC so the ESP32 does not need an interactive Access login.

Follow [`docs/deployment.md`](docs/deployment.md) for the one-time Access and GitHub environment setup and the manual production release workflow.

## API

All browser timestamps are ISO 8601 instants. Reporting ranges use an inclusive `from` and exclusive `to`.

| Method        | Path                                    | Purpose                                             |
| ------------- | --------------------------------------- | --------------------------------------------------- |
| `GET`, `POST` | `/api/v1/companies`                     | List or create companies                            |
| `PATCH`       | `/api/v1/companies/:id`                 | Edit or archive a company                           |
| `GET`, `POST` | `/api/v1/sessions`                      | Query or manually start sessions                    |
| `PATCH`       | `/api/v1/sessions/:id`                  | Correct a ledger entry                              |
| `POST`        | `/api/v1/sessions/:id/stop`             | Stop a session idempotently                         |
| `GET`         | `/api/v1/status`                        | Read the current active session                     |
| `GET`         | `/api/v1/summary?from=&to=`             | Calculate clipped totals                            |
| `GET`         | `/api/v1/companies/:id/hours?from=&to=` | Clipped total and session count for one company     |
| `GET`         | `/api/v1/retrievals?companyId=`         | List recorded hour retrievals                       |
| `POST`        | `/api/v1/companies/:id/retrievals`      | Record a retrieval and schedule the next period end |
| `DELETE`      | `/api/v1/retrievals/:id`                | Undo the most recent retrieval for a company        |
| `GET`         | `/api/v1/export.csv`                    | Export filtered sessions                            |
| `GET`         | `/api/v1/live`                          | Receive state changes over WebSocket                |
| `POST`        | `/device/v1/sessions/start`             | Authenticated device start                          |
| `POST`        | `/device/v1/sessions/:id/stop`          | Authenticated device stop                           |
| `POST`        | `/device/v1/health`                     | Signed deployment and storage health check          |

Device requests sign `timestamp + method + path + SHA-256(body)` with HMAC-SHA256. Requests outside the five-minute clock window are rejected. Session UUIDs make retries idempotent.

## Firmware

The current project targets an ESP32-C3 using ESP-IDF 5.3.5.

```sh
source /path/to/esp-idf/export.sh
cd firmware
idf.py set-target esp32c3
idf.py build
```

Flashing changes the connected controller and should be done deliberately:

```sh
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

The native USB console accepts:

```text
show
set wifi_ssid <network>
set wifi_password <password>
set api_url https://time.jarenkempton.dev
set device_id desk-panel
set device_secret <same secret stored in Cloudflare>
set left_company_id <company UUID copied from the dashboard>
set right_company_id <company UUID copied from the dashboard>
reboot
```

`show` redacts stored passwords and secrets. Configuration, the active session UUID, the last switch state, and up to 16 pending operations are kept in NVS (non-volatile storage), so a Wi-Fi interruption or reboot does not silently discard recorded switch changes.

## Security boundaries

- The fingerprint sensor stores and matches templates on its own module; the time-switch service never receives biometric data.
- The C3 contains a device secret, but the repository and dashboard do not.
- Device traffic uses HTTPS plus request signing. Dashboard access is delegated to Cloudflare Access.
- A physical attacker with the device can eventually extract or replace firmware; the design is intended to resist remote spoofing and ordinary network interception, not invasive hardware forensics.
