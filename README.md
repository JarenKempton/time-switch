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

## 2. Add the device from the dashboard

Open **Devices** in desktop Chrome or Edge, connect the ESP32 over USB, and choose **Add device**. The dashboard:

1. Identifies the connected chip.
2. Installs the current ESP32-C3 firmware.
3. Lets you select the companies for the left and right positions.
4. Sends the Wi-Fi credentials directly from the browser to the ESP32 over USB.
5. Shows the controller's live Wi-Fi, network-time, and Cloudflare registration
   status over USB.
6. Finishes only after the controller's first authenticated check-in.

Use **Configure** on an existing device to reinstall firmware and replace its
Wi-Fi or switch mapping. Use **Delete** to remove an obsolete or incomplete
registration; its existing credential stops working immediately.

The Wi-Fi password never reaches the Worker or its database. Safari and iOS can display device status but do not support the browser installer.

The controller uses 2.4 GHz 802.11b/g in 20 MHz mode, scans all channels for
matching mesh access points, and gracefully leaves Wi-Fi before a reinstall.
Setup reports the ESP-IDF reason code and signal level when the access point
rejects or times out a connection; the progress indicator remains indeterminate
during network registration and reaches 100% only after the service confirms the
controller is online.

## 3. Manual firmware development

```sh
source /path/to/esp-idf/export.sh
cd firmware
idf.py set-target esp32c3
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

Replace `/dev/cu.usbmodemXXXX` with the serial port that appears when the board is connected. Exit the monitor with `Ctrl+]`.

## 4. Create your companies

Open the dashboard, select **Settings**, and add both companies. Copy the UUID shown under each company; those values determine what the left and right positions track.

## 5. Manual serial configuration

The dashboard is the supported provisioning path. For firmware debugging, the same serial protocol is available in the ESP-IDF monitor:

```text
set wifi_ssid <network name>
set wifi_password <network password>
set api_url https://time.jarenkempton.dev
set device_id <device UUID created by the dashboard>
set provisioning_token <one-time setup token created by the dashboard>
set left_company_id <left company UUID>
set right_company_id <right company UUID>
show
reboot
```

`show` confirms which values are stored while hiding the Wi-Fi password, setup token, and device secret. The controller exchanges the one-time token for its own credential after joining Wi-Fi. Configuration survives power loss.

## 6. Verify it

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

No local secret is required. Device credentials are created during provisioning and remain out of source control.

Before opening a pull request, run:

```sh
cd cloud
pnpm format:check
pnpm check
pnpm test
pnpm deploy:check
```

GitHub Actions builds the ESP32 project and merged browser image only when a pull request changes firmware. Successful CI on `main` deploys production automatically without a separate environment approval. Database changes are defined with Drizzle in `cloud/src/db/schema.ts`; generate migrations with `pnpm migrate:generate` from `cloud/`.

## Useful console commands

```text
show         Display stored configuration with secrets redacted
identify     Report the model, firmware, and provisioning protocol
reboot       Restart the controller
prepare_install  Leave Wi-Fi cleanly before a firmware reinstall
clear_state  Clear the active session marker and offline queue
```

Each controller receives a separate, revocable credential and signs requests over HTTPS. Cloudflare Access protects the dashboard. Fingerprints and biometric templates never enter this service.
