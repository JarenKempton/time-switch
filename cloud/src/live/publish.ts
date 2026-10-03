import type { Database } from "../db/client";
import type { Env } from "../env";
import {
  getStatus,
  type SessionWithCompany,
  type Status,
} from "../sessions/queries";

export type LiveEventType =
  | "snapshot"
  | "session.started"
  | "session.stopped"
  | "session.updated"
  | "session.deleted"
  | "company.changed"
  | "device.changed"
  | "retrieval.changed";

export interface LiveMessage {
  type: LiveEventType;
  status: Status;
  session?: SessionWithCompany;
}

export function liveHub(env: Env) {
  return env.TIME_CLOCK.getByName("primary");
}

export async function encodeLiveMessage(
  db: Database,
  type: LiveEventType,
  session?: SessionWithCompany,
): Promise<string> {
  const message: LiveMessage = { type, status: await getStatus(db) };
  if (session) message.session = session;
  return JSON.stringify(message);
}

/**
 * Called only after a D1 write commits. Delivery is best effort: the write
 * already succeeded, and clients resynchronise from a fresh snapshot on
 * reconnect, so a failed broadcast is logged rather than failing the request.
 */
export async function publish(
  env: Env,
  db: Database,
  type: LiveEventType,
  session?: SessionWithCompany,
): Promise<void> {
  try {
    await liveHub(env).broadcast(await encodeLiveMessage(db, type, session));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "live.broadcast_failed",
        type,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
