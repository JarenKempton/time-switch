import { asc } from "drizzle-orm";
import { Hono } from "hono";
import { database } from "../db/client";
import { companies } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError, ok } from "../lib/http";
import { readRange, requireUuid } from "../lib/query";
import { getCompany, listSessions } from "../sessions/queries";
import { openPeriodStart, totalsBetween } from "./totals";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const reportRoutes = new Hono<AppEnv>()
  .get("/api/v1/summary", async (context) => {
    const { from, to } = readRange(new URL(context.req.url));
    const db = database(context.env.DB);
    const companyRows = await db
      .select()
      .from(companies)
      .orderBy(asc(companies.name))
      .all();
    const { totals } = await totalsBetween(db, from, to);
    return ok({
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      companies: companyRows
        .filter((company) => !company.archived || totals.has(company.id))
        .map((company) => ({
          ...company,
          totalSeconds: Math.floor(totals.get(company.id) ?? 0),
        })),
    });
  })
  .get("/api/v1/companies/:id/hours", async (context) => {
    const companyId = requireUuid(context.req.param("id"), "Company");
    const db = database(context.env.DB);
    if (!(await getCompany(db, companyId)))
      throw new ApiError(404, "company_not_found", "Company not found.");
    const { from, to } = readRange(new URL(context.req.url));
    const { totals, sessionCount } = await totalsBetween(
      db,
      from,
      to,
      companyId,
    );
    return ok({
      companyId,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      totalSeconds: Math.floor(totals.get(companyId) ?? 0),
      sessionCount,
    });
  })
  .get("/api/v1/companies/:id/period", async (context) => {
    const companyId = requireUuid(context.req.param("id"), "Company");
    const db = database(context.env.DB);
    if (!(await getCompany(db, companyId)))
      throw new ApiError(404, "company_not_found", "Company not found.");
    const start = await openPeriodStart(db, companyId);
    const { totals, sessionCount } = await totalsBetween(
      db,
      start,
      null,
      companyId,
    );
    return ok({
      companyId,
      start: start.toISOString(),
      totalSeconds: Math.floor(totals.get(companyId) ?? 0),
      sessionCount,
    });
  })
  .get("/api/v1/export.csv", async (context) => {
    const rows = await listSessions(
      database(context.env.DB),
      new URL(context.req.url),
    );
    const header = [
      "session_id",
      "company",
      "started_at",
      "ended_at",
      "duration_seconds",
      "note",
    ];
    const lines = rows.map((row) =>
      [
        row.id,
        row.company.name,
        row.startedAt.toISOString(),
        row.endedAt?.toISOString() ?? "",
        row.endedAt
          ? Math.floor((row.endedAt.getTime() - row.startedAt.getTime()) / 1000)
          : "",
        row.note ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    return new Response([header.join(","), ...lines].join("\n"), {
      headers: {
        "content-disposition":
          'attachment; filename="time-switch-sessions.csv"',
        "content-type": "text/csv; charset=utf-8",
      },
    });
  });
