import { Hono } from "hono";
import { database } from "../db/client";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/http";
import { SNAPSHOT_HEADER } from "../time-clock";
import { encodeLiveMessage, liveHub } from "./publish";

export const LIVE_PATH = "/api/v1/live";

export const liveRoutes = new Hono<AppEnv>().get(LIVE_PATH, async (context) => {
  const request = context.req.raw;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(
      426,
      "upgrade_required",
      "A WebSocket upgrade is required.",
    );
  }
  const headers = new Headers(request.headers);
  headers.set(
    SNAPSHOT_HEADER,
    await encodeLiveMessage(database(context.env.DB), "snapshot"),
  );
  return liveHub(context.env).fetch(new Request(request, { headers }));
});
