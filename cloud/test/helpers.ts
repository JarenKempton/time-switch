import { env, SELF } from "cloudflare:test";
import type { Env } from "../src/env";
import worker from "../src/worker";

export const workerFetch = worker.fetch as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;
const accessContext = {
  access: {
    aud: "test-audience",
    getIdentity: async () => ({ email: "developer@example.test" }),
  },
} as ExecutionContext;

export function dashboardFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return workerFetch(
    new Request(`https://example.test${path}`, init),
    env as unknown as Env,
    accessContext,
  );
}

export async function signedDeviceHeaders(
  path: string,
  body: string,
  deviceId: string,
  deviceSecret: string,
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const bodyHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(deviceSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode([timestamp, "POST", path, bodyHash].join("\n")),
  );
  const signatureHex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    "content-type": "application/json",
    "x-time-switch-device": deviceId,
    "x-time-switch-signature": `v1=${signatureHex}`,
    "x-time-switch-timestamp": timestamp,
  };
}

export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await dashboardFetch(path, { ...init, headers });
  return { status: response.status, body: (await response.json()) as T };
}

export async function createCompany(name = "Northstar") {
  return request<{ data: { id: string; name: string } }>("/api/v1/companies", {
    method: "POST",
    body: JSON.stringify({ name, color: "#62e6a7", logoUrl: "" }),
  });
}

export async function provisionDevice(name = "Desk panel") {
  const created = await request<{
    data: { device: { id: string }; setupToken: string };
  }>("/api/v1/devices", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const provisioned = await SELF.fetch(
    "https://example.test/device/v1/provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: created.body.data.device.id,
        setupToken: created.body.data.setupToken,
        firmwareVersion: "test-1.0.0",
      }),
    },
  );
  const body = (await provisioned.json()) as {
    data: { deviceId: string; secret: string };
  };
  return body.data;
}

export async function deviceFetch<T>(
  path: string,
  payload: unknown,
  device: { deviceId: string; secret: string },
): Promise<{ status: number; body: T }> {
  const body = JSON.stringify(payload);
  const response = await SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: await signedDeviceHeaders(
      path,
      body,
      device.deviceId,
      device.secret,
    ),
    body,
  });
  return { status: response.status, body: (await response.json()) as T };
}

export interface LiveSocket {
  next(type: string): Promise<Record<string, unknown>>;
  close(): void;
}

export function acceptLive(response: Response): LiveSocket {
  const socket = response.webSocket!;
  const received: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    waiters.splice(0).forEach((wake) => wake());
  });
  socket.accept();
  return {
    async next(type) {
      for (;;) {
        const index = received.findIndex((message) => message.type === type);
        if (index >= 0) return received.splice(0, index + 1).pop()!;
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
    close: () => socket.close(1000, "Test complete"),
  };
}
