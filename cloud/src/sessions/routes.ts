import { and, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { database } from "../db/client";
import { sessions } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError, ok, readJson } from "../lib/http";
import { requireUuid } from "../lib/query";
import {
  parseDate,
  startSessionSchema,
  stopSessionSchema,
  updateSessionSchema,
} from "../lib/validation";
import { publish } from "../live/publish";
import {
  getCompany,
  getSession,
  getStatus,
  listSessions,
  MIN_SESSION_MS,
} from "./queries";
import { startSession } from "./start";
import { stopResponse } from "./stop-response";

export const sessionRoutes = new Hono<AppEnv>()
  .get("/api/v1/status", async (context) =>
    ok(await getStatus(database(context.env.DB))),
  )
  .get("/api/v1/sessions", async (context) =>
    ok(await listSessions(database(context.env.DB), new URL(context.req.url))),
  )
  .post("/api/v1/sessions", async (context) => {
    const input = startSessionSchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    const result = await startSession(db, {
      id: input.id ?? crypto.randomUUID(),
      companyId: input.companyId,
      startedAt: parseDate(input.startedAt),
    });
    if (result.created)
      await publish(context.env, db, "session.started", result.session);
    return ok(result.session, { status: result.created ? 201 : 200 });
  })
  .post("/api/v1/sessions/:id/stop", async (context) => {
    const id = requireUuid(context.req.param("id"), "Session");
    const input = stopSessionSchema.parse(await readJson(context.req.raw));
    return stopResponse(context.env, id, parseDate(input.endedAt));
  })
  .patch("/api/v1/sessions/:id", async (context) => {
    const id = requireUuid(context.req.param("id"), "Session");
    const input = updateSessionSchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    const current = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get();
    if (!current)
      throw new ApiError(404, "session_not_found", "Session not found.");

    const companyId = input.companyId ?? current.companyId;
    if (!(await getCompany(db, companyId)))
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
    if (endedAt && endedAt.getTime() - startedAt.getTime() < MIN_SESSION_MS) {
      throw new ApiError(
        422,
        "session_too_short",
        "Sessions shorter than a minute are not kept.",
      );
    }
    if (!endedAt) {
      const another = await db
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

    await db
      .update(sessions)
      .set({
        companyId,
        startedAt,
        endedAt,
        note: input.note === undefined ? current.note : input.note,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, id));
    const updated = (await getSession(db, id))!;
    await publish(context.env, db, "session.updated", updated);
    return ok(updated);
  })
  .delete("/api/v1/sessions/:id", async (context) => {
    const id = requireUuid(context.req.param("id"), "Session");
    const db = database(context.env.DB);
    const deleted = await db
      .delete(sessions)
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id });
    if (!deleted.length)
      throw new ApiError(404, "session_not_found", "Session not found.");
    await publish(context.env, db, "session.deleted");
    return ok({ id });
  });
