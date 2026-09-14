import { describe, expect, it } from "vitest";
import {
  configureOverSerial,
  type DeviceConfiguration,
  type InstallProgress,
} from "../src/web/device-installer";

class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly lines: string[] = [];
  readonly signals: SerialOutputSignals[] = [];
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private identifyAttempts = 0;

  async open(): Promise<void> {
    const encoder = new TextEncoder();
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const line = new TextDecoder().decode(chunk).trim();
        this.lines.push(line);
        if (line === "identify") {
          this.identifyAttempts += 1;
          if (this.identifyAttempts > 1)
            this.controller?.enqueue(
              encoder.encode(
                'TSJSON:{"type":"device.info","model":"ESP32-C3"}\n',
              ),
            );
        } else if (line.startsWith("set ")) {
          const key = line.split(" ", 3)[1];
          this.controller?.enqueue(
            encoder.encode(`Saved ${key}. Reboot after setup.\n`),
          );
        } else if (line === "show") {
          this.controller?.enqueue(encoder.encode("  complete: yes\n"));
        }
      },
    });
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signals.push(signals);
  }

  async close(): Promise<void> {
    this.readable = null;
    this.writable = null;
  }
}

const configuration: DeviceConfiguration = {
  apiUrl: "https://time.example.test",
  deviceId: "00000000-0000-4000-8000-000000000001",
  setupToken: "a".repeat(64),
  wifiSsid: "Test network",
  wifiPassword: "test-password",
  leftCompanyId: "00000000-0000-4000-8000-000000000002",
  rightCompanyId: "00000000-0000-4000-8000-000000000003",
};

describe("browser device installer", () => {
  it("retries identification and waits for every setting acknowledgement", async () => {
    const fakePort = new FakeSerialPort();
    const progress: InstallProgress[] = [];

    await configureOverSerial(
      fakePort as unknown as SerialPort,
      configuration,
      (update) => progress.push(update),
    );

    expect(fakePort.signals).toContainEqual({
      dataTerminalReady: false,
      requestToSend: false,
    });
    expect(fakePort.lines.filter((line) => line === "identify")).toHaveLength(
      2,
    );
    expect(fakePort.lines).toContain("set wifi_ssid Test network");
    expect(fakePort.lines).toContain("set wifi_password test-password");
    expect(fakePort.lines.at(-1)).toBe("reboot");
    expect(progress.at(-1)).toMatchObject({
      phase: "configuring",
      percent: 100,
      detail: "Verifying configuration…",
    });
  });
});
