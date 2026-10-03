import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";
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

/**
 * A person signed in through Access, or a machine presenting an Access service
 * token (CF-Access-Client-Id/Secret). Access exchanges the token for a JWT with
 * a `common_name` and no email.
 */
export type AccessPrincipal = "user" | "service";

export async function requireAccess(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<AccessPrincipal> {
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
    return "user";
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
    if (payload.type !== "app") throw new Error("Not an application token");
    if (typeof payload.email === "string") return "user";
    if (typeof payload.common_name === "string" && payload.common_name)
      return "service";
    throw new Error("Authenticated claims are missing");
  } catch {
    throw new ApiError(
      401,
      "access_invalid",
      "Cloudflare Access authentication is invalid or expired.",
    );
  }
}
