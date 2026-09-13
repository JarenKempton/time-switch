import type { Company } from "./api";

export interface PayPeriodWindow {
  start: Date;
  end: Date;
}

const DAY_MS = 86_400_000;

function dateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function toDateInput(value: Date): string {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join("-");
}

function addDays(value: Date, days: number): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + days,
  );
}

function monthAtOffset(anchor: Date, offset: number): Date {
  const monthIndex = anchor.getFullYear() * 12 + anchor.getMonth() + offset;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(anchor.getDate(), lastDay));
}

function addMonthClamped(value: Date): Date {
  return monthAtOffset(value, 1);
}

function nextSemimonthlyBoundary(start: Date): Date {
  if (start.getDate() < 16)
    return new Date(start.getFullYear(), start.getMonth(), 16);
  return new Date(start.getFullYear(), start.getMonth() + 1, 1);
}

function currentSemimonthly(reference: Date): PayPeriodWindow {
  const start =
    reference.getDate() < 16
      ? new Date(reference.getFullYear(), reference.getMonth(), 1)
      : new Date(reference.getFullYear(), reference.getMonth(), 16);
  return { start, end: nextSemimonthlyBoundary(start) };
}

function currentFixed(
  anchor: Date,
  reference: Date,
  lengthDays: number,
): PayPeriodWindow {
  const anchorDay = Date.UTC(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
  );
  const referenceDay = Date.UTC(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
  );
  const periods = Math.floor((referenceDay - anchorDay) / DAY_MS / lengthDays);
  const start = addDays(anchor, periods * lengthDays);
  return { start, end: addDays(start, lengthDays) };
}

function currentMonthly(anchor: Date, reference: Date): PayPeriodWindow {
  let offset =
    (reference.getFullYear() - anchor.getFullYear()) * 12 +
    reference.getMonth() -
    anchor.getMonth();
  if (monthAtOffset(anchor, offset) > reference) offset -= 1;
  return {
    start: monthAtOffset(anchor, offset),
    end: monthAtOffset(anchor, offset + 1),
  };
}

export function payPeriodWindow(
  company: Pick<
    Company,
    "payPeriodCadence" | "payPeriodAnchorDate" | "createdAt"
  >,
  reference = new Date(),
  overrideStart?: string,
): PayPeriodWindow {
  const anchor = dateOnly(
    company.payPeriodAnchorDate ?? company.createdAt.slice(0, 10),
  );
  if (overrideStart) {
    const start = dateOnly(overrideStart);
    const end =
      company.payPeriodCadence === "weekly"
        ? addDays(start, 7)
        : company.payPeriodCadence === "biweekly"
          ? addDays(start, 14)
          : company.payPeriodCadence === "monthly"
            ? addMonthClamped(start)
            : nextSemimonthlyBoundary(start);
    return { start, end };
  }
  if (company.payPeriodCadence === "weekly")
    return currentFixed(anchor, reference, 7);
  if (company.payPeriodCadence === "biweekly")
    return currentFixed(anchor, reference, 14);
  if (company.payPeriodCadence === "monthly")
    return currentMonthly(anchor, reference);
  return currentSemimonthly(reference);
}
