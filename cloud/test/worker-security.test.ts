import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/worker";

describe("Worker security boundary", () => {
  it("fails closed when browser routes have no Cloudflare Access context", async () => {
    const fetch = worker.fetch as (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
    const response = await fetch(
      new Request("https://example.test/api/v1/status"),
      {} as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "access_required" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
