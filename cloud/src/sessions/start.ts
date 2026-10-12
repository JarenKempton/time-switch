import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions, type Session } from "../db/schema";
import { ApiError } from "../lib/http";
import { violatesUnique } from "../lib/normalize-error";
import { getCompany, type SessionWithCompany } from "./queries";

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
    const company = (await getCompany(db, existing.companyId))!;
    return { session: { ...existing, company }, created: false };
  }

  const company = await getCompany(db, input.companyId);
  if (!company || company.archived) {
    throw new ApiError(404, "company_not_found", "Active company not found.");
  }
  const active = await db
    .select()
    .from(sessions)
    .where(isNull(sessions.endedAt))
    .get();
  if (active && !options.closeActiveAt) {
    throw new ApiError(
      409,
      "session_already_active",
      "Stop the active session before starting another.",
    );
  }

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
  if (!active || !options.closeActiveAt) {
    await db.insert(sessions).values(session);
    return { session: { ...session, company }, created: true };
  }

  // A device start means the physical switch moved, so it implicitly ends
  // whatever was running at the flip moment rather than refusing with a 409
  // that the firmware would drop as a permanent rejection.
  const endedAt =
    options.closeActiveAt.getTime() >= active.startedAt.getTime()
      ? options.closeActiveAt
      : active.startedAt;
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
