import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions, type Session } from "../db/schema";
import { ApiError } from "../lib/http";
import { violatesUnique } from "../lib/normalize-error";
import { getCompany, MIN_SESSION_MS, type SessionWithCompany } from "./queries";

const MAX_ATTEMPTS = 3;

export interface StartInput {
  id: string;
  companyId: string;
  startedAt: Date;
}

export interface StartOptions {
  closeActiveAt?: Date;
}

export interface StartResult {
  session: SessionWithCompany;
  created: boolean;
  resumed?: boolean;
  discardedPrevious?: boolean;
  closedPrevious?: SessionWithCompany;
}

/**
 * Concurrent starts race on the session primary key and the one-open-session
 * index. The loser re-reads and resolves as an idempotent replay, a device
 * flip that closes the winner, or a dashboard 409.
 */
export async function startSession(
  db: Database,
  input: StartInput,
  options: StartOptions = {},
): Promise<StartResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptStart(db, input, options);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !violatesUnique(error)) throw error;
    }
  }
}

async function attemptStart(
  db: Database,
  input: StartInput,
  options: StartOptions,
): Promise<StartResult> {
  const existing = await db
    .select()
    .from(sessions)
    .where(
      or(eq(sessions.id, input.id), eq(sessions.deviceSessionId, input.id)),
    )
    .get();
  if (existing) {
    // A replayed start for an adopted session keeps the adopting session's
    // own start time, so only the company has to match.
    const adopted = existing.id !== input.id;
    if (
      existing.companyId !== input.companyId ||
      (!adopted && existing.startedAt.getTime() !== input.startedAt.getTime())
    ) {
      throw new ApiError(
        409,
        "session_id_conflict",
        "That session ID is already used by different data.",
      );
    }
    const company = (await getCompany(db, existing.companyId))!;
    return { session: { ...existing, company }, created: false };
  }

  const company = await getCompany(db, input.companyId);
  if (!company || company.archived) {
    throw new ApiError(404, "company_not_found", "Active company not found.");
  }
  let active = await db
    .select()
    .from(sessions)
    .where(isNull(sessions.endedAt))
    .get();
  const flipAt = options.closeActiveAt;
  if (active && !flipAt) {
    throw new ApiError(
      409,
      "session_already_active",
      "Stop the active session before starting another.",
    );
  }

  const now = new Date();
  if (active && flipAt && active.companyId === input.companyId) {
    // The switch was flipped to the company that is already running (say it
    // was started from the dashboard first). Keep that session untouched and
    // remember the switch's ID for it, so the switch's later stop ends it.
    const [adopted] = await db
      .update(sessions)
      .set({ deviceSessionId: input.id, updatedAt: now })
      .where(and(eq(sessions.id, active.id), isNull(sessions.endedAt)))
      .returning();
    // Stopped in the meantime: start over and take the normal path.
    if (!adopted) return attemptStart(db, input, options);
    return { session: { ...adopted, company }, created: false };
  }

  let discardedPrevious = false;
  if (active && flipAt && isBrief(active, flipAt)) {
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.id, active.id), isNull(sessions.endedAt)))
      .returning();
    discardedPrevious = deleted.length > 0;
    active = undefined;
  }

  if (flipAt && !active) {
    const resumable = await endedJustBefore(db, input);
    if (resumable) {
      const [resumed] = await db
        .update(sessions)
        .set({ endedAt: null, deviceSessionId: input.id, updatedAt: now })
        .where(and(eq(sessions.id, resumable.id), isNotNull(sessions.endedAt)))
        .returning();
      if (!resumed) return attemptStart(db, input, options);
      return {
        session: { ...resumed, company },
        created: false,
        resumed: true,
        discardedPrevious,
      };
    }
  }

  const session: Session = {
    id: input.id,
    companyId: input.companyId,
    startedAt: input.startedAt,
    endedAt: null,
    note: null,
    deviceSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!active || !flipAt) {
    await db.insert(sessions).values(session);
    return {
      session: { ...session, company },
      created: true,
      discardedPrevious,
    };
  }

  // A device start for another company means the physical switch moved, so it
  // implicitly ends whatever was running at the flip moment rather than refusing with a 409
  // that the firmware would drop as a permanent rejection.
  const endedAt =
    flipAt.getTime() >= active.startedAt.getTime() ? flipAt : active.startedAt;
  const [closed] = await db.batch([
    db
      .update(sessions)
      .set({ endedAt, updatedAt: now })
      .where(and(eq(sessions.id, active.id), isNull(sessions.endedAt)))
      .returning(),
    db.insert(sessions).values(session),
  ]);
  const closedSession = closed[0];
  return {
    session: { ...session, company },
    created: true,
    closedPrevious: closedSession && {
      ...closedSession,
      company: (await getCompany(db, closedSession.companyId))!,
    },
  };
}

function isBrief(session: Session, endedAt: Date): boolean {
  return endedAt.getTime() - session.startedAt.getTime() < MIN_SESSION_MS;
}

async function endedJustBefore(
  db: Database,
  input: StartInput,
): Promise<Session | undefined> {
  const last = await db
    .select()
    .from(sessions)
    .where(isNotNull(sessions.endedAt))
    .orderBy(desc(sessions.endedAt))
    .get();
  if (!last || last.companyId !== input.companyId) return undefined;
  const gap = input.startedAt.getTime() - last.endedAt!.getTime();
  return gap >= 0 && gap < MIN_SESSION_MS ? last : undefined;
}
