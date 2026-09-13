import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle/migrations";
import { companies, sessions, type Company, type Session } from "./db/schema";
import {
  ApiError,
  errorResponse,
  methodNotAllowed,
  ok,
  readJson,
} from "./lib/http";
import {
  createCompanySchema,
  deviceStartSessionSchema,
  parseDate,
  startSessionSchema,
  stopSessionSchema,
  updateCompanySchema,
  updateSessionSchema,
} from "./lib/validation";

export interface TimeClockEnv {
  TIME_CLOCK: DurableObjectNamespace<TimeClock>;
  ASSETS: Fetcher;
  DEVICE_HMAC_SECRET?: string;
  DEVICE_ID: string;
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
    | "company.changed";
  status: { activeSession: SessionWithCompany | null; serverTime: string };
  session?: SessionWithCompany;
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
  private readonly db: DrizzleSqliteDODatabase<{
    companies: typeof companies;
    sessions: typeof sessions;
  }>;

  constructor(ctx: DurableObjectState, env: TimeClockEnv) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, {
      schema: { companies, sessions },
      logger: false,
    });
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/v1/live") return this.openLiveSocket(request);
      if (path === "/api/v1/status" && request.method === "GET")
        return ok(this.getStatus());
      if (path === "/api/v1/companies")
        return await this.handleCompanies(request);
      if (path.startsWith("/api/v1/companies/"))
        return await this.handleCompany(request, path.slice(18));
      if (path === "/api/v1/sessions")
        return await this.handleSessions(request, url);
      if (path.startsWith("/api/v1/sessions/"))
        return await this.handleSession(request, path.slice(17));
      if (path === "/api/v1/summary" && request.method === "GET")
        return ok(this.getSummary(url));
      if (path === "/api/v1/export.csv" && request.method === "GET")
        return this.exportCsv(url);
      if (path === "/device/v1/sessions/start" && request.method === "POST") {
        return await this.handleDeviceStart(request);
      }
      if (path === "/device/v1/health" && request.method === "POST") {
        return this.health();
      }
      const deviceStop = path.match(
        /^\/device\/v1\/sessions\/([0-9a-f-]+)\/stop$/i,
      );
      if (deviceStop && request.method === "POST")
        return await this.handleStop(request, deviceStop[1]);

      return errorResponse(new ApiError(404, "not_found", "Route not found."));
    } catch (error) {
      return errorResponse(this.normalizeError(error));
    }
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

  private async handleCompany(request: Request, id: string): Promise<Response> {
    if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
    if (!zUuid(id))
      throw new ApiError(400, "invalid_id", "Company ID is invalid.");
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
    if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
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

  private getSummary(url: URL) {
    const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
    const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
    if (from && to && from >= to)
      throw new ApiError(
        422,
        "invalid_range",
        "The end must be after the start.",
      );
    const now = new Date();
    const companyRows = this.db
      .select()
      .from(companies)
      .orderBy(asc(companies.name))
      .all();
    const conditions = [];
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
    for (const session of sessionRows) {
      const start = Math.max(
        session.startedAt.getTime(),
        from?.getTime() ?? Number.NEGATIVE_INFINITY,
      );
      const end = Math.min(
        (session.endedAt ?? now).getTime(),
        to?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      if (end > start)
        totals.set(
          session.companyId,
          (totals.get(session.companyId) ?? 0) + (end - start) / 1000,
        );
    }
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
