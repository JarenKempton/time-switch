import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const companies = sqliteTable(
  "companies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    color: text("color"),
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

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    secret: text("secret"),
    setupTokenHash: text("setup_token_hash"),
    setupTokenExpiresAt: integer("setup_token_expires_at", {
      mode: "timestamp_ms",
    }),
    firmwareVersion: text("firmware_version"),
    provisionedAt: integer("provisioned_at", { mode: "timestamp_ms" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("idx_devices_name").on(table.name)],
);

export type Company = typeof companies.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Device = typeof devices.$inferSelect;

/**
 * A closed-out pay period. Each row covers [periodStart, periodEnd) for one
 * company; the next period opens at periodEnd and stays open until the next
 * row is recorded. There is no schedule: periods are closed by hand.
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
