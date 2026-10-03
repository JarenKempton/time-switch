import { database } from "../db/client";
import type { Env } from "../env";
import { ok } from "../lib/http";
import { publish } from "../live/publish";
import { getStatus } from "./queries";
import { stopSession } from "./stop";

export async function stopResponse(
  env: Env,
  id: string,
  endedAt: Date,
  options: { tolerateMissing?: boolean } = {},
): Promise<Response> {
  const db = database(env.DB);
  const result = await stopSession(db, id, endedAt, options);
  if (!result) {
    return ok({
      session: null,
      durationSeconds: 0,
      discarded: true,
      status: await getStatus(db),
    });
  }
  if (result.changed === "discarded") await publish(env, db, "session.deleted");
  else if (result.changed)
    await publish(env, db, "session.stopped", result.session);
  return ok({
    session: result.session,
    durationSeconds: Math.floor(
      (result.session.endedAt!.getTime() - result.session.startedAt.getTime()) /
        1000,
    ),
    discarded: result.changed === "discarded",
    status: await getStatus(db),
  });
}
