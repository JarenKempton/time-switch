import type { Device } from "../db/schema";

export const SETUP_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

export type DeviceView = Omit<
  Device,
  "secret" | "setupTokenHash" | "setupTokenExpiresAt"
>;

export function deviceView(device: Device): DeviceView {
  return {
    id: device.id,
    name: device.name,
    firmwareVersion: device.firmwareVersion,
    provisionedAt: device.provisionedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function setupTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS);
}
