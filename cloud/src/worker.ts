import { authenticateDevice } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/http";
import { TimeClock, type TimeClockEnv } from "./time-clock";

export { TimeClock };

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    result.headers.set(name, value);
  return result;
}

function clock(env: TimeClockEnv): DurableObjectStub<TimeClock> {
  return env.TIME_CLOCK.getByName("primary");
}

export default {
  async fetch(request: Request, env: TimeClockEnv): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
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
        return withSecurityHeaders(await clock(env).fetch(internalRequest));
      }

      if (path.startsWith("/api/")) {
        return withSecurityHeaders(await clock(env).fetch(request));
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  },
} satisfies ExportedHandler<TimeClockEnv>;
