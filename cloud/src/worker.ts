import { Hono } from "hono";
import { companyRoutes } from "./companies/routes";
import { deviceApiRoutes } from "./devices/api";
import { deviceRoutes } from "./devices/routes";
import type { AppEnv, Env } from "./env";
import { requireAccess } from "./lib/cloudflare-access";
import { ApiError, errorResponse } from "./lib/http";
import {
  LOGO_PATH_PREFIX,
  deleteLogo,
  listLogos,
  serveLogo,
  uploadLogo,
} from "./lib/logos";
import { normalizeError } from "./lib/normalize-error";
import { LIVE_PATH, liveRoutes } from "./live/routes";
import { reportRoutes } from "./reports/routes";
import { retrievalRoutes } from "./retrievals/routes";
import { sessionRoutes } from "./sessions/routes";
import { TimeClock } from "./time-clock";

export { TimeClock };

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), serial=(self)",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

function withResponseHeaders(
  response: Response,
  requestId: string,
  versionId: string,
  noStore: boolean,
): Response {
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    result.headers.set(name, value);
  result.headers.set("x-request-id", requestId);
  result.headers.set("x-worker-version", versionId);
  if (noStore) result.headers.set("cache-control", "no-store");
  return result;
}

function routeLabel(path: string): string {
  return path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    "/:id",
  );
}

const app = new Hono<AppEnv>();

app.use("/device/*", async (context, next) => {
  if (context.req.method !== "POST") {
    throw new ApiError(405, "method_not_allowed", "Method not allowed.");
  }
  await next();
});
app.route("/", deviceApiRoutes);

app.get(`${LOGO_PATH_PREFIX}:key`, (context) =>
  serveLogo(context.env.LOGOS, context.req.param("key")),
);
app.get("/api/v1/logos", (context) => listLogos(context.env.LOGOS));
app.post("/api/v1/logos", (context) =>
  uploadLogo(context.env.LOGOS, context.req.raw),
);
app.delete("/api/v1/logos/:key", (context) =>
  deleteLogo(context.env.LOGOS, context.req.param("key")),
);
app.route("/", liveRoutes);
app.route("/", sessionRoutes);
app.route("/", companyRoutes);
app.route("/", reportRoutes);
app.route("/", retrievalRoutes);
app.route("/", deviceRoutes);
app.all("/api/*", () => {
  throw new ApiError(404, "not_found", "Route not found.");
});
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
app.notFound(() =>
  errorResponse(new ApiError(404, "not_found", "Route not found.")),
);
app.onError((error) => errorResponse(normalizeError(error)));

function serviceMayAccess(request: Request, path: string): boolean {
  return request.method === "GET" && path === LIVE_PATH;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const versionId = env.CF_VERSION_METADATA?.id ?? "local";
    let response: Response;
    try {
      if (
        !path.startsWith("/device/") &&
        (await requireAccess(request, env, ctx)) === "service" &&
        !serviceMayAccess(request, path)
      ) {
        throw new ApiError(
          403,
          "service_token_read_only",
          "Service tokens may only read the live event stream.",
        );
      }
      response = await app.fetch(request, env);
    } catch (error) {
      response = errorResponse(error);
    }

    const result = withResponseHeaders(
      response,
      requestId,
      versionId,
      path.startsWith("/api/") || path.startsWith("/device/"),
    );
    // On error responses, capture the machine-readable error code (from the
    // JSON body) so request logs distinguish e.g. session_already_active from
    // session_id_conflict without a second round trip. Read a clone so the
    // returned response body stays intact.
    let errorCode: string | undefined;
    if (result.status >= 400) {
      try {
        const body = (await result.clone().json()) as {
          error?: { code?: string };
        };
        errorCode = body.error?.code;
      } catch {
        // Non-JSON error body (e.g. asset 404); leave errorCode undefined.
      }
    }
    console.log(
      JSON.stringify({
        event: "request.complete",
        requestId,
        versionId,
        method: request.method,
        route: routeLabel(path),
        status: result.status,
        ...(errorCode ? { errorCode } : {}),
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
  },
} satisfies ExportedHandler<Env>;
