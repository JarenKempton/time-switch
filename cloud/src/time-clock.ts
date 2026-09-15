import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Hono } from "hono";
import migrations from "../drizzle/migrations";
import {
  companies,
  devices,
  hourRetrievals,
  sessions,
  type Company,
  type Device,
  type HourRetrieval,
  type Session,
} from "./db/schema";
import { authenticateDevice, sha256Hex } from "./lib/auth";
import {
  ApiError,
  errorResponse,
  methodNotAllowed,
  ok,
  readJson,
} from "./lib/http";
import {
  createCompanySchema,
  createDeviceSchema,
  createRetrievalSchema,
  deviceStartSessionSchema,
  heartbeatDeviceSchema,
  parseDate,
  provisionDeviceSchema,
  startSessionSchema,
  stopSessionSchema,
  updateCompanySchema,
  updateSessionSchema,
} from "./lib/validation";

export interface TimeClockEnv {
  TIME_CLOCK: DurableObjectNamespace<TimeClock>;
  ASSETS: Fetcher;
  LOGOS: R2Bucket;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

interface SessionWithCompany extends Session {
  company: Company;
}

interface LiveMessage {
  type:
    | "snapshot"
    | "session.started"
    | "session.stopped"
    | "session.updated"
    | "session.deleted"
    | "company.changed"
    | "device.changed"
    | "retrieval.changed";
  status: { activeSession: SessionWithCompany | null; serverTime: string };
  session?: SessionWithCompany;
}

interface DeviceView {
  id: string;
  name: string;
  firmwareVersion: string | null;
  provisionedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SETUP_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function deviceView(device: Device): DeviceView {
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

function queryNumber(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 0), maximum)
    : fallback;
}

export class TimeClock extends DurableObject<TimeClockEnv> {
  private readonly app = new Hono();
  private readonly db: DrizzleSqliteDODatabase<{
    companies: typeof companies;
    devices: typeof devices;
    sessions: typeof sessions;
    hourRetrievals: typeof hourRetrievals;
  }>;

