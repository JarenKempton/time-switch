import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TimeClockEnv } from "../src/time-clock";
import worker from "../src/worker";

const workerFetch = worker.fetch as (
  request: Request,
  env: TimeClockEnv,
  ctx: ExecutionContext,
) => Promise<Response>;
const accessContext = {
  access: {
    aud: "test-audience",
    getIdentity: async () => ({ email: "developer@example.test" }),
  },
} as ExecutionContext;

function dashboardFetch(path: string, init?: RequestInit): Promise<Response> {
  return workerFetch(
    new Request(`https://example.test${path}`, init),
    env as unknown as TimeClockEnv,
    accessContext,
  );
}

async function signedDeviceHeaders(
  path: string,
  body: string,
  deviceId: string,
  deviceSecret: string,
) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const bodyHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(deviceSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode([timestamp, "POST", path, bodyHash].join("\n")),
  );
  const signatureHex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    "content-type": "application/json",
    "x-time-switch-device": deviceId,
    "x-time-switch-signature": `v1=${signatureHex}`,
    "x-time-switch-timestamp": timestamp,
  };
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await dashboardFetch(path, { ...init, headers });
  return { status: response.status, body: (await response.json()) as T };
}

async function createCompany(name = "Northstar") {
  return request<{ data: { id: string; name: string } }>("/api/v1/companies", {
    method: "POST",
    body: JSON.stringify({ name, color: "#62e6a7", logoUrl: "" }),
  });
}

async function provisionDevice(name = "Desk panel") {
  const created = await request<{
    data: { device: { id: string }; setupToken: string };
  }>("/api/v1/devices", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const provisioned = await SELF.fetch(
    "https://example.test/device/v1/provision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: created.body.data.device.id,
        setupToken: created.body.data.setupToken,
        firmwareVersion: "test-1.0.0",
      }),
    },
  );
  const body = (await provisioned.json()) as {
    data: { deviceId: string; secret: string };
  };
  return body.data;
}

