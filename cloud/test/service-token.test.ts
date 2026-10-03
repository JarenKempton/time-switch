import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { acceptLive, workerFetch } from "./helpers";

const TEAM = "https://team.example.test";
const AUD = "test-audience";
const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
} as unknown as Env;

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test",
    alg: "RS256",
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input instanceof Request ? input.url : input) ===
    `${TEAM}/cdn-cgi/access/certs`
      ? Promise.resolve(Response.json({ keys: [jwk] }))
      : realFetch(input, init),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

function accessToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function accessFetch(
  path: string,
  claims: Record<string, unknown>,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await accessToken(claims));
  return workerFetch(
    new Request(`https://example.test${path}`, { ...init, headers }),
    accessEnv,
    {} as ExecutionContext,
  );
}

const SERVICE = { common_name: "desk-api.access" };
const USER = { email: "developer@example.test" };

describe("Cloudflare Access service tokens", () => {
  it("can subscribe to the live event stream", async () => {
    const response = await accessFetch("/api/v1/live", SERVICE, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const live = acceptLive(response);
    expect(await live.next("snapshot")).toMatchObject({
      status: { activeSession: null },
    });
    live.close();
  });

  it("cannot read or write anything else", async () => {
    for (const [path, method] of [
      ["/api/v1/companies", "GET"],
      ["/api/v1/status", "GET"],
      ["/api/v1/sessions", "POST"],
    ]) {
      const response = await accessFetch(path, SERVICE, { method });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "service_token_read_only" },
      });
    }
  });

  it("leaves signed-in browser access unchanged", async () => {
    const response = await accessFetch("/api/v1/companies", USER);
    expect(response.status).toBe(200);
  });

  it("rejects tokens without an identity", async () => {
    const response = await accessFetch("/api/v1/live", {});
    expect(response.status).toBe(401);
  });
});
