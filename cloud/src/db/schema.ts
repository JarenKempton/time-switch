import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const payPeriodCadences = [
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
] as const;
export type PayPeriodCadence = (typeof payPeriodCadences)[number];

export const companies = sqliteTable(
  "companies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    color: text("color"),
    payPeriodCadence: text("pay_period_cadence", { enum: payPeriodCadences })
      .notNull()
      .default("biweekly"),
    payPeriodAnchorDate: text("pay_period_anchor_date"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("idx_companies_name").on(table.name)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_sessions_started_at").on(table.startedAt),
    index("idx_sessions_company_started_at").on(
      table.companyId,
      table.startedAt,
    ),
  ],
);

export type Company = typeof companies.$inferSelect;
export type Session = typeof sessions.$inferSelect;

/**
 * A recorded hours retrieval. Each row closes out a reporting window for one
 * company and states when the following window is scheduled to end. The most
 * recent row per company therefore defines the "current" pay period until it
 * lapses, after which the company's regular cadence resumes.
 */
export const hourRetrievals = sqliteTable(
  "hour_retrievals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    nextPeriodEnd: integer("next_period_end", {
      mode: "timestamp_ms",
    }).notNull(),
    totalSeconds: integer("total_seconds").notNull(),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("idx_hour_retrievals_company_period_end").on(
      table.companyId,
      table.periodEnd,
    ),
  ],
);

export type HourRetrieval = typeof hourRetrievals.$inferSelect;
