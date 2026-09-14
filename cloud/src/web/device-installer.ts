import type { IEspLoaderTerminal } from "esptool-js";

const FIRMWARE_URL = "/firmware/time-switch-esp32c3.bin";
const BAUD_RATE = 115_200;

export type InstallPhase =
  | "connecting"
  | "flashing"
  | "restarting"
  | "configuring";

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
  percent: number;
  detail: string;
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function safeSerialValue(value: string, label: string): string {
  if (/[\r\n]/.test(value))
    throw new Error(`${label} cannot contain a line break.`);
  return value;
}

async function openConsole(port: SerialPort): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await port.open({ baudRate: BAUD_RATE });
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The device did not reconnect after flashing.");
}

async function configureOverSerial(
  port: SerialPort,
  configuration: DeviceConfiguration,
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
  const readTask = (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      transcript = (transcript + decoder.decode(value, { stream: true })).slice(
        -8_192,
      );
    }
  })().catch(() => undefined);

  const writeLine = async (line: string) => {
    await writer.write(encoder.encode(`${line}\n`));
    await delay(120);
  };
  const waitFor = async (text: string, timeoutMilliseconds: number) => {
    const deadline = Date.now() + timeoutMilliseconds;
    while (!transcript.includes(text) && Date.now() < deadline)
      await delay(100);
    if (!transcript.includes(text))
      throw new Error("The device did not confirm its configuration.");
  };

  try {
    await delay(1_200);
    await writeLine("identify");
    await waitFor('"model":"ESP32-C3"', 5_000);
    const commands: Array<[string, string, string]> = [
      ["wifi_ssid", configuration.wifiSsid, "Wi-Fi network name"],
      ["wifi_password", configuration.wifiPassword, "Wi-Fi password"],
      ["api_url", configuration.apiUrl, "API URL"],
      ["device_id", configuration.deviceId, "Device ID"],
      ["provisioning_token", configuration.setupToken, "Setup token"],
      ["left_company_id", configuration.leftCompanyId, "Left company"],
      ["right_company_id", configuration.rightCompanyId, "Right company"],
    ];
    for (const [key, value, label] of commands)
      await writeLine(`set ${key} ${safeSerialValue(value, label)}`);
    await writeLine("show");
    await waitFor("complete: yes", 5_000);
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
): Promise<{ chip: string; deviceId: string }> {
  if (!supportsBrowserInstaller())
    throw new Error(
      "Device setup requires desktop Chrome or Edge over a secure connection.",
    );

  onProgress({ phase: "connecting", percent: 0, detail: "Choose the ESP32." });
  const port = await navigator.serial.requestPort();
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
          percent: total ? Math.round((written / total) * 100) : 0,
          detail: "Installing firmware…",
        }),
    });
    onProgress({ phase: "restarting", percent: 100, detail: "Restarting…" });
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => undefined);
  }

  const configuration = await configurationFactory();
  onProgress({
    phase: "configuring",
    percent: 100,
    detail: "Sending settings directly over USB…",
  });
  await configureOverSerial(port, configuration);
  return { chip, deviceId: configuration.deviceId };
}
