import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { database, type Database } from "../db/client";
import {
  companies,
  devices,
  hourRetrievals,
  sessions,
  type Device,
} from "../db/schema";
import type { AppEnv } from "../env";
import { authenticateDevice, sha256Hex } from "../lib/auth";
import { ApiError, ok, readJson } from "../lib/http";
import { requireUuid } from "../lib/query";
import {
  deviceStartSessionSchema,
  heartbeatDeviceSchema,
  parseDate,
  provisionDeviceSchema,
  stopSessionSchema,
} from "../lib/validation";
import { publish } from "../live/publish";
import { startSession } from "../sessions/start";
import { stopResponse } from "../sessions/stop-response";
import { deviceView, randomHex } from "./view";

type DeviceHandler = (
  request: Request,
  device: Device,
  db: Database,
  context: Context<AppEnv>,
) => Promise<Response>;

/**
 * Verifies the device's HMAC signature over the exact request bytes, records
 * that the device was seen, runs the handler, then broadcasts the device
 * change. This contract is what firmware 0.2.5 signs against; keep it stable.
 */
function signed(handler: DeviceHandler) {
  return async (context: Context<AppEnv>): Promise<Response> => {
    const request = context.req.raw;
    const body = await request.text();
    const db = database(context.env.DB);
    const deviceId = request.headers.get("x-time-switch-device");
    const device = deviceId
      ? await db.select().from(devices).where(eq(devices.id, deviceId)).get()
      : undefined;
    if (!device || !device.secret || device.revokedAt) {
      throw new ApiError(
        401,
        "invalid_device_signature",
        "Device authentication failed.",
      );
    }
    await authenticateDevice(request, body, device.id, device.secret);
    const now = new Date();
    await db
      .update(devices)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(devices.id, device.id));
    const response = await handler(
      new Request(request, { body }),
      { ...device, lastSeenAt: now },
      db,
      context,
    );
    await publish(context.env, db, "device.changed");
    return response;
  };
}

export const deviceApiRoutes = new Hono<AppEnv>()
  .post("/device/v1/provision", async (context) => {
    const input = provisionDeviceSchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    const device = await db
      .select()
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .get();
    const tokenHash = await sha256Hex(input.setupToken);
    if (
      !device ||
      device.revokedAt ||
      !device.setupTokenHash ||
      device.setupTokenHash !== tokenHash ||
      !device.setupTokenExpiresAt ||
      device.setupTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new ApiError(
        401,
        "invalid_setup_token",
        "Device setup authorization is invalid or expired.",
      );
    }

    const now = new Date();
    const secret = randomHex(32);
    await db
      .update(devices)
      .set({
        secret,
        setupTokenHash: null,
        setupTokenExpiresAt: null,
        firmwareVersion: input.firmwareVersion,
        provisionedAt: now,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(devices.id, device.id));
    await publish(context.env, db, "device.changed");
    return ok({ deviceId: device.id, secret });
  })
  .post(
    "/device/v1/sessions/start",
    signed(async (request, _device, db, context) => {
      const input = deviceStartSessionSchema.parse(await readJson(request));
      const startedAt = parseDate(input.startedAt);
      const result = await startSession(
        db,
        { id: input.id, companyId: input.companyId, startedAt },
        { closeActiveAt: startedAt },
      );
      if (result.closedPrevious)
        await publish(
          context.env,
          db,
          "session.stopped",
          result.closedPrevious,
        );
      if (result.created)
        await publish(context.env, db, "session.started", result.session);
      return ok(result.session, { status: result.created ? 201 : 200 });
    }),
  )
  .post(
    "/device/v1/sessions/:id/stop",
    signed(async (request, _device, _db, context) => {
      const id = requireUuid(context.req.param("id") ?? "", "Session");
      const input = stopSessionSchema.parse(await readJson(request));
      return stopResponse(context.env, id, parseDate(input.endedAt), {
        tolerateMissing: true,
      });
    }),
  )
  .post(
    "/device/v1/health",
    signed(async (_request, _device, db) => {
      // Reading every table proves D1 is reachable and migrated without
      // exposing ledger data.
      await db.batch([
        db.select({ id: companies.id }).from(companies).limit(1),
        db.select({ id: sessions.id }).from(sessions).limit(1),
        db.select({ id: devices.id }).from(devices).limit(1),
        db.select({ id: hourRetrievals.id }).from(hourRetrievals).limit(1),
      ]);
      return ok({
        ok: true,
        service: "time-switch",
        storage: "ready",
        serverTime: new Date().toISOString(),
      });
    }),
  )
  .post(
    "/device/v1/heartbeat",
    signed(async (request, device, db) => {
      const input = heartbeatDeviceSchema.parse(await readJson(request));
      const [updated] = await db
        .update(devices)
        .set({ firmwareVersion: input.firmwareVersion, updatedAt: new Date() })
        .where(eq(devices.id, device.id))
        .returning();
      return ok(deviceView(updated));
    }),
  );
