import { env } from "cloudflare:test";
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

describe("DO export", () => {
  it("refuses requests without Cloudflare Access", async () => {
    const response = await workerFetch(
      new Request("https://example.test/api/v1/admin/export"),
      {} as TimeClockEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("dumps every application table as raw rows", async () => {
    const created = await dashboardFetch("/api/v1/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Northstar", color: "#62e6a7" }),
    });
    const company = ((await created.json()) as { data: { id: string } }).data;

    const response = await dashboardFetch("/api/v1/admin/export");
    const { data } = (await response.json()) as {
      data: { tables: Record<string, Record<string, unknown>[]> };
    };

    expect(response.status).toBe(200);
    expect(Object.keys(data.tables)).toEqual([
      "companies",
      "devices",
      "hour_retrievals",
      "sessions",
    ]);
    expect(data.tables.companies).toEqual([
      expect.objectContaining({
        id: company.id,
        name: "Northstar",
        archived: 0,
      }),
    ]);
  });
});
