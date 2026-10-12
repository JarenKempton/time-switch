import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  acceptLive,
  createCompany,
  dashboardFetch,
  deviceFetch,
  provisionDevice,
  request,
} from "./helpers";

const START = "/device/v1/sessions/start";

function sessionId(suffix: number): string {
  return `018f47a0-0000-4c5d-9e6f-${suffix.toString().padStart(12, "0")}`;
}

async function openSessionIds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM sessions WHERE ended_at IS NULL",
  ).all<{ id: string }>();
  return results.map((row) => row.id);
}

describe("D1 storage", () => {
  it("rejects a second open session at the database level", async () => {
    const company = await createCompany();
    const insert = env.DB.prepare(
      "INSERT INTO sessions (id, company_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
    );
    const now = Date.now();
    await insert.bind(sessionId(1), company.body.data.id, now, now, now).run();

    await expect(
      insert.bind(sessionId(2), company.body.data.id, now, now, now).run(),
    ).rejects.toThrow(
      /UNIQUE constraint failed: index 'idx_sessions_one_open'/,
    );
  });

  it("lets only one of two concurrent dashboard starts open a session", async () => {
    const alpha = await createCompany("Alpha");
    const beta = await createCompany("Beta");
    const startedAt = "2026-09-12T09:00:00.000Z";

    const results = await Promise.all(
      [alpha, beta].map((company) =>
        request<{ error?: { code: string } }>("/api/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ companyId: company.body.data.id, startedAt }),
        }),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      results.find((result) => result.status === 409)?.body.error?.code,
    ).toBe("session_already_active");
    expect(await openSessionIds()).toHaveLength(1);
  });

  it("accepts concurrent device flips and keeps one open session", async () => {
    const device = await provisionDevice();
    const alpha = await createCompany("Alpha");
    const beta = await createCompany("Beta");

    const results = await Promise.all([
      deviceFetch(
        START,
        {
          id: sessionId(1),
          companyId: alpha.body.data.id,
          startedAt: "2026-09-12T09:00:00.000Z",
        },
        device,
      ),
      deviceFetch(
        START,
        {
          id: sessionId(2),
          companyId: beta.body.data.id,
          startedAt: "2026-09-12T09:30:00.000Z",
        },
        device,
      ),
    ]);

    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(await openSessionIds()).toHaveLength(1);
  });

  it("broadcasts a device clock-in written to D1 and keeps no tables in the hub", async () => {
    const device = await provisionDevice();
    const alpha = await createCompany("Alpha");
    const beta = await createCompany("Beta");
    await deviceFetch(
      START,
      {
        id: sessionId(1),
        companyId: alpha.body.data.id,
        startedAt: "2026-09-12T09:00:00.000Z",
      },
      device,
    );
    const live = acceptLive(
      await dashboardFetch("/api/v1/live", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(await live.next("snapshot")).toMatchObject({
      status: { activeSession: { id: sessionId(1) } },
    });

    await deviceFetch(
      START,
      {
        id: sessionId(2),
        companyId: beta.body.data.id,
        startedAt: "2026-09-12T10:00:00.000Z",
      },
      device,
    );

    expect(await live.next("session.stopped")).toMatchObject({
      session: { id: sessionId(1), endedAt: "2026-09-12T10:00:00.000Z" },
    });
    expect(await live.next("session.started")).toMatchObject({
      session: { id: sessionId(2), company: { name: "Beta" } },
      status: { activeSession: { id: sessionId(2) } },
    });
    expect(await openSessionIds()).toEqual([sessionId(2)]);
    live.close();

    const hubTables = await runInDurableObject(
      env.TIME_CLOCK.getByName("primary"),
      (_hub, state) =>
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
          )
          .toArray(),
    );
    expect(hubTables).toEqual([]);
  });
});
