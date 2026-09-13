import { describe, expect, it } from "vitest";
import { authenticateDevice } from "../src/lib/auth";

async function signature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode([timestamp, method, path, hash].join("\n")),
  );
  return Array.from(new Uint8Array(signed), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("device authentication", () => {
  it("accepts a current correctly signed request and rejects tampering", async () => {
    const secret = "test-secret-that-is-longer-than-thirty-two-bytes";
    const body = '{"hello":"world"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = "/device/v1/sessions/start";
    const signed = await signature(secret, timestamp, "POST", path, body);
    const request = new Request(`https://example.test${path}`, {
      method: "POST",
      headers: {
        "x-time-switch-device": "desk-panel",
        "x-time-switch-timestamp": timestamp,
        "x-time-switch-signature": `v1=${signed}`,
      },
      body,
    });

    await expect(
      authenticateDevice(request, body, {
        DEVICE_ID: "desk-panel",
        DEVICE_HMAC_SECRET: secret,
      }),
    ).resolves.toBeUndefined();
    await expect(
      authenticateDevice(request, `${body} `, {
        DEVICE_ID: "desk-panel",
        DEVICE_HMAC_SECRET: secret,
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_device_signature" });
  });
});
