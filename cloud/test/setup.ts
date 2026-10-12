import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});
