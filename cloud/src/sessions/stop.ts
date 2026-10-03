import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions } from "../db/schema";
import { ApiError } from "../lib/http";
import { getCompany, MIN_SESSION_MS, type SessionWithCompany } from "./queries";

export interface StopResult {
  session: SessionWithCompany;
  changed: boolean | "discarded";
}

/**
 * Stops a session. Anything shorter than a minute is an accidental flick of
 * the switch, so the row is deleted instead of closed. Stopping an already
 * stopped session is idempotent and keeps the first recorded end, so a device
 * replaying a queued stop never poisons its offline queue. With
 * `tolerateMissing`, a stop for a session that no longer exists returns null.
 */
export async function stopSession(
  db: Database,
  id: string,
  endedAt: Date,
  options: { tolerateMissing?: boolean } = {},
): Promise<StopResult | null> {
  const current = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();
  if (!current) {
    if (options.tolerateMissing) return null;
    throw new ApiError(404, "session_not_found", "Session not found.");
  }
  const company = (await getCompany(db, current.companyId))!;
  if (current.endedAt)
    return { session: { ...current, company }, changed: false };
  if (endedAt < current.startedAt) {
    throw new ApiError(
      422,
      "invalid_session_range",
      "Session end must be after its start.",
    );
  }

  const stillOpen = and(eq(sessions.id, id), isNull(sessions.endedAt));
  if (endedAt.getTime() - current.startedAt.getTime() < MIN_SESSION_MS) {
    const deleted = await db.delete(sessions).where(stillOpen).returning();
    if (!deleted.length) return stopSession(db, id, endedAt, options);
    return { session: { ...current, endedAt, company }, changed: "discarded" };
  }
  const [updated] = await db
    .update(sessions)
    .set({ endedAt, updatedAt: new Date() })
    .where(stillOpen)
    .returning();
  if (!updated) return stopSession(db, id, endedAt, options);
  return { session: { ...updated, company }, changed: true };
}
