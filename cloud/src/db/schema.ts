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
