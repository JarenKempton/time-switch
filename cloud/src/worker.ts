import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
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

const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessKeySet(teamDomain: string) {
  const existing = accessKeySets.get(teamDomain);
  if (existing) return existing;
  const keySet = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", teamDomain),
  );
  accessKeySets.set(teamDomain, keySet);
  return keySet;
}

async function requireDashboardAccess(
  request: Request,
  env: TimeClockEnv,
  ctx: ExecutionContext,
): Promise<void> {
  // Wrangler's Access development mock and Worker-native Access expose identity
  // directly on the execution context.
  if (ctx.access) {
    const identity = await ctx.access.getIdentity();
    if (!identity?.email) {
      throw new ApiError(
        403,
        "access_identity_required",
        "Cloudflare Access did not provide an authenticated identity.",
      );
    }
    return;
  }

  // A self-hosted Access application in front of a custom domain forwards a
  // signed JWT instead. Its presence is not enough: verify it against the
  // account's Access keys, issuer, and this application's audience.
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new ApiError(
      401,
      "access_required",
      "Cloudflare Access authentication is required.",
    );
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new ApiError(
      500,
      "access_configuration_error",
      "Cloudflare Access authentication is not configured.",
    );
  }

  let teamDomain: string;
  try {
    const url = new URL(env.ACCESS_TEAM_DOMAIN);
    if (url.protocol !== "https:") throw new Error("HTTPS is required");
    teamDomain = url.origin;
  } catch {
    throw new ApiError(
      500,
      "access_configuration_error",
      "Cloudflare Access authentication is not configured.",
    );
  }

  try {
    const { payload } = await jwtVerify(token, getAccessKeySet(teamDomain), {
      algorithms: ["RS256"],
      audience: env.ACCESS_AUD,
      issuer: teamDomain,
    });
    if (payload.type !== "app" || typeof payload.email !== "string") {
      throw new Error("Authenticated user claims are missing");
    }
  } catch {
    throw new ApiError(
      401,
      "access_invalid",
      "Cloudflare Access authentication is invalid or expired.",
    );
  }
}

function routeLabel(path: string): string {
  return path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    "/:id",
  );
}

type HonoEnv = { Bindings: TimeClockEnv };
const app = new Hono<HonoEnv>();

app.all("/device/*", async (context) => {
  const request = context.req.raw;
  if (request.method !== "POST") {
    throw new ApiError(405, "method_not_allowed", "Method not allowed.");
  }
  const body = await request.text();
  await authenticateDevice(request, body, context.env);
  const internalRequest = new Request(request.url, {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    body,
  });
  return clock(context.env).fetch(internalRequest);
});

app.all("/api/*", (context) => clock(context.env).fetch(context.req.raw));
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
app.notFound(() =>
  errorResponse(new ApiError(404, "not_found", "Route not found.")),
);
app.onError((error) => errorResponse(error));

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
      if (!path.startsWith("/device/"))
        await requireDashboardAccess(request, env, ctx);
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
