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

function request(path: string, init?: RequestInit): Promise<Response> {
  return workerFetch(
    new Request(`https://example.test${path}`, init),
    env as unknown as TimeClockEnv,
    accessContext,
  );
}

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

describe("company logos in R2", () => {
  it("uploads, lists, serves, references, and deletes a logo", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([PNG_HEADER], "Sales AI.png", { type: "image/png" }),
    );
    const uploaded = await request("/api/v1/logos", {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const { data: logo } = (await uploaded.json()) as {
      data: { key: string; url: string; size: number; contentType: string };
    };
    expect(logo.key).toMatch(/^sales-ai-[0-9a-f]{8}\.png$/);
    expect(logo.url).toBe(`/logos/${logo.key}`);
    expect(logo.contentType).toBe("image/png");

    const listed = await request("/api/v1/logos");
    const { data: logos } = (await listed.json()) as {
      data: Array<{ key: string }>;
    };
    expect(logos.map((entry) => entry.key)).toContain(logo.key);

    const served = await request(logo.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_HEADER);

    const company = await request("/api/v1/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SalesAi", logoUrl: logo.url }),
    });
    expect(company.status).toBe(201);
    const { data: saved } = (await company.json()) as {
      data: { logoUrl: string };
    };
    expect(saved.logoUrl).toBe(logo.url);

    const deleted = await request(
      `/api/v1/logos/${encodeURIComponent(logo.key)}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect((await request(logo.url)).status).toBe(404);
  });

  it("rejects non-image uploads", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    );
    const response = await request("/api/v1/logos", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(415);
  });
});
