import { z } from "zod";

const nullableUrl = z
  .union([
    z.url().refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "Logo URL must use HTTPS."),
    // Logos uploaded to R2 are referenced by their same-origin path.
    z.string().regex(/^\/logos\/[A-Za-z0-9._%-]+$/, "Logo path is invalid."),
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

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(100),
  logoUrl: nullableUrl,
  color: nullableColor,
});

export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    logoUrl: nullableUrl,
    color: nullableColor,
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

export const createDeviceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const provisionDeviceSchema = z.object({
  deviceId: z.uuid(),
  setupToken: z.string().regex(/^[a-f0-9]{64}$/i),
  firmwareVersion: z.string().trim().min(1).max(64),
});

export const heartbeatDeviceSchema = z.object({
  firmwareVersion: z.string().trim().min(1).max(64),
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

/**
 * Closes the open pay period at `periodEnd`. The start is always the end of
 * the previous retrieval (or the beginning of time), so only the end is sent.
 */
export const createRetrievalSchema = z.object({
  periodEnd: z.iso.datetime({ offset: true }),
  note: z.string().trim().max(500).nullable().optional(),
});
