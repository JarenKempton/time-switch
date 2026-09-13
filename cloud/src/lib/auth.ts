import { ApiError } from "./http";

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export interface DeviceAuthEnv {
  DEVICE_HMAC_SECRET?: string;
  DEVICE_ID: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function authenticateDevice(
  request: Request,
  body: string,
  env: DeviceAuthEnv,
): Promise<void> {
  if (!env.DEVICE_HMAC_SECRET || env.DEVICE_HMAC_SECRET.length < 32) {
    throw new ApiError(
      503,
      "device_auth_unconfigured",
      "Device authentication is not configured.",
    );
  }

  const deviceId = request.headers.get("x-time-switch-device");
  const timestampValue = request.headers.get("x-time-switch-timestamp");
  const signatureValue = request.headers.get("x-time-switch-signature");

  if (
    deviceId !== env.DEVICE_ID ||
    !timestampValue ||
    !signatureValue?.startsWith("v1=")
  ) {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device authentication failed.",
    );
  }

  const timestamp = Number(timestampValue);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(timestamp) ||
    Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new ApiError(
      401,
      "stale_device_request",
      "Device request timestamp is outside the allowed window.",
    );
  }

  const bodyHash = await sha256Hex(body);
  const canonical = [
    timestampValue,
    request.method.toUpperCase(),
    new URL(request.url).pathname,
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.DEVICE_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
  );
  const supplied = hexToBytes(signatureValue.slice(3));

  if (!supplied || !timingSafeEqual(expected, supplied)) {
    throw new ApiError(
      401,
      "invalid_device_signature",
      "Device authentication failed.",
    );
  }
}
