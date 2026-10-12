import { ApiError } from "./http";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function requireUuid(value: string, label: string): string {
  if (!isUuid(value))
    throw new ApiError(400, "invalid_id", `${label} ID is invalid.`);
  return value;
}

export function queryNumber(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 0), maximum)
    : fallback;
}

export function parseOptionalQueryDate(
  value: string | null,
  name: string,
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ApiError(
      400,
      `invalid_${name}`,
      `${name} must be an ISO date or timestamp.`,
    );
  return date;
}

export function readRange(url: URL): { from: Date | null; to: Date | null } {
  const from = parseOptionalQueryDate(url.searchParams.get("from"), "from");
  const to = parseOptionalQueryDate(url.searchParams.get("to"), "to");
  if (from && to && from >= to)
    throw new ApiError(
      422,
      "invalid_range",
      "The end must be after the start.",
    );
  return { from, to };
}
