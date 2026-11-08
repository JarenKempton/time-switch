import type { Env } from "../env";
import { LIVE_PATH } from "../live/routes";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Reads a desktop client needs to show the current session and totals. */
const BAR_READS = [
  /^\/api\/v1\/status$/,
  /^\/api\/v1\/companies$/,
  /^\/api\/v1\/sessions$/,
  /^\/api\/v1\/summary$/,
  new RegExp(`^/api/v1/companies/${UUID}/period$`, "i"),
  /^\/logos\/[^/]+$/,
];

/** Starting and stopping a session; nothing else may be written. */
const BAR_WRITES = [
  /^\/api\/v1\/sessions$/,
  new RegExp(`^/api/v1/sessions/${UUID}/stop$`, "i"),
];

export type ServiceAccess = "allowed" | "read_only" | "forbidden";

/**
 * Decides what an Access service token may do. Every service token may open
 * the live event stream. Only the token named by BAR_SERVICE_TOKEN may also
 * read status and totals and start or stop sessions.
 */
export function serviceAccess(
  request: Request,
  path: string,
  clientId: string,
  env: Env,
): ServiceAccess {
  const method = request.method.toUpperCase();
  if (method === "GET" && path === LIVE_PATH) return "allowed";
  if (!env.BAR_SERVICE_TOKEN || clientId !== env.BAR_SERVICE_TOKEN)
    return "read_only";
  if (method === "GET" && BAR_READS.some((route) => route.test(path)))
    return "allowed";
  if (method === "POST" && BAR_WRITES.some((route) => route.test(path)))
    return "allowed";
  return "forbidden";
}
