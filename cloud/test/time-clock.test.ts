import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers,
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createCompany(name = "Northstar") {
  return request<{ data: { id: string; name: string } }>("/api/v1/companies", {
    method: "POST",
    body: JSON.stringify({ name, color: "#62e6a7", logoUrl: null }),
  });
}

describe("time clock API", () => {
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
    const response = await SELF.fetch("https://example.test/api/v1/live", {
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