async function deviceFetch<T>(
  path: string,
  payload: unknown,
  device: { deviceId: string; secret: string },
): Promise<{ status: number; body: T }> {
  const body = JSON.stringify(payload);
  const response = await SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: await signedDeviceHeaders(
      path,
      body,
      device.deviceId,
      device.secret,
    ),
    body,
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("time clock API", () => {
  it("verifies device authentication and migrated storage through health", async () => {
    const device = await provisionDevice();
    const path = "/device/v1/health";
    const body = "{}";
    const response = await SELF.fetch(`https://example.test${path}`, {
      method: "POST",
      headers: await signedDeviceHeaders(
        path,
        body,
        device.deviceId,
        device.secret,
      ),
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { ok: true, service: "time-switch", storage: "ready" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("registers, provisions, and reports device heartbeats", async () => {
    const device = await provisionDevice("Office panel");
    const path = "/device/v1/heartbeat";
    const body = JSON.stringify({ firmwareVersion: "test-1.1.0" });
    const heartbeat = await SELF.fetch(`https://example.test${path}`, {
      method: "POST",
      headers: await signedDeviceHeaders(
        path,
        body,
        device.deviceId,
        device.secret,
      ),
      body,
    });
    expect(heartbeat.status).toBe(200);

    const listed = await request<{
      data: Array<{
        id: string;
        firmwareVersion: string;
        provisionedAt: string;
        lastSeenAt: string;
        secret?: string;
      }>;
    }>("/api/v1/devices");
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      id: device.deviceId,
      firmwareVersion: "test-1.1.0",
    });
    expect(listed.body.data[0].provisionedAt).toBeTruthy();
    expect(listed.body.data[0].lastSeenAt).toBeTruthy();
    expect(listed.body.data[0].secret).toBeUndefined();
  });

  it("renews setup for an unprovisioned device without duplicating it", async () => {
    const create = () =>
      request<{
        data: { device: { id: string }; setupToken: string };
      }>("/api/v1/devices", {
        method: "POST",
        body: JSON.stringify({ name: "Retry panel" }),
      });
    const first = await create();
    const second = await create();
    expect(second.body.data.device.id).toBe(first.body.data.device.id);
    expect(second.body.data.setupToken).not.toBe(first.body.data.setupToken);

    const staleToken = await SELF.fetch(
      "https://example.test/device/v1/provision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: first.body.data.device.id,
          setupToken: first.body.data.setupToken,
          firmwareVersion: "test-1.0.0",
        }),
      },
    );
    expect(staleToken.status).toBe(401);

    const currentToken = await SELF.fetch(
      "https://example.test/device/v1/provision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: second.body.data.device.id,
          setupToken: second.body.data.setupToken,
          firmwareVersion: "test-1.0.0",
        }),
      },
    );
    expect(currentToken.status).toBe(200);

    const listed = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/devices",
    );
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(first.body.data.device.id);
  });

  it("issues fresh setup authorization for an existing device", async () => {
    const original = await provisionDevice("Reconfigurable panel");
    const prepared = await request<{
      data: { device: { id: string }; setupToken: string };
    }>(`/api/v1/devices/${original.deviceId}/setup`, { method: "POST" });
    expect(prepared.status).toBe(200);
    expect(prepared.body.data.device.id).toBe(original.deviceId);

    const reprovisioned = await SELF.fetch(
      "https://example.test/device/v1/provision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: original.deviceId,
          setupToken: prepared.body.data.setupToken,
          firmwareVersion: "test-1.1.0",
        }),
      },
    );
    expect(reprovisioned.status).toBe(200);
    const body = (await reprovisioned.json()) as {
      data: { secret: string };
    };
    expect(body.data.secret).not.toBe(original.secret);

    const path = "/device/v1/health";
    const requestBody = "{}";
    const oldCredentials = await SELF.fetch(`https://example.test${path}`, {
      method: "POST",
      headers: await signedDeviceHeaders(
        path,
        requestBody,
        original.deviceId,
        original.secret,
      ),
      body: requestBody,
    });
    expect(oldCredentials.status).toBe(401);
  });

  it("permanently deletes a device and releases its name", async () => {
    const first = await request<{
      data: { device: { id: string } };
    }>("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ name: "Disposable panel" }),
    });
    const deleted = await request<{ data: { id: string } }>(
      `/api/v1/devices/${first.body.data.device.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    const listed = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/devices",
    );
    expect(
      listed.body.data.some(({ id }) => id === first.body.data.device.id),
    ).toBe(false);

    const replacement = await request<{
      data: { device: { id: string } };
    }>("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ name: "Disposable panel" }),
    });
    expect(replacement.status).toBe(201);
    expect(replacement.body.data.device.id).not.toBe(first.body.data.device.id);
  });

  it("pushes an initial snapshot and subsequent changes over WebSocket", async () => {
    const response = await dashboardFetch("/api/v1/live", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const nextMessage = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        socket.addEventListener(
          "message",
          (event) =>
            resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
          { once: true },
        );
      });
    const snapshotPromise = nextMessage();
    socket.accept();
    expect(await snapshotPromise).toMatchObject({ type: "snapshot" });

    const changePromise = nextMessage();
    await createCompany("Live Company");
    expect(await changePromise).toMatchObject({ type: "company.changed" });
    socket.close(1000, "Test complete");
  });

  it("creates companies and returns them alphabetically", async () => {
    expect((await createCompany("Zebra")).status).toBe(201);
    expect((await createCompany("Acme")).status).toBe(201);

    const result = await request<{ data: Array<{ name: string }> }>(
      "/api/v1/companies",
    );
    expect(result.status).toBe(200);
    expect(result.body.data.map((company) => company.name)).toEqual([
      "Acme",
      "Zebra",
    ]);
  });

  it("starts and stops an idempotent session", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    const sessionId = "018f47a0-7b8c-4c5d-9e6f-0123456789ab";
    const startedAt = "2026-09-12T15:30:00.000Z";
    const endedAt = "2026-09-12T19:45:00.000Z";

    const started = await request<{ data: { id: string; companyId: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ id: sessionId, companyId, startedAt }),
      },
    );
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ id: sessionId, companyId });

    const repeated = await request<{ data: { id: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ id: sessionId, companyId, startedAt }),
      },
    );
    expect(repeated.status).toBe(200);

    const stopped = await request<{ data: { durationSeconds: number } }>(
      `/api/v1/sessions/${sessionId}/stop`,
      {
        method: "POST",
        body: JSON.stringify({ endedAt }),
      },
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.durationSeconds).toBe(15_300);

    const repeatedStop = await request<{ data: { durationSeconds: number } }>(
      `/api/v1/sessions/${sessionId}/stop`,
      {
        method: "POST",
        body: JSON.stringify({ endedAt }),
      },
    );
    expect(repeatedStop.status).toBe(200);
    expect(repeatedStop.body.data.durationSeconds).toBe(15_300);
  });

  it("discards a session stopped in under a minute", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    const sessionId = "018f47a0-7b8c-4c5d-9e6f-0123456789ac";
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        companyId,
        startedAt: "2026-09-12T15:30:00.000Z",
      }),
    });

    const stopped = await request<{
      data: { durationSeconds: number; discarded: boolean };
    }>(`/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt: "2026-09-12T15:30:40.000Z" }),
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({
      durationSeconds: 40,
      discarded: true,
    });

    const listed = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/sessions",
    );
    expect(listed.body.data).toHaveLength(0);
    const status = await request<{ data: { activeSession: unknown } }>(
      "/api/v1/status",
    );
    expect(status.body.data.activeSession).toBeNull();

    // A manual edit cannot produce a sub-minute session either.
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        companyId,
        startedAt: "2026-09-12T15:30:00.000Z",
      }),
    });
    const edited = await request<{ error: { code: string } }>(
      `/api/v1/sessions/${sessionId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ endedAt: "2026-09-12T15:30:30.000Z" }),
      },
    );
    expect(edited.status).toBe(422);
    expect(edited.body.error.code).toBe("session_too_short");
  });

  it("edits and deletes a session", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    const started = await request<{ data: { id: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          companyId,
          startedAt: "2026-09-10T15:00:00.000Z",
        }),
      },
    );
    const sessionId = started.body.data.id;

    const edited = await request<{
      data: { startedAt: string; endedAt: string | null };
    }>(`/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({
        startedAt: "2026-09-10T14:00:00.000Z",
        endedAt: "2026-09-10T16:30:00.000Z",
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.startedAt).toBe("2026-09-10T14:00:00.000Z");
    expect(edited.body.data.endedAt).toBe("2026-09-10T16:30:00.000Z");

    const deleted = await request<{ data: { id: string } }>(
      `/api/v1/sessions/${sessionId}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.id).toBe(sessionId);

    const listed = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/sessions",
    );
    expect(
      listed.body.data.find((row) => row.id === sessionId),
    ).toBeUndefined();

    const again = await request(`/api/v1/sessions/${sessionId}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("rejects overlapping active sessions", async () => {
    const first = await createCompany("First");
    const second = await createCompany("Second");
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        companyId: first.body.data.id,
        startedAt: "2026-09-12T15:30:00.000Z",
      }),
    });

    const conflict = await request<{ error: { code: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          companyId: second.body.data.id,
          startedAt: "2026-09-12T16:00:00.000Z",
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("session_already_active");
  });

  it("treats a re-stop at a different time as idempotent (offline replay)", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    const sessionId = "018f47a0-7b8c-4c5d-9e6f-0123456789ab";
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        companyId,
        startedAt: "2026-09-12T09:00:00.000Z",
      }),
    });
    const first = await request(`/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt: "2026-09-12T13:00:00.000Z" }),
    });
    expect(first.status).toBe(200);

    // A device replaying its queued stop with a different endedAt must not get
    // a 409 — that would poison its offline queue and loop forever. First stop
    // wins: the recorded endedAt is unchanged and the call succeeds.
    const replay = await request<{
      data: { session: { endedAt: string }; durationSeconds: number };
    }>(`/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt: "2026-09-12T17:00:00.000Z" }),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.session.endedAt).toBe("2026-09-12T13:00:00.000Z");
    expect(replay.body.data.durationSeconds).toBe(14_400);
  });

  it("closes a dangling active session when the device starts a new one", async () => {
    const device = await provisionDevice("Bench panel");
    const alpha = await createCompany("Alpha");
    const beta = await createCompany("Beta");
    const first = "018f47a0-0000-4c5d-9e6f-000000000001";
    const second = "018f47a0-0000-4c5d-9e6f-000000000002";

    const startFirst = await deviceFetch<{ data: { id: string } }>(
      "/device/v1/sessions/start",
      {
        id: first,
        companyId: alpha.body.data.id,
        startedAt: "2026-09-12T15:00:00.000Z",
      },
      device,
    );
    expect(startFirst.status).toBe(201);

    // The switch flips to Beta without a delivered stop for Alpha. The physical
    // switch is the source of truth, so the start closes Alpha at the flip time
    // rather than returning session_already_active (which looped in prod).
    const startSecond = await deviceFetch<{
      data: { id: string; companyId: string };
    }>(
      "/device/v1/sessions/start",
      {
        id: second,
        companyId: beta.body.data.id,
        startedAt: "2026-09-12T16:00:00.000Z",
      },
      device,
    );
    expect(startSecond.status).toBe(201);
    expect(startSecond.body.data).toMatchObject({
      id: second,
      companyId: beta.body.data.id,
    });

    const status = await request<{
      data: { activeSession: { id: string } | null };
    }>("/api/v1/status");
    expect(status.body.data.activeSession?.id).toBe(second);

    const sessions = await request<{
      data: Array<{ id: string; endedAt: string | null }>;
    }>("/api/v1/sessions");
    const alphaRow = sessions.body.data.find((s) => s.id === first);
    expect(alphaRow?.endedAt).toBe("2026-09-12T16:00:00.000Z");
  });

  it("calculates totals clipped to the requested reporting range", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    const sessionId = "018f47a0-7b8c-4c5d-9e6f-0123456789ab";
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        companyId,
        startedAt: "2026-09-12T09:00:00.000Z",
      }),
    });
    await request(`/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt: "2026-09-12T13:00:00.000Z" }),
    });

    const summary = await request<{
      data: { companies: Array<{ totalSeconds: number }> };
    }>(
      "/api/v1/summary?from=2026-09-12T10:00:00.000Z&to=2026-09-12T12:00:00.000Z",
    );
    expect(summary.body.data.companies[0].totalSeconds).toBe(7_200);
  });
});

describe("hour retrievals", () => {
  async function seedCompanyWithSession() {
    const company = await createCompany("Retrieval Co");
    const companyId = company.body.data.id;
    const sessionId = "018f47a0-7b8c-4c5d-9e6f-0123456789ab";
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        companyId,
        startedAt: "2026-09-10T09:00:00.000Z",
      }),
    });
    await request(`/api/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt: "2026-09-10T12:00:00.000Z" }),
    });
    return companyId;
  }

  it("reports company hours for a range", async () => {
    const companyId = await seedCompanyWithSession();
    const hours = await request<{
      data: { totalSeconds: number; sessionCount: number };
    }>(
      `/api/v1/companies/${companyId}/hours?from=2026-09-01T00:00:00.000Z&to=2026-09-15T00:00:00.000Z`,
    );
    expect(hours.status).toBe(200);
    expect(hours.body.data).toMatchObject({
      totalSeconds: 10_800,
      sessionCount: 1,
    });
  });

  it("closes the open period and opens the next one where it ended", async () => {
    const companyId = await seedCompanyWithSession();
    const open = await request<{
      data: { start: string; totalSeconds: number; sessionCount: number };
    }>(`/api/v1/companies/${companyId}/period`);
    expect(open.status).toBe(200);
    expect(open.body.data).toMatchObject({
      start: "2026-09-10T09:00:00.000Z",
      totalSeconds: 10_800,
      sessionCount: 1,
    });

    const created = await request<{
      data: {
        id: string;
        periodStart: string;
        periodEnd: string;
        totalSeconds: number;
      };
    }>(`/api/v1/companies/${companyId}/retrievals`, {
      method: "POST",
      body: JSON.stringify({
        periodEnd: "2026-09-12T15:00:00.000Z",
        note: "Invoice 42",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      periodStart: "2026-09-10T09:00:00.000Z",
      periodEnd: "2026-09-12T15:00:00.000Z",
      totalSeconds: 10_800,
    });

    const list = await request<{ data: Array<{ id: string; note: string }> }>(
      `/api/v1/retrievals?companyId=${companyId}`,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].note).toBe("Invoice 42");

    const next = await request<{
      data: { start: string; totalSeconds: number };
    }>(`/api/v1/companies/${companyId}/period`);
    expect(next.body.data).toMatchObject({
      start: "2026-09-12T15:00:00.000Z",
      totalSeconds: 0,
    });

    const overlap = await request<{ error: { code: string } }>(
      `/api/v1/companies/${companyId}/retrievals`,
      {
        method: "POST",
        body: JSON.stringify({ periodEnd: "2026-09-11T00:00:00.000Z" }),
      },
    );
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe("retrieval_overlap");

    const removed = await request(
      `/api/v1/retrievals/${created.body.data.id}`,
      {
        method: "DELETE",
      },
    );
    expect(removed.status).toBe(200);
    const after = await request<{ data: unknown[] }>(
      `/api/v1/retrievals?companyId=${companyId}`,
    );
    expect(after.body.data).toHaveLength(0);
  });

  it("rejects a retrieval that ends in the future", async () => {
    const companyId = await seedCompanyWithSession();
    const bad = await request<{ error: { code: string } }>(
      `/api/v1/companies/${companyId}/retrievals`,
      {
        method: "POST",
        body: JSON.stringify({
          periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("retrieval_in_future");
  });
});
