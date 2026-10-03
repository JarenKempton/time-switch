import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { database } from "../db/client";
import { companies, sessions, type Company } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError, ok, readJson } from "../lib/http";
import { requireUuid } from "../lib/query";
import { createCompanySchema, updateCompanySchema } from "../lib/validation";
import { publish } from "../live/publish";
import { getCompany } from "../sessions/queries";

export const companyRoutes = new Hono<AppEnv>()
  .get("/api/v1/companies", async (context) => {
    const includeArchived = context.req.query("includeArchived") === "true";
    const rows = await database(context.env.DB)
      .select()
      .from(companies)
      .where(includeArchived ? undefined : eq(companies.archived, false))
      .orderBy(asc(companies.name))
      .all();
    return ok(rows);
  })
  .post("/api/v1/companies", async (context) => {
    const input = createCompanySchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    const now = new Date();
    const company: Company = {
      id: crypto.randomUUID(),
      name: input.name,
      logoUrl: input.logoUrl,
      color: input.color,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(companies).values(company);
    await publish(context.env, db, "company.changed");
    return ok(company, { status: 201 });
  })
  .patch("/api/v1/companies/:id", async (context) => {
    const id = requireUuid(context.req.param("id"), "Company");
    const input = updateCompanySchema.parse(await readJson(context.req.raw));
    const db = database(context.env.DB);
    if (!(await getCompany(db, id)))
      throw new ApiError(404, "company_not_found", "Company not found.");
    if (input.archived === true) {
      const active = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.companyId, id), isNull(sessions.endedAt)))
        .get();
      if (active)
        throw new ApiError(
          409,
          "company_in_use",
          "Stop the active session before archiving this company.",
        );
    }

    const [updated] = await db
      .update(companies)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        updatedAt: new Date(),
      })
      .where(eq(companies.id, id))
      .returning();
    await publish(context.env, db, "company.changed");
    return ok(updated);
  });
