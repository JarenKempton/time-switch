import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { companies, sessions, type Company, type Session } from "../db/schema";
import { ApiError } from "../lib/http";
import { isUuid, parseOptionalQueryDate, queryNumber } from "../lib/query";

export interface SessionWithCompany extends Session {
  company: Company;
}

export interface Status {
  activeSession: SessionWithCompany | null;
  serverTime: string;
}

/** Sessions shorter than this are treated as accidental and never kept. */
export const MIN_SESSION_MS = 60 * 1000;

function selectWithCompany(db: Database) {
  return db
    .select({ session: sessions, company: companies })
    .from(sessions)
    .innerJoin(companies, eq(sessions.companyId, companies.id));
}

export async function getSession(
  db: Database,
  id: string,
): Promise<SessionWithCompany | null> {
  const row = await selectWithCompany(db).where(eq(sessions.id, id)).get();
  return row ? { ...row.session, company: row.company } : null;
}

export async function getStatus(db: Database): Promise<Status> {
  const row = await selectWithCompany(db).where(isNull(sessions.endedAt)).get();
  return {
    activeSession: row ? { ...row.session, company: row.company } : null,
    serverTime: new Date().toISOString(),
  };
}

export async function getCompany(
  db: Database,
  id: string,
): Promise<Company | undefined> {
  return db.select().from(companies).where(eq(companies.id, id)).get();
}

export async function listSessions(
  db: Database,
  url: URL,
): Promise<SessionWithCompany[]> {
  const conditions = [];
  const companyId = url.searchParams.get("companyId");
  const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
  const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
  if (companyId) {
    if (!isUuid(companyId))
      throw new ApiError(400, "invalid_company_id", "Company ID is invalid.");
    conditions.push(eq(sessions.companyId, companyId));
  }
  if (from)
    conditions.push(or(isNull(sessions.endedAt), gt(sessions.endedAt, from))!);
  if (to) conditions.push(lt(sessions.startedAt, to));
  const limit = queryNumber(url.searchParams.get("limit"), 100, 500);
  const offset = queryNumber(url.searchParams.get("offset"), 0, 100000);

  const rows = await selectWithCompany(db)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sessions.startedAt))
    .limit(limit)
    .offset(offset)
    .all();
  return rows.map(({ session, company }) => ({ ...session, company }));
}
