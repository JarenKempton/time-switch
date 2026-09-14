# Time Switch

A three-position desk switch that starts and stops work sessions. Left and right select a company; middle stops the active session. The dashboard updates live and keeps a history of hours and pay periods.

The fingerprint authenticator is a separate device and is not part of this repository.

## What you need

- An ESP32-C3 Super Mini and a three-position latching switch
- A USB data cable
- Node.js 22+, pnpm 10, and ESP-IDF 5.3.5
- A deployed copy of the cloud service

This repository is configured for `time.jarenkempton.dev`. To deploy your own copy, change the hostname and Cloudflare Access values in `cloud/wrangler.jsonc`, then follow [the deployment guide](docs/deployment.md).

## 1. Wire the switch

With the angled switch terminals on the right and A/B/C/D labeled counter-clockwise from the top:

| Switch terminal | ESP32-C3 Super Mini    |
| --------------- | ---------------------- |
| A               | GND                    |
| B               | GPIO4 — physical right |
| C               | GPIO3 — physical left  |
| D               | Disconnected           |

Insulate terminal D. The firmware uses the ESP32's internal pull-ups, so do not apply external voltage to either switch input.

## 2. Build and flash the ESP32

```sh
source /path/to/esp-idf/export.sh
cd firmware
idf.py set-target esp32c3
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

Replace `/dev/cu.usbmodemXXXX` with the serial port that appears when the board is connected. Exit the monitor with `Ctrl+]`.

## 3. Create your companies

Open the dashboard, select **Settings**, and add both companies. Copy the UUID shown under each company; those values determine what the left and right positions track.

## 4. Configure the ESP32

In the serial monitor, enter these commands one at a time:

```text
set wifi_ssid <network name>
set wifi_password <network password>
set api_url https://time.jarenkempton.dev
set device_id desk-panel
set device_secret <device secret>
set left_company_id <left company UUID>
set right_company_id <right company UUID>
show
reboot
```

`show` confirms which values are stored while hiding the Wi-Fi password and device secret. Configuration survives power loss.

## 5. Verify it

1. Leave the switch in the middle and reboot the board.
2. Wait for `Wi-Fi connected` and `Network time synchronized` in the monitor.
3. Flip left. A session for the left company should appear in the dashboard.
4. Flip to the middle. That session should stop.
5. Flip right. A session for the right company should start.

If Wi-Fi is unavailable, the controller retains up to 16 pending changes and retries them after reconnecting.

## Run the dashboard locally

```sh
cd cloud
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm dev --host 0.0.0.0
```

Put a random device secret of at least 32 bytes in `.dev.vars`. That file is ignored by Git.

Before opening a pull request, run:

```sh
cd cloud
pnpm format:check
pnpm check
pnpm test
pnpm deploy:check
```

The GitHub Actions workflow also builds the ESP32 firmware. Database changes are defined with Drizzle in `cloud/src/db/schema.ts`; generate migrations with `pnpm migrate:generate` from `cloud/`.

## Useful console commands

```text
show         Display stored configuration with secrets redacted
reboot       Restart the controller
clear_state  Clear the active session marker and offline queue
```

Device requests use HTTPS and HMAC signing. Cloudflare Access protects the dashboard. Fingerprints and biometric templates never enter this service.
