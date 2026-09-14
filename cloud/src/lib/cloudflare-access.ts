import { createRemoteJWKSet, jwtVerify } from "jose";
import type { TimeClockEnv } from "../time-clock";
import { ApiError } from "./http";

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

export async function requireDashboardAccess(
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