  constructor(ctx: DurableObjectState, env: TimeClockEnv) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, {
      schema: { companies, devices, sessions, hourRetrievals },
      logger: false,
    });
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
    this.configureRoutes();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.app.fetch(request);
  }

  private configureRoutes(): void {
    this.app.all("/api/v1/live", (context) =>
      this.openLiveSocket(context.req.raw),
    );
    this.app.all("/api/v1/status", (context) =>
      context.req.method === "GET"
        ? ok(this.getStatus())
        : methodNotAllowed(["GET"]),
    );
    this.app.all("/api/v1/companies", (context) =>
      this.handleCompanies(context.req.raw),
    );
    this.app.all("/api/v1/devices", (context) =>
      this.handleDevices(context.req.raw),
    );
    this.app.all("/api/v1/devices/:id/setup", (context) =>
      this.prepareDeviceSetup(context.req.raw, context.req.param("id")),
    );
    this.app.all("/api/v1/devices/:id", (context) =>
      this.handleDevice(context.req.raw, context.req.param("id")),
    );
    this.app.all("/api/v1/companies/:id", (context) =>
      this.handleCompany(
        context.req.raw,
        context.req.param("id"),
        new URL(context.req.url),
      ),
    );
    this.app.all("/api/v1/companies/:id/:subresource", (context) =>
      this.handleCompany(
        context.req.raw,
        `${context.req.param("id")}/${context.req.param("subresource")}`,
        new URL(context.req.url),
      ),
    );
    this.app.all("/api/v1/retrievals", (context) =>
      context.req.method === "GET"
        ? ok(this.listRetrievals(new URL(context.req.url)))
        : methodNotAllowed(["GET"]),
    );
    this.app.all("/api/v1/retrievals/:id", (context) =>
      this.handleRetrieval(context.req.raw, context.req.param("id")),
    );
    this.app.all("/api/v1/sessions", (context) =>
      this.handleSessions(context.req.raw, new URL(context.req.url)),
    );
    this.app.all("/api/v1/sessions/:id", (context) =>
      this.handleSession(context.req.raw, context.req.param("id")),
    );
    this.app.all("/api/v1/sessions/:id/stop", (context) =>
      this.handleSession(context.req.raw, `${context.req.param("id")}/stop`),
    );
    this.app.all("/api/v1/summary", (context) =>
      context.req.method === "GET"
        ? ok(this.getSummary(new URL(context.req.url)))
        : methodNotAllowed(["GET"]),
    );
    this.app.all("/api/v1/export.csv", (context) =>
      context.req.method === "GET"
        ? this.exportCsv(new URL(context.req.url))
        : methodNotAllowed(["GET"]),
    );
    this.app.all("/device/v1/provision", (context) =>
      context.req.method === "POST"
        ? this.provisionDevice(context.req.raw)
        : methodNotAllowed(["POST"]),
    );
    this.app.all("/device/v1/sessions/start", (context) =>
      this.authenticatedDeviceRequest(context.req.raw, (request) =>
        request.method === "POST"
          ? this.handleDeviceStart(request)
          : methodNotAllowed(["POST"]),
      ),
    );
    this.app.all("/device/v1/sessions/:id/stop", (context) =>
      this.authenticatedDeviceRequest(context.req.raw, (request) =>
        request.method === "POST"
          ? this.handleStop(request, context.req.param("id"))
          : methodNotAllowed(["POST"]),
      ),
    );
    this.app.all("/device/v1/health", (context) =>
      this.authenticatedDeviceRequest(context.req.raw, (request) =>
        request.method === "POST" ? this.health() : methodNotAllowed(["POST"]),
      ),
    );
    this.app.all("/device/v1/heartbeat", (context) =>
      this.authenticatedDeviceRequest(context.req.raw, (request, device) =>
        request.method === "POST"
          ? this.heartbeatDevice(request, device)
          : methodNotAllowed(["POST"]),
      ),
    );
    this.app.notFound(() =>
      errorResponse(new ApiError(404, "not_found", "Route not found.")),
    );
    this.app.onError((error) => errorResponse(this.normalizeError(error)));
  }

  private handleDevices(request: Request): Response | Promise<Response> {
    if (request.method === "GET") {
      return ok(
        this.db
          .select()
          .from(devices)
          .orderBy(asc(devices.name))
          .all()
          .map(deviceView),
      );
    }
    if (request.method === "POST") return this.createDevice(request);
    return methodNotAllowed(["GET", "POST"]);
  }

  private async createDevice(request: Request): Promise<Response> {
    const input = createDeviceSchema.parse(await readJson(request));
    const now = new Date();
    const setupToken = randomHex(32);
    const existing = this.db
      .select()
      .from(devices)
      .where(eq(devices.name, input.name))
      .get();
    if (existing && !existing.provisionedAt && !existing.revokedAt) {
      const updated = {
        ...existing,
        setupTokenHash: await sha256Hex(setupToken),
        setupTokenExpiresAt: new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS),
        updatedAt: now,
      };
      this.db
        .update(devices)
        .set({
          setupTokenHash: updated.setupTokenHash,
          setupTokenExpiresAt: updated.setupTokenExpiresAt,
          updatedAt: now,
        })
        .where(eq(devices.id, existing.id))
        .run();
      this.broadcast({ type: "device.changed", status: this.getStatus() });
      return ok({ device: deviceView(updated), setupToken }, { status: 201 });
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
      setupTokenHash: await sha256Hex(setupToken),
      setupTokenExpiresAt: new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS),
      firmwareVersion: null,
      provisionedAt: null,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(devices).values(device).run();
    this.broadcast({ type: "device.changed", status: this.getStatus() });
    return ok({ device: deviceView(device), setupToken }, { status: 201 });
  }

  private handleDevice(request: Request, id: string): Response {
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Device ID is invalid.");
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const existing = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "device_not_found", "Device not found.");
    this.db.delete(devices).where(eq(devices.id, id)).run();
    this.broadcast({ type: "device.changed", status: this.getStatus() });
    return ok({ id });
  }

  private async prepareDeviceSetup(
    request: Request,
    id: string,
  ): Promise<Response> {
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Device ID is invalid.");
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const existing = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "device_not_found", "Device not found.");

    const now = new Date();
    const setupToken = randomHex(32);
    const updated = {
      ...existing,
      setupTokenHash: await sha256Hex(setupToken),
      setupTokenExpiresAt: new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS),
      revokedAt: null,
      updatedAt: now,
    };
    this.db
      .update(devices)
      .set({
        setupTokenHash: updated.setupTokenHash,
        setupTokenExpiresAt: updated.setupTokenExpiresAt,
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(devices.id, id))
      .run();
    this.broadcast({ type: "device.changed", status: this.getStatus() });
    return ok({ device: deviceView(updated), setupToken });
  }

  private async provisionDevice(request: Request): Promise<Response> {
    const input = provisionDeviceSchema.parse(await readJson(request));
    const device = this.db
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
    this.db
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
      .where(eq(devices.id, device.id))
      .run();
    this.broadcast({ type: "device.changed", status: this.getStatus() });
    return ok({ deviceId: device.id, secret });
  }

  private async authenticatedDeviceRequest(
    request: Request,
    handler: (request: Request, device: Device) => Response | Promise<Response>,
  ): Promise<Response> {
    const body = await request.text();
    const deviceId = request.headers.get("x-time-switch-device");
    const device = deviceId
      ? this.db.select().from(devices).where(eq(devices.id, deviceId)).get()
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
    this.db
      .update(devices)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(devices.id, device.id))
      .run();
    const forwarded = new Request(request, { body });
    const response = await handler(forwarded, { ...device, lastSeenAt: now });
    this.broadcast({ type: "device.changed", status: this.getStatus() });
    return response;
  }

  private async heartbeatDevice(
    request: Request,
    device: Device,
  ): Promise<Response> {
    const input = heartbeatDeviceSchema.parse(await readJson(request));
    const now = new Date();
    this.db
      .update(devices)
      .set({ firmwareVersion: input.firmwareVersion, updatedAt: now })
      .where(eq(devices.id, device.id))
      .run();
    const updated = this.db
      .select()
      .from(devices)
      .where(eq(devices.id, device.id))
      .get()!;
    return ok(deviceView(updated));
  }

  private handleCompanies(request: Request): Response | Promise<Response> {
    if (request.method === "GET") {
      const includeArchived =
        new URL(request.url).searchParams.get("includeArchived") === "true";
      const rows = this.db
        .select()
        .from(companies)
        .where(includeArchived ? undefined : eq(companies.archived, false))
        .orderBy(asc(companies.name))
        .all();
      return ok(rows);
    }
    if (request.method === "POST") return this.createCompany(request);
    return methodNotAllowed(["GET", "POST"]);
  }

  private async createCompany(request: Request): Promise<Response> {
    const input = createCompanySchema.parse(await readJson(request));
    const now = new Date();
    const company: Company = {
      id: crypto.randomUUID(),
      name: input.name,
      logoUrl: input.logoUrl,
      color: input.color,
      payPeriodCadence: input.payPeriodCadence,
      payPeriodAnchorDate: input.payPeriodAnchorDate ?? localDate(now),
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(companies).values(company).run();
    this.broadcast({ type: "company.changed", status: this.getStatus() });
    return ok(company, { status: 201 });
  }

  private async handleCompany(
    request: Request,
    rest: string,
    url: URL,
  ): Promise<Response> {
    const [id, subresource] = rest.split("/");
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Company ID is invalid.");
    if (subresource === "retrievals") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return this.createRetrieval(request, id);
    }
    if (subresource === "hours") {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      return ok(this.getCompanyHours(id, url));
    }
    if (subresource !== undefined)
      throw new ApiError(404, "not_found", "Route not found.");
    if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
    const input = updateCompanySchema.parse(await readJson(request));
    const existing = this.db
      .select()
      .from(companies)
      .where(eq(companies.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "company_not_found", "Company not found.");
    if (input.archived === true) {
      const active = this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.companyId, id), isNull(sessions.endedAt)))
        .get();
      if (active)
        throw new ApiError(
          409,
          "company_in_use",
          "Stop the active session before archiving this company.",
        );
    }

    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.payPeriodCadence !== undefined
        ? { payPeriodCadence: input.payPeriodCadence }
        : {}),
      ...(input.payPeriodAnchorDate !== undefined
        ? { payPeriodAnchorDate: input.payPeriodAnchorDate }
        : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      updatedAt: new Date(),
    };
    this.db.update(companies).set(patch).where(eq(companies.id, id)).run();
    const updated = this.db
      .select()
      .from(companies)
      .where(eq(companies.id, id))
      .get()!;
    this.broadcast({ type: "company.changed", status: this.getStatus() });
    return ok(updated);
  }

  private handleSessions(
    request: Request,
    url: URL,
  ): Response | Promise<Response> {
    if (request.method === "GET") return ok(this.listSessions(url));
    if (request.method === "POST") return this.createDashboardSession(request);
    return methodNotAllowed(["GET", "POST"]);
  }

  private listSessions(url: URL): SessionWithCompany[] {
    const conditions = [];
    const companyId = url.searchParams.get("companyId");
    const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
    const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
    if (companyId) {
      if (!zUuid(companyId))
        throw new ApiError(400, "invalid_company_id", "Company ID is invalid.");
      conditions.push(eq(sessions.companyId, companyId));
    }
    if (from)
      conditions.push(
        or(isNull(sessions.endedAt), gt(sessions.endedAt, from))!,
      );
    if (to) conditions.push(lt(sessions.startedAt, to));
    const limit = queryNumber(url.searchParams.get("limit"), 100, 500);
    const offset = queryNumber(url.searchParams.get("offset"), 0, 100000);

    return this.db
      .select({ session: sessions, company: companies })
      .from(sessions)
      .innerJoin(companies, eq(sessions.companyId, companies.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(sessions.startedAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(({ session, company }) => ({ ...session, company }));
  }

  private async createDashboardSession(request: Request): Promise<Response> {
    const input = startSessionSchema.parse(await readJson(request));
    const result = this.startSession({
      id: input.id ?? crypto.randomUUID(),
      companyId: input.companyId,
      startedAt: parseDate(input.startedAt),
    });
    if (result.created) {
      this.broadcast({
        type: "session.started",
        status: this.getStatus(),
        session: result.session,
      });
    }
    return ok(result.session, { status: result.created ? 201 : 200 });
  }

  private async handleDeviceStart(request: Request): Promise<Response> {
    const input = deviceStartSessionSchema.parse(await readJson(request));
    const result = this.startSession({
      id: input.id,
      companyId: input.companyId,
      startedAt: parseDate(input.startedAt),
    });
    if (result.created) {
      this.broadcast({
        type: "session.started",
        status: this.getStatus(),
        session: result.session,
      });
    }
    return ok(result.session, { status: result.created ? 201 : 200 });
  }

  private health(): Response {
    // Reading both tables verifies that the Durable Object is reachable and all
    // checked-in Drizzle migrations were applied, without exposing ledger data.
    this.db.select({ id: companies.id }).from(companies).limit(1).all();
    this.db.select({ id: sessions.id }).from(sessions).limit(1).all();
    this.db.select({ id: devices.id }).from(devices).limit(1).all();
    this.db
      .select({ id: hourRetrievals.id })
      .from(hourRetrievals)
      .limit(1)
      .all();
    return ok({
      ok: true,
      service: "time-switch",
      storage: "ready",
      serverTime: new Date().toISOString(),
    });
  }

  private startSession(input: {
    id: string;
    companyId: string;
    startedAt: Date;
  }): {
    session: SessionWithCompany;
    created: boolean;
  } {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.id))
        .get();
      if (existing) {
        if (
          existing.companyId !== input.companyId ||
          existing.startedAt.getTime() !== input.startedAt.getTime()
        ) {
          throw new ApiError(
            409,
            "session_id_conflict",
            "That session ID is already used by different data.",
          );
        }
        const company = tx
          .select()
          .from(companies)
          .where(eq(companies.id, existing.companyId))
          .get()!;
        return { session: { ...existing, company }, created: false };
      }

      const company = tx
        .select()
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .get();
      if (!company || company.archived) {
        throw new ApiError(
          404,
          "company_not_found",
          "Active company not found.",
        );
      }
      const active = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(isNull(sessions.endedAt))
        .get();
      if (active)
        throw new ApiError(
          409,
          "session_already_active",
          "Stop the active session before starting another.",
        );

      const now = new Date();
      const session: Session = {
        id: input.id,
        companyId: input.companyId,
        startedAt: input.startedAt,
        endedAt: null,
        note: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(sessions).values(session).run();
      return { session: { ...session, company }, created: true };
    });
  }

  private async handleSession(request: Request, id: string): Promise<Response> {
    const stopMatch = id.match(/^([0-9a-f-]+)\/stop$/i);
    if (stopMatch) return this.handleStop(request, stopMatch[1]);
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Session ID is invalid.");
    if (request.method === "DELETE") return this.deleteSession(id);
    if (request.method !== "PATCH")
      return methodNotAllowed(["PATCH", "DELETE"]);
    const input = updateSessionSchema.parse(await readJson(request));
    const current = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!current)
      throw new ApiError(404, "session_not_found", "Session not found.");

    const companyId = input.companyId ?? current.companyId;
    const company = this.db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .get();
    if (!company)
      throw new ApiError(404, "company_not_found", "Company not found.");
    const startedAt = input.startedAt
      ? parseDate(input.startedAt)
      : current.startedAt;
    const endedAt =
      input.endedAt === undefined
        ? current.endedAt
        : input.endedAt === null
          ? null
          : parseDate(input.endedAt);
    if (endedAt && endedAt < startedAt) {
      throw new ApiError(
        422,
        "invalid_session_range",
        "Session end must be after its start.",
      );
    }
    if (!endedAt) {
      const another = this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(isNull(sessions.endedAt), ne(sessions.id, id)))
        .get();
      if (another)
        throw new ApiError(
          409,
          "session_already_active",
          "Another session is already active.",
        );
    }

    this.db
      .update(sessions)
      .set({
        companyId,
        startedAt,
        endedAt,
        note: input.note === undefined ? current.note : input.note,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, id))
      .run();
    const updated = this.getSession(id)!;
    this.broadcast({
      type: "session.updated",
      status: this.getStatus(),
      session: updated,
    });
    return ok(updated);
  }

  private deleteSession(id: string): Response {
    const existing = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "session_not_found", "Session not found.");
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
    this.broadcast({ type: "session.deleted", status: this.getStatus() });
    return ok({ id });
  }

  private async handleStop(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Session ID is invalid.");
    const input = stopSessionSchema.parse(await readJson(request));
    const endedAt = parseDate(input.endedAt);
    const result = this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      if (!current)
        throw new ApiError(404, "session_not_found", "Session not found.");
      const company = tx
        .select()
        .from(companies)
        .where(eq(companies.id, current.companyId))
        .get()!;
      if (current.endedAt) {
        if (current.endedAt.getTime() !== endedAt.getTime()) {
          throw new ApiError(
            409,
            "session_already_stopped",
            "That session was already stopped at a different time.",
          );
        }
        return { session: { ...current, company }, changed: false };
      }
      if (endedAt < current.startedAt) {
        throw new ApiError(
          422,
          "invalid_session_range",
          "Session end must be after its start.",
        );
      }
      tx.update(sessions)
        .set({ endedAt, updatedAt: new Date() })
        .where(eq(sessions.id, id))
        .run();
      const updated = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .get()!;
      return { session: { ...updated, company }, changed: true };
    });
    if (result.changed) {
      this.broadcast({
        type: "session.stopped",
        status: this.getStatus(),
        session: result.session,
      });
    }
    return ok({
      session: result.session,
      durationSeconds: Math.floor(
        (result.session.endedAt!.getTime() -
          result.session.startedAt.getTime()) /
          1000,
      ),
      status: this.getStatus(),
    });
  }

  private getSession(id: string): SessionWithCompany | null {
    const row = this.db
      .select({ session: sessions, company: companies })
      .from(sessions)
      .innerJoin(companies, eq(sessions.companyId, companies.id))
      .where(eq(sessions.id, id))
      .get();
    return row ? { ...row.session, company: row.company } : null;
  }

  private getStatus(): {
    activeSession: SessionWithCompany | null;
    serverTime: string;
  } {
    const row = this.db
      .select({ session: sessions, company: companies })
      .from(sessions)
      .innerJoin(companies, eq(sessions.companyId, companies.id))
      .where(isNull(sessions.endedAt))
      .get();
    return {
      activeSession: row ? { ...row.session, company: row.company } : null,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Seconds of work per company between two optional instants. Sessions are
   * clipped to the range and an active session counts up to now.
   */
  private totalsBetween(
    from: Date | null,
    to: Date | null,
    companyId?: string,
  ): { totals: Map<string, number>; sessionCount: number } {
    const now = new Date();
    const conditions = [];
    if (companyId) conditions.push(eq(sessions.companyId, companyId));
    if (from)
      conditions.push(
        or(isNull(sessions.endedAt), gt(sessions.endedAt, from))!,
      );
    if (to) conditions.push(lt(sessions.startedAt, to));
    const sessionRows = this.db
      .select()
      .from(sessions)
      .where(conditions.length ? and(...conditions) : undefined)
      .all();
    const totals = new Map<string, number>();
    let sessionCount = 0;
    for (const session of sessionRows) {
      const start = Math.max(
        session.startedAt.getTime(),
        from?.getTime() ?? Number.NEGATIVE_INFINITY,
      );
      const end = Math.min(
        (session.endedAt ?? now).getTime(),
        to?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      if (end > start) {
        sessionCount += 1;
        totals.set(
          session.companyId,
          (totals.get(session.companyId) ?? 0) + (end - start) / 1000,
        );
      }
    }
    return { totals, sessionCount };
  }

  private getSummary(url: URL) {
    const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
    const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
    if (from && to && from >= to)
      throw new ApiError(
        422,
        "invalid_range",
        "The end must be after the start.",
      );
    const companyRows = this.db
      .select()
      .from(companies)
      .orderBy(asc(companies.name))
      .all();
    const { totals } = this.totalsBetween(from, to);
    return {
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      companies: companyRows
        .filter((company) => !company.archived || totals.has(company.id))
        .map((company) => ({
          ...company,
          totalSeconds: Math.floor(totals.get(company.id) ?? 0),
        })),
    };
  }

  private getCompanyHours(companyId: string, url: URL) {
    const company = this.db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .get();
    if (!company)
      throw new ApiError(404, "company_not_found", "Company not found.");
    const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
    const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
    if (from && to && from >= to)
      throw new ApiError(
        422,
        "invalid_range",
        "The end must be after the start.",
      );
    const { totals, sessionCount } = this.totalsBetween(from, to, companyId);
    return {
      companyId,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      totalSeconds: Math.floor(totals.get(companyId) ?? 0),
      sessionCount,
    };
  }

  private listRetrievals(
    url: URL,
  ): Array<HourRetrieval & { company: Company }> {
    const companyId = url.searchParams.get("companyId");
    if (companyId && !zUuid(companyId))
      throw new ApiError(400, "invalid_company_id", "Company ID is invalid.");
    const limit = queryNumber(url.searchParams.get("limit"), 200, 1000);
    return this.db
      .select({ retrieval: hourRetrievals, company: companies })
      .from(hourRetrievals)
      .innerJoin(companies, eq(hourRetrievals.companyId, companies.id))
      .where(companyId ? eq(hourRetrievals.companyId, companyId) : undefined)
      .orderBy(desc(hourRetrievals.periodEnd), desc(hourRetrievals.createdAt))
      .limit(limit)
      .all()
      .map(({ retrieval, company }) => ({ ...retrieval, company }));
  }

  /**
   * Records that hours were retrieved for a company. The retrieval closes the
   * window [periodStart, periodEnd) and schedules the next window to end at
   * nextPeriodEnd. The total is computed server-side from the ledger so the
   * stored figure always matches the sessions at retrieval time.
   */
  private async createRetrieval(
    request: Request,
    companyId: string,
  ): Promise<Response> {
    const input = createRetrievalSchema.parse(await readJson(request));
    const periodStart = parseDate(input.periodStart);
    const periodEnd = parseDate(input.periodEnd);
    const nextPeriodEnd = parseDate(input.nextPeriodEnd);
    const result = this.db.transaction((tx) => {
      const company = tx
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .get();
      if (!company)
        throw new ApiError(404, "company_not_found", "Company not found.");
      const latest = tx
        .select()
        .from(hourRetrievals)
        .where(eq(hourRetrievals.companyId, companyId))
        .orderBy(desc(hourRetrievals.periodEnd))
        .get();
      if (latest && periodStart < latest.periodEnd) {
        throw new ApiError(
          409,
          "retrieval_overlap",
          "Those hours were already retrieved. Undo the last retrieval first.",
        );
      }
      const { totals } = this.totalsBetween(periodStart, periodEnd, companyId);
      const now = new Date();
      const retrieval: HourRetrieval = {
        id: crypto.randomUUID(),
        companyId,
        periodStart,
        periodEnd,
        nextPeriodEnd,
        totalSeconds: Math.floor(totals.get(companyId) ?? 0),
        note: input.note ?? null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(hourRetrievals).values(retrieval).run();
      let updatedCompany = company;
      if (input.reanchorDate) {
        tx.update(companies)
          .set({ payPeriodAnchorDate: input.reanchorDate, updatedAt: now })
          .where(eq(companies.id, companyId))
          .run();
        updatedCompany = {
          ...company,
          payPeriodAnchorDate: input.reanchorDate,
        };
      }
      return { ...retrieval, company: updatedCompany };
    });
    this.broadcast({ type: "retrieval.changed", status: this.getStatus() });
    return ok(result, { status: 201 });
  }

  private handleRetrieval(request: Request, id: string): Response {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Retrieval ID is invalid.");
    const existing = this.db
      .select()
      .from(hourRetrievals)
      .where(eq(hourRetrievals.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "retrieval_not_found", "Retrieval not found.");
    const newer = this.db
      .select({ id: hourRetrievals.id })
      .from(hourRetrievals)
      .where(
        and(
          eq(hourRetrievals.companyId, existing.companyId),
          gt(hourRetrievals.periodEnd, existing.periodEnd),
        ),
      )
      .get();
    if (newer)
      throw new ApiError(
        409,
        "retrieval_not_latest",
        "Only the most recent retrieval for a company can be undone.",
      );
    this.db.delete(hourRetrievals).where(eq(hourRetrievals.id, id)).run();
    this.broadcast({ type: "retrieval.changed", status: this.getStatus() });
    return ok({ id });
  }

  private exportCsv(url: URL): Response {
    const rows = this.listSessions(url);
    const header = [
      "session_id",
      "company",
      "started_at",
      "ended_at",
      "duration_seconds",
      "note",
    ];
    const lines = rows.map((row) => {
      const duration = row.endedAt
        ? Math.floor((row.endedAt.getTime() - row.startedAt.getTime()) / 1000)
        : "";
      return [
        row.id,
        row.company.name,
        row.startedAt.toISOString(),
        row.endedAt?.toISOString() ?? "",
        duration,
        row.note ?? "",
      ]
        .map(csvCell)
        .join(",");
    });
    return new Response([header.join(","), ...lines].join("\n"), {
      headers: {
        "content-disposition":
          'attachment; filename="time-switch-sessions.csv"',
        "content-type": "text/csv; charset=utf-8",
      },
    });
  }

  private openLiveSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(
        426,
        "upgrade_required",
        "A WebSocket upgrade is required.",
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(
      JSON.stringify({
        type: "snapshot",
        status: this.getStatus(),
      } satisfies LiveMessage),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Unexpected WebSocket error");
  }

  private broadcast(message: LiveMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        socket.close(1011, "Unable to deliver update");
      }
    }
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof ApiError) return error;
    if (error && typeof error === "object" && "issues" in error) {
      return new ApiError(422, "validation_error", "Request data is invalid.");
    }
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: companies\.name/.test(error.message)
    ) {
      return new ApiError(
        409,
        "company_name_conflict",
        "A company with that name already exists.",
      );
    }
    return error;
  }
}

function parseOptionalQueryDate(
  value: string | null,
  name: string,
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ApiError(
      400,
      `invalid_${name}`,
      `${name} must be an ISO date or timestamp.`,
    );
  return date;
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function localDate(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
