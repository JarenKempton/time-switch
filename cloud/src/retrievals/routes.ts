import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { database } from "../db/client";
import { companies, hourRetrievals, type HourRetrieval } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError, ok, readJson } from "../lib/http";
import { isUuid, queryNumber, requireUuid } from "../lib/query";
import { createRetrievalSchema, parseDate } from "../lib/validation";
import { publish } from "../live/publish";
import { openPeriodStart, totalsBetween } from "../reports/totals";
import { getCompany } from "../sessions/queries";

export const retrievalRoutes = new Hono<AppEnv>()
  .get("/api/v1/retrievals", async (context) => {
    const companyId = context.req.query("companyId");
    if (companyId && !isUuid(companyId))
      throw new ApiError(400, "invalid_company_id", "Company ID is invalid.");
    const limit = queryNumber(context.req.query("limit") ?? null, 200, 1000);
    const rows = await database(context.env.DB)
      .select({ retrieval: hourRetrievals, company: companies })
      .from(hourRetrievals)
      .innerJoin(companies, eq(hourRetrievals.companyId, companies.id))
      .where(companyId ? eq(hourRetrievals.companyId, companyId) : undefined)
      .orderBy(desc(hourRetrievals.periodEnd), desc(hourRetrievals.createdAt))
      .limit(limit)
      .all();
    return ok(
      rows.map(({ retrieval, company }) => ({ ...retrieval, company })),
    );
  })
  /**
   * Closes the open pay period for a company at `periodEnd`. The period starts
   * where the previous retrieval ended (or at the company's first session), so
   * consecutive retrievals tile the timeline; a unique (company, period start)
   * index rejects a concurrent duplicate. The total is computed server-side so
   * the stored figure matches the ledger.
   */
  .post("/api/v1/companies/:id/retrievals", async (context) => {
    const companyId = requireUuid(context.req.param("id"), "Company");
    const input = createRetrievalSchema.parse(await readJson(context.req.raw));
    const periodEnd = parseDate(input.periodEnd);
    const now = new Date();
    if (periodEnd > now) {
      throw new ApiError(
        422,
        "retrieval_in_future",
        "A pay period cannot end in the future.",
      );
    }
    const db = database(context.env.DB);
    const company = await getCompany(db, companyId);
    if (!company)
      throw new ApiError(404, "company_not_found", "Company not found.");
    const periodStart = await openPeriodStart(db, companyId);
    if (periodEnd <= periodStart) {
      throw new ApiError(
        409,
        "retrieval_overlap",
        "Those hours were already retrieved. Undo the last retrieval first.",
      );
    }
    const { totals } = await totalsBetween(
      db,
      periodStart,
      periodEnd,
      companyId,
    );
    const retrieval: HourRetrieval = {
      id: crypto.randomUUID(),
      companyId,
      periodStart,
      periodEnd,
      totalSeconds: Math.floor(totals.get(companyId) ?? 0),
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(hourRetrievals).values(retrieval);
    await publish(context.env, db, "retrieval.changed");
    return ok({ ...retrieval, company }, { status: 201 });
  })
  .delete("/api/v1/retrievals/:id", async (context) => {
    const id = requireUuid(context.req.param("id"), "Retrieval");
    const db = database(context.env.DB);
    const existing = await db
      .select()
      .from(hourRetrievals)
      .where(eq(hourRetrievals.id, id))
      .get();
    if (!existing)
      throw new ApiError(404, "retrieval_not_found", "Retrieval not found.");
    const newer = await db
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
    await db.delete(hourRetrievals).where(eq(hourRetrievals.id, id));
    await publish(context.env, db, "retrieval.changed");
    return ok({ id });
  });
