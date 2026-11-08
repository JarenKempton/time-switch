import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { acceptLive, createCompany, workerFetch } from "./helpers";

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
  targetEnv: Env = accessEnv,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await accessToken(claims));
  if (init.body) headers.set("content-type", "application/json");
  return workerFetch(
    new Request(`https://example.test${path}`, { ...init, headers }),
    targetEnv,
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

const BAR = { common_name: "desktop-bar.access" };
const barEnv = { ...accessEnv, BAR_SERVICE_TOKEN: BAR.common_name } as Env;
const SOME_ID = "8b0c2f4e-3d1a-4c5b-9e6f-7a8b9c0d1e2f";

describe("The desktop bar service token", () => {
  it("can read status, companies, sessions, and totals", async () => {
    const company = await createCompany();
    const id = company.body.data.id;
    const now = new Date();
    const from = new Date(now.getTime() - 86_400_000).toISOString();
    for (const path of [
      "/api/v1/status",
      "/api/v1/companies",
      "/api/v1/sessions",
      `/api/v1/summary?from=${from}&to=${now.toISOString()}`,
      `/api/v1/companies/${id}/period`,
    ]) {
      const response = await accessFetch(path, BAR, {}, barEnv);
      expect(response.status, path).toBe(200);
    }
    const logo = await accessFetch("/logos/missing.svg", BAR, {}, barEnv);
    expect(logo.status).not.toBe(403);
  });

  it("can start and stop a session", async () => {
    const company = await createCompany();
    const started = await accessFetch(
      "/api/v1/sessions",
      BAR,
      {
        method: "POST",
        body: JSON.stringify({
          companyId: company.body.data.id,
          startedAt: new Date(Date.now() - 600_000).toISOString(),
        }),
      },
      barEnv,
    );
    expect(started.status).toBe(201);
    const session = (await started.json()) as { data: { id: string } };

    const stopped = await accessFetch(
      `/api/v1/sessions/${session.data.id}/stop`,
      BAR,
      {
        method: "POST",
        body: JSON.stringify({ endedAt: new Date().toISOString() }),
      },
      barEnv,
    );
    expect(stopped.status).toBe(200);
  });

  it("cannot edit, delete, or manage anything else", async () => {
    for (const [path, method] of [
      [`/api/v1/sessions/${SOME_ID}`, "PATCH"],
      [`/api/v1/sessions/${SOME_ID}`, "DELETE"],
      ["/api/v1/companies", "POST"],
      [`/api/v1/companies/${SOME_ID}`, "PATCH"],
      [`/api/v1/companies/${SOME_ID}/hours`, "GET"],
      [`/api/v1/companies/${SOME_ID}/retrievals`, "POST"],
      ["/api/v1/retrievals", "GET"],
      ["/api/v1/devices", "GET"],
      ["/api/v1/devices", "POST"],
      ["/api/v1/logos", "POST"],
      ["/api/v1/export.csv", "GET"],
    ]) {
      const response = await accessFetch(path, BAR, { method }, barEnv);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "service_token_forbidden" },
      });
    }
  });

  it("does not widen other service tokens", async () => {
    const response = await accessFetch("/api/v1/status", SERVICE, {}, barEnv);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "service_token_read_only" },
    });
  });

  it("is read-only when no bar token is configured", async () => {
    const response = await accessFetch("/api/v1/status", BAR);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "service_token_read_only" },
    });
  });
});
