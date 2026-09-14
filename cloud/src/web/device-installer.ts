import type { IEspLoaderTerminal } from "esptool-js";

const FIRMWARE_URL = "/firmware/time-switch-esp32c3.bin";
const BAUD_RATE = 115_200;
const IDENTITY_ATTEMPTS = 10;

export type InstallPhase =
  | "connecting"
  | "flashing"
  | "restarting"
  | "configuring"
  | "checking";

export interface DeviceConfiguration {
  apiUrl: string;
  deviceId: string;
  setupToken: string;
  wifiSsid: string;
  wifiPassword: string;
  leftCompanyId: string;
  rightCompanyId: string;
}

export interface InstallProgress {
  phase: InstallPhase;
  percent: number | null;
  detail: string;
}

export interface DeviceNetworkStatus {
  type: "network.status";
  stage: "wifi" | "time" | "provisioning";
  status:
    | "connecting"
    | "connected"
    | "disconnected"
    | "ready"
    | "complete"
    | "failed";
  reason?: number;
  reasonName?: string;
  rssi?: number;
  transportError?: number;
  httpStatus?: number;
}

export interface DeviceStatusDescription {
  detail: string;
  failure: string | null;
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

function safeSerialValue(value: string, label: string): string {
  if (/[\r\n]/.test(value))
    throw new Error(`${label} cannot contain a line break.`);
  return value;
}

async function openConsole(port: SerialPort): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await port.open({ baudRate: BAUD_RATE, bufferSize: 1_024 });
      await port.setSignals({
        dataTerminalReady: false,
        requestToSend: false,
      });
      return;
    } catch (error) {
      lastError = error;
      await port.close().catch(() => undefined);
      await delay(500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The device did not reconnect after flashing.");
}

export function parseDeviceStatusLine(
  line: string,
): DeviceNetworkStatus | null {
  const marker = "TSJSON:";
  const markerIndex = line.indexOf(marker);
  if (markerIndex < 0) return null;
  try {
    const value = JSON.parse(
      line.slice(markerIndex + marker.length),
    ) as Partial<DeviceNetworkStatus>;
    if (value.type !== "network.status") return null;
    if (!value.stage || !value.status) return null;
    return value as DeviceNetworkStatus;
  } catch {
    return null;
  }
}

export function describeDeviceStatus(
  status: DeviceNetworkStatus,
): DeviceStatusDescription {
  if (status.stage === "wifi") {
    if (status.status === "connecting")
      return { detail: "Connecting to Wi-Fi…", failure: null };
    if (status.status === "connected")
      return {
        detail: "Wi-Fi connected. Synchronizing network time…",
        failure: null,
      };
    if (status.status === "disconnected") {
      const suffix = status.reason == null ? "" : ` (reason ${status.reason})`;
      const signal =
        status.rssi != null && status.rssi > -128
          ? ` Signal: ${status.rssi} dBm.`
          : "";
      let message: string;
      switch (status.reason) {
        case 2:
          message = `The Wi-Fi access point did not answer the controller's authentication request${suffix}.`;
          break;
        case 15:
        case 202:
        case 204:
          message = `Wi-Fi authentication was rejected or timed out${suffix}.`;
          break;
        case 201:
          message = `The controller could not find that Wi-Fi network${suffix}.`;
          break;
        case 203:
          message = `The Wi-Fi access point rejected the controller's association${suffix}.`;
          break;
        case 210:
        case 211:
          message = `The Wi-Fi network's security mode is not compatible with the controller${suffix}.`;
          break;
        default:
          message = `The controller could not complete its Wi-Fi connection${suffix}.`;
      }
      const failure = `${message}${signal}`;
      return { detail: failure, failure };
    }
  }

  if (status.stage === "time" && status.status === "ready")
    return {
      detail: "Network time synchronized. Contacting Cloudflare…",
      failure: null,
    };

  if (status.stage === "provisioning") {
    if (status.status === "connecting")
      return {
        detail: "Registering the controller with Cloudflare…",
        failure: null,
      };
    if (status.status === "complete")
      return {
        detail: "Cloudflare accepted the controller. Confirming online status…",
        failure: null,
      };
    if (status.status === "failed") {
      const http = status.httpStatus ? ` HTTP ${status.httpStatus}.` : "";
      const transport =
        status.transportError && status.transportError !== 0
          ? ` Transport error ${status.transportError}.`
          : "";
      const failure = `The controller reached the network but Cloudflare provisioning failed.${http}${transport}`;
      return { detail: failure, failure };
    }
  }

  return { detail: "Waiting for the controller…", failure: null };
}

export async function monitorDeviceStartup(
  port: SerialPort,
  onStatus: (status: DeviceNetworkStatus) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await openConsole(port);
  if (!port.readable)
    throw new Error("The browser could not reopen the controller console.");

  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const status = parseDeviceStatusLine(line);
        if (status) onStatus(status);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await port.close().catch(() => undefined);
  }
}

export async function prepareExistingDeviceForInstall(
  port: SerialPort,
): Promise<boolean> {
  try {
    await openConsole(port);
    if (!port.readable || !port.writable) return false;
    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();
    const decoder = new TextDecoder();
    let transcript = "";
    let reading = true;
    const readTask = (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        transcript += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);
    try {
      await writer.write(new TextEncoder().encode("prepare_install\n"));
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if (transcript.includes("Ready for install.")) return true;
        await delay(50);
      }
      return false;
    } finally {
      reading = false;
      writer.releaseLock();
      await reader.cancel().catch(() => undefined);
      await readTask;
      reader.releaseLock();
      await port.close().catch(() => undefined);
    }
  } catch {
    await port.close().catch(() => undefined);
    return false;
  }
}

