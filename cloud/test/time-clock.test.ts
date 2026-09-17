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

  it("stores per-company pay-period settings", async () => {
    const created = await request<{
      data: {
        id: string;
        payPeriodCadence: string;
        payPeriodAnchorDate: string;
      };
    }>("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "Payroll Test",
        payPeriodCadence: "weekly",
        payPeriodAnchorDate: "2026-09-07",
      }),
    });
    expect(created.body.data).toMatchObject({
      payPeriodCadence: "weekly",
      payPeriodAnchorDate: "2026-09-07",
    });

    const updated = await request<{
      data: { payPeriodCadence: string; payPeriodAnchorDate: string };
    }>(`/api/v1/companies/${created.body.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        payPeriodCadence: "monthly",
        payPeriodAnchorDate: "2026-09-15",
      }),
    });
    expect(updated.body.data).toMatchObject({
      payPeriodCadence: "monthly",
      payPeriodAnchorDate: "2026-09-15",
    });
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

  it("records a retrieval with a server-computed total and can re-anchor", async () => {
    const companyId = await seedCompanyWithSession();
    const created = await request<{
      data: {
        id: string;
        totalSeconds: number;
        nextPeriodEnd: string;
        company: { payPeriodAnchorDate: string };
      };
    }>(`/api/v1/companies/${companyId}/retrievals`, {
      method: "POST",
      body: JSON.stringify({
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-09-12T15:00:00.000Z",
        nextPeriodEnd: "2026-09-26T00:00:00.000Z",
        note: "Invoice 42",
        reanchorDate: "2026-09-12",
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.totalSeconds).toBe(10_800);
    expect(created.body.data.company.payPeriodAnchorDate).toBe("2026-09-12");

    const list = await request<{ data: Array<{ id: string; note: string }> }>(
      `/api/v1/retrievals?companyId=${companyId}`,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].note).toBe("Invoice 42");

    const overlap = await request<{ error: { code: string } }>(
      `/api/v1/companies/${companyId}/retrievals`,
      {
        method: "POST",
        body: JSON.stringify({
          periodStart: "2026-09-10T00:00:00.000Z",
          periodEnd: "2026-09-13T00:00:00.000Z",
          nextPeriodEnd: "2026-09-26T00:00:00.000Z",
        }),
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

  it("rejects a retrieval whose next period ends before it does", async () => {
    const companyId = await seedCompanyWithSession();
    const bad = await request<{ error: { code: string } }>(
      `/api/v1/companies/${companyId}/retrievals`,
      {
        method: "POST",
        body: JSON.stringify({
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-09-12T00:00:00.000Z",
          nextPeriodEnd: "2026-09-11T00:00:00.000Z",
        }),
      },
    );
    expect(bad.status).toBe(422);
  });
});

describe("session cleanup", () => {
  interface PurgeBody {
    data: {
      dryRun: boolean;
      purgedCount: number;
      purgedSeconds: number;
      ids: string[];
      byCompany: Array<{ name: string; count: number; totalSeconds: number }>;
      affectedRetrievals: Array<{
        companyName: string;
        totalSeconds: number;
        staleSeconds: number;
      }>;
    };
  }

  /** Records one finished session. Only one may run at a time. */
  async function record(
    companyId: string,
    id: string,
    startedAt: string,
    endedAt: string,
  ) {
    await request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ id, companyId, startedAt }),
    });
    await request(`/api/v1/sessions/${id}/stop`, {
      method: "POST",
      body: JSON.stringify({ endedAt }),
    });
  }

  function purge(body: Record<string, unknown>) {
    return request<PurgeBody>("/api/v1/sessions/purge", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  const short = "018f47a0-7b8c-4c5d-9e6f-000000000001";
  const alsoShort = "018f47a0-7b8c-4c5d-9e6f-000000000002";
  const long = "018f47a0-7b8c-4c5d-9e6f-000000000003";

  it("deletes one session and refuses to delete it twice", async () => {
    const company = await createCompany();
    await record(
      company.body.data.id,
      short,
      "2026-09-12T09:00:00.000Z",
      "2026-09-12T09:00:20.000Z",
    );

    const deleted = await request<{ data: { id: string } }>(
      `/api/v1/sessions/${short}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.id).toBe(short);

    const remaining = await request<{ data: unknown[] }>("/api/v1/sessions");
    expect(remaining.body.data).toHaveLength(0);

    const again = await request<{ error: { code: string } }>(
      `/api/v1/sessions/${short}`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("session_not_found");
  });

  it("clears the active session when it is deleted", async () => {
    const company = await createCompany();
    const created = await request<{ data: { id: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          companyId: company.body.data.id,
          startedAt: "2026-09-12T09:00:00.000Z",
        }),
      },
    );

    await request(`/api/v1/sessions/${created.body.data.id}`, {
      method: "DELETE",
    });
    const status = await request<{ data: { activeSession: unknown } }>(
      "/api/v1/status",
    );
    expect(status.body.data.activeSession).toBeNull();
  });

  it("previews a purge without touching the ledger", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    await record(
      companyId,
      short,
      "2026-09-12T09:00:00.000Z",
      "2026-09-12T09:00:30.000Z",
    );
    await record(
      companyId,
      long,
      "2026-09-12T10:00:00.000Z",
      "2026-09-12T12:00:00.000Z",
    );

    const preview = await purge({ dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      dryRun: true,
      purgedCount: 1,
      purgedSeconds: 30,
      ids: [short],
    });
    expect(preview.body.data.byCompany).toEqual([
      { companyId, name: "Northstar", count: 1, totalSeconds: 30 },
    ]);

    const remaining = await request<{ data: unknown[] }>("/api/v1/sessions");
    expect(remaining.body.data).toHaveLength(2);
  });

  it("purges short finished sessions and spares long and running ones", async () => {
    const company = await createCompany();
    const companyId = company.body.data.id;
    await record(
      companyId,
      short,
      "2026-09-12T09:00:00.000Z",
      "2026-09-12T09:00:02.000Z",
    );
    await record(
      companyId,
      alsoShort,
      "2026-09-12T09:30:00.000Z",
      "2026-09-12T09:30:59.000Z",
    );
    await record(
      companyId,
      long,
      "2026-09-12T10:00:00.000Z",
      "2026-09-12T12:00:00.000Z",
    );
    // Exactly at the cutoff: the comparison is exclusive, so this one stays.
    await record(
      companyId,
      "018f47a0-7b8c-4c5d-9e6f-000000000004",
      "2026-09-12T13:00:00.000Z",
      "2026-09-12T13:01:00.000Z",
    );
    const running = await request<{ data: { id: string } }>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          companyId,
          startedAt: new Date(Date.now() - 5_000).toISOString(),
        }),
      },
    );

    const purged = await purge({});
    expect(purged.status).toBe(200);
    expect(purged.body.data).toMatchObject({
      dryRun: false,
      maxDurationSeconds: 60,
      purgedCount: 2,
      purgedSeconds: 61,
    });
    expect(purged.body.data.ids.sort()).toEqual([short, alsoShort].sort());

    const remaining = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/sessions",
    );
    expect(remaining.body.data.map((session) => session.id).sort()).toEqual(
      [
        long,
        "018f47a0-7b8c-4c5d-9e6f-000000000004",
        running.body.data.id,
      ].sort(),
    );
  });

  it("names the retrieved pay periods a purge leaves reading high", async () => {
    const company = await createCompany("Retrieval Co");
    const companyId = company.body.data.id;
    await record(
      companyId,
      long,
      "2026-09-10T09:00:00.000Z",
      "2026-09-10T12:00:00.000Z",
    );
    await record(
      companyId,
      short,
      "2026-09-10T13:00:00.000Z",
      "2026-09-10T13:00:45.000Z",
    );
    const retrieved = await request<{ data: { totalSeconds: number } }>(
      `/api/v1/companies/${companyId}/retrievals`,
      {
        method: "POST",
        body: JSON.stringify({
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-09-15T00:00:00.000Z",
          nextPeriodEnd: "2026-09-29T00:00:00.000Z",
        }),
      },
    );
    expect(retrieved.body.data.totalSeconds).toBe(10_845);

    const purged = await purge({});
    expect(purged.body.data.purgedCount).toBe(1);
    expect(purged.body.data.affectedRetrievals).toHaveLength(1);
    expect(purged.body.data.affectedRetrievals[0]).toMatchObject({
      companyName: "Retrieval Co",
      totalSeconds: 10_845,
      staleSeconds: 45,
    });

    // The stored retrieval keeps its figure; only the ledger shrank.
    const retrievals = await request<{
      data: Array<{ totalSeconds: number }>;
    }>("/api/v1/retrievals");
    expect(retrievals.body.data[0].totalSeconds).toBe(10_845);
    const hours = await request<{ data: { totalSeconds: number } }>(
      `/api/v1/companies/${companyId}/hours?from=2026-09-01T00:00:00.000Z&to=2026-09-15T00:00:00.000Z`,
    );
    expect(hours.body.data.totalSeconds).toBe(10_800);
  });

  it("honors a custom cutoff and a company filter", async () => {
    const first = await createCompany("First");
    const second = await createCompany("Second");
    await record(
      first.body.data.id,
      short,
      "2026-09-12T09:00:00.000Z",
      "2026-09-12T09:04:00.000Z",
    );
    await record(
      second.body.data.id,
      alsoShort,
      "2026-09-12T10:00:00.000Z",
      "2026-09-12T10:04:00.000Z",
    );

    const purged = await purge({
      maxDurationSeconds: 300,
      companyId: first.body.data.id,
    });
    expect(purged.body.data.purgedCount).toBe(1);
    expect(purged.body.data.ids).toEqual([short]);

    const remaining = await request<{ data: Array<{ id: string }> }>(
      "/api/v1/sessions",
    );
    expect(remaining.body.data.map((session) => session.id)).toEqual([
      alsoShort,
    ]);
  });

  it("rejects a purge sent as GET", async () => {
    const response = await dashboardFetch("/api/v1/sessions/purge");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
