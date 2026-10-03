import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { database } from "../db/client";
import { devices, type Device } from "../db/schema";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/auth";
import { ApiError, ok, readJson } from "../lib/http";
import { requireUuid } from "../lib/query";
import { createDeviceSchema } from "../lib/validation";
import { publish } from "../live/publish";
import { deviceView, randomHex, setupTokenExpiry } from "./view";

export const deviceRoutes = new Hono<AppEnv>()
  .get("/api/v1/devices", async (context) => {
    const rows = await database(context.env.DB)
      .select()
      .from(devices)
      .orderBy(asc(devices.name))
      .all();
    return ok(rows.map(deviceView));
  })
  .post("/api/v1/devices", async (context) => {
    const input = createDeviceSchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    const now = new Date();
    const setupToken = randomHex(32);
    const setupTokenHash = await sha256Hex(setupToken);
    const existing = await db
      .select()
      .from(devices)
      .where(eq(devices.name, input.name))
      .get();
    if (existing && !existing.provisionedAt && !existing.revokedAt) {
      const [renewed] = await db
        .update(devices)
        .set({
          setupTokenHash,
          setupTokenExpiresAt: setupTokenExpiry(now),
          updatedAt: now,
        })
        .where(eq(devices.id, existing.id))
        .returning();
      await publish(context.env, db, "device.changed");
      return ok({ device: deviceView(renewed), setupToken }, { status: 201 });
    }
    if (existing) {
      throw new ApiError(
        409,
        "device_name_taken",
        "A device with that name already exists.",
      );
    }
    const device: Device = {
      id: crypto.randomUUID(),
      name: input.name,
      secret: null,
      setupTokenHash,
      setupTokenExpiresAt: setupTokenExpiry(now),
      firmwareVersion: null,
      provisionedAt: null,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(devices).values(device);
    await publish(context.env, db, "device.changed");
    return ok({ device: deviceView(device), setupToken }, { status: 201 });
  })
  .delete("/api/v1/devices/:id", async (context) => {
    const id = requireUuid(context.req.param("id"), "Device");
    const db = database(context.env.DB);
    const deleted = await db
      .delete(devices)
      .where(eq(devices.id, id))
      .returning({ id: devices.id });
    if (!deleted.length)
      throw new ApiError(404, "device_not_found", "Device not found.");
    await publish(context.env, db, "device.changed");
    return ok({ id });
  })
  .post("/api/v1/devices/:id/setup", async (context) => {
    const id = requireUuid(context.req.param("id"), "Device");
    const db = database(context.env.DB);
    const now = new Date();
    const setupToken = randomHex(32);
    const [updated] = await db
      .update(devices)
      .set({
        setupTokenHash: await sha256Hex(setupToken),
        setupTokenExpiresAt: setupTokenExpiry(now),
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(devices.id, id))
      .returning();
    if (!updated)
      throw new ApiError(404, "device_not_found", "Device not found.");
    await publish(context.env, db, "device.changed");
    return ok({ device: deviceView(updated), setupToken });
  });