export async function configureOverSerial(
  port: SerialPort,
  configuration: DeviceConfiguration,
  onProgress: (progress: InstallProgress) => void = () => undefined,
): Promise<void> {
  await openConsole(port);
  if (!port.readable || !port.writable)
    throw new Error("The browser could not open the device console.");

  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let transcript = "";
  let reading = true;
  let readError: unknown;
  const readTask = (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      transcript += decoder.decode(value, { stream: true });
    }
  })().catch((error) => {
    if (reading) readError = error;
  });

  const writeLine = async (line: string) => {
    await writer.write(encoder.encode(`${line}\n`));
  };
  const waitFor = async (
    text: string,
    startIndex: number,
    timeoutMilliseconds: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      if (transcript.indexOf(text, startIndex) >= 0) return true;
      if (readError)
        throw new Error(
          "The USB connection was interrupted after flashing. Reconnect the device and try again.",
        );
      await delay(50);
    }
    return false;
  };

  try {
    await delay(300);
    let identified = false;
    for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
      const startIndex = transcript.length;
      await writeLine("identify");
      identified = await waitFor('"model":"ESP32-C3"', startIndex, 750);
      if (identified) break;
      await delay(250);
    }
    if (!identified)
      throw new Error(
        "The ESP32 did not restart into setup mode after flashing. Unplug it, reconnect it, and try again.",
      );

    const commands: Array<[string, string, string]> = [
      ["wifi_ssid", configuration.wifiSsid, "Wi-Fi network name"],
      ["wifi_password", configuration.wifiPassword, "Wi-Fi password"],
      ["api_url", configuration.apiUrl, "API URL"],
      ["device_id", configuration.deviceId, "Device ID"],
      ["provisioning_token", configuration.setupToken, "Setup token"],
      ["left_company_id", configuration.leftCompanyId, "Left company"],
      ["right_company_id", configuration.rightCompanyId, "Right company"],
    ];
    for (const [index, [key, value, label]] of commands.entries()) {
      onProgress({
        phase: "configuring",
        percent: 74 + Math.round(((index + 1) / (commands.length + 1)) * 15),
        detail: `Saving ${label.toLowerCase()}…`,
      });
      const startIndex = transcript.length;
      await writeLine(`set ${key} ${safeSerialValue(value, label)}`);
      if (!(await waitFor(`Saved ${key}.`, startIndex, 3_000)))
        throw new Error(
          `The device did not acknowledge ${label.toLowerCase()}. Reconnect it and try again.`,
        );
    }

    onProgress({
      phase: "configuring",
      percent: 90,
      detail: "Verifying configuration…",
    });
    const startIndex = transcript.length;
    await writeLine("show");
    if (!(await waitFor("complete: yes", startIndex, 3_000)))
      throw new Error(
        "The device saved the settings but did not report a complete configuration. Reconnect it and try again.",
      );
    await writeLine("reboot");
  } finally {
    reading = false;
    writer.releaseLock();
    await reader.cancel().catch(() => undefined);
    await readTask;
    reader.releaseLock();
    await port.close().catch(() => undefined);
  }
}

export function supportsBrowserInstaller(): boolean {
  return window.isSecureContext && "serial" in navigator;
}

export async function installAndConfigureDevice(
  configurationFactory: () => Promise<DeviceConfiguration>,
  onProgress: (progress: InstallProgress) => void,
): Promise<{ chip: string; deviceId: string; port: SerialPort }> {
  if (!supportsBrowserInstaller())
    throw new Error(
      "Device setup requires desktop Chrome or Edge over a secure connection.",
    );

  onProgress({ phase: "connecting", percent: 0, detail: "Choose the ESP32." });
  const port = await navigator.serial.requestPort();
  onProgress({
    phase: "connecting",
    percent: 2,
    detail: "Preparing the controller…",
  });
  await prepareExistingDeviceForInstall(port);
  const { ESPLoader, Transport } = await import("esptool-js");
  const transport = new Transport(port);
  const terminal: IEspLoaderTerminal = {
    clean: () => undefined,
    write: () => undefined,
    writeLine: () => undefined,
  };
  const loader = new ESPLoader({
    transport,
    baudrate: 460_800,
    terminal,
  });

  let chip = "";
  try {
    chip = await loader.main();
    if (!chip.toUpperCase().includes("ESP32-C3"))
      throw new Error(`This firmware requires an ESP32-C3; detected ${chip}.`);
    const response = await fetch(FIRMWARE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("The firmware image is unavailable.");
    const firmware = new Uint8Array(await response.arrayBuffer());
    await loader.writeFlash({
      fileArray: [{ data: firmware, address: 0 }],
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "4MB",
      eraseAll: true,
      compress: true,
      reportProgress: (_index, written, total) =>
        onProgress({
          phase: "flashing",
          percent: total ? 5 + Math.round((written / total) * 65) : 5,
          detail: "Installing firmware…",
        }),
    });
    onProgress({ phase: "restarting", percent: 72, detail: "Restarting…" });
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => undefined);
  }

  const configuration = await configurationFactory();
  onProgress({
    phase: "configuring",
    percent: 74,
    detail: "Sending settings directly over USB…",
  });
  await configureOverSerial(port, configuration, onProgress);
  return { chip, deviceId: configuration.deviceId, port };
}
