import { z } from "zod";
import { payPeriodCadences } from "../db/schema";

const nullableUrl = z
  .union([
    z
      .url()
      .refine(
        (value) => new URL(value).protocol === "https:",
        "Logo URL must use HTTPS.",
      ),
    z.literal(""),
  ])
  .nullable()
  .optional()
  .transform((value) => value || null);

const nullableColor = z
  .union([
    z.string().regex(/^#[0-9a-f]{6}$/i, "Color must be a six-digit hex value."),
    z.literal(""),
  ])
  .nullable()
  .optional()
  .transform((value) => value || null);

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD.");

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(100),
  logoUrl: nullableUrl,
  color: nullableColor,
  payPeriodCadence: z.enum(payPeriodCadences).default("biweekly"),
  payPeriodAnchorDate: dateOnly.optional(),
});

export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    logoUrl: nullableUrl,
    color: nullableColor,
    payPeriodCadence: z.enum(payPeriodCadences).optional(),
    payPeriodAnchorDate: dateOnly.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required.",
  );

export const startSessionSchema = z.object({
  id: z.uuid().optional(),
  companyId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
});

export const deviceStartSessionSchema = startSessionSchema.extend({
  id: z.uuid(),
});

export const stopSessionSchema = z.object({
  endedAt: z.iso.datetime({ offset: true }),
});

export const updateSessionSchema = z
  .object({
    companyId: z.uuid().optional(),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    endedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required.",
  );

export function parseDate(value: string): Date {
  return new Date(value);
}
