import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { companies, hourRetrievals, sessions } from "../db/schema";

/**
 * Seconds of work per company between two optional instants. Sessions are
 * clipped to the range and an active session counts up to now.
 */
export async function totalsBetween(
  db: Database,
  from: Date | null,
  to: Date | null,
  companyId?: string,
): Promise<{ totals: Map<string, number>; sessionCount: number }> {
  const now = new Date();
  const conditions = [];
  if (companyId) conditions.push(eq(sessions.companyId, companyId));
  if (from)
    conditions.push(or(isNull(sessions.endedAt), gt(sessions.endedAt, from))!);
  if (to) conditions.push(lt(sessions.startedAt, to));
  const sessionRows = await db
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

/**
 * Where the company's open period begins: the end of its latest retrieval,
 * else the start of its earliest session, else its creation time.
 */
export async function openPeriodStart(
  db: Database,
  companyId: string,
): Promise<Date> {
  const latest = await db
    .select({ periodEnd: hourRetrievals.periodEnd })
    .from(hourRetrievals)
    .where(eq(hourRetrievals.companyId, companyId))
    .orderBy(desc(hourRetrievals.periodEnd))
    .get();
  if (latest) return latest.periodEnd;
  const first = await db
    .select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(eq(sessions.companyId, companyId))
    .orderBy(asc(sessions.startedAt))
    .get();
  if (first) return first.startedAt;
  const company = await db
    .select({ createdAt: companies.createdAt })
    .from(companies)
    .where(eq(companies.id, companyId))
    .get();
  return company!.createdAt;
}
