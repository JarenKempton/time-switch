import { authenticateDevice } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/http";
import { TimeClock, type TimeClockEnv } from "./time-clock";

export { TimeClock };

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
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

function clock(env: TimeClockEnv): DurableObjectStub<TimeClock> {
  return env.TIME_CLOCK.getByName("primary");
}

async function requireDashboardAccess(ctx: ExecutionContext): Promise<void> {
  if (!ctx.access) {
    throw new ApiError(
      401,
      "access_required",
      "Cloudflare Access authentication is required.",
    );
  }
  const identity = await ctx.access.getIdentity();
  if (!identity?.email) {
    throw new ApiError(
      403,
      "access_identity_required",
      "Cloudflare Access did not provide an authenticated identity.",
    );
  }
}

function routeLabel(path: string): string {
  return path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    "/:id",
  );
}

export default {
  async fetch(
    request: Request,
    env: TimeClockEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const versionId = env.CF_VERSION_METADATA?.id ?? "local";
    let response: Response;
    try {
      if (path.startsWith("/device/")) {
        if (request.method !== "POST")
          throw new ApiError(405, "method_not_allowed", "Method not allowed.");
        const body = await request.text();
        await authenticateDevice(request, body, env);
        const internalRequest = new Request(request.url, {
          method: request.method,
          headers: {
            "content-type":
              request.headers.get("content-type") ?? "application/json",
          },
          body,
        });
        response = await clock(env).fetch(internalRequest);
      } else {
        await requireDashboardAccess(ctx);
        response = path.startsWith("/api/")
          ? await clock(env).fetch(request)
          : await env.ASSETS.fetch(request);
      }
    } catch (error) {
      response = errorResponse(error);
    }

    const result = withResponseHeaders(
      response,
      requestId,
      versionId,
      path.startsWith("/api/") || path.startsWith("/device/"),
    );
    console.log(
      JSON.stringify({
        event: "request.complete",
        requestId,
        versionId,
        method: request.method,
        route: routeLabel(path),
        status: result.status,
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
  },
} satisfies ExportedHandler<TimeClockEnv>;
