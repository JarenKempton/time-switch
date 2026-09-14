import type { PayPeriodCadence } from "../../db/schema";

export interface PayPeriodWindow {
  start: Date;
  end: Date;
}

export interface CadenceCompany {
  payPeriodCadence: PayPeriodCadence;
  payPeriodAnchorDate: string | null;
  createdAt: string | Date;
}

/** The latest recorded retrieval for a company, as instants. */
export interface RetrievalMarker {
  periodEnd: Date;
  nextPeriodEnd: Date;
}

export interface CurrentPeriod extends PayPeriodWindow {
  /** "custom" when the window came from a retrieval choice, else "cadence". */
  source: "cadence" | "custom";
  /** Instant from which hours have not yet been retrieved. */
  unretrievedSince: Date | null;
}

export type NextPeriodChoice =
  | "next_boundary"
  | "skip_boundary"
  | "full_cadence"
  | "custom";

export interface NextPeriodOption {
  key: NextPeriodChoice;
  label: string;
  detail: string;
  end: Date | null;
  /** When true, the company anchor is moved to the retrieval date. */
  reanchor: boolean;
}

const DAY_MS = 86_400_000;

export const cadenceLabels: Record<PayPeriodCadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
};

export function dateOnly(value: string): Date {
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

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number): Date {
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

function anchorOf(company: CadenceCompany): Date {
  if (company.payPeriodAnchorDate) return dateOnly(company.payPeriodAnchorDate);
  return startOfDay(new Date(company.createdAt));
}

/** One full cadence length added to a start date. */
export function addCadence(cadence: PayPeriodCadence, start: Date): Date {
  switch (cadence) {
    case "weekly":
      return addDays(start, 7);
    case "biweekly":
      return addDays(start, 14);
    case "monthly":
      return monthAtOffset(start, 1);
    case "semimonthly":
      return nextSemimonthlyBoundary(start);
  }
}

/**
 * The regular cadence window containing `reference`. When `overrideStart` is
 * given the window simply runs one cadence length from that date.
 */
export function payPeriodWindow(
  company: CadenceCompany,
  reference = new Date(),
  overrideStart?: string,
): PayPeriodWindow {
  if (overrideStart) {
    const start = dateOnly(overrideStart);
    return { start, end: addCadence(company.payPeriodCadence, start) };
  }
  const anchor = anchorOf(company);
  switch (company.payPeriodCadence) {
    case "weekly":
      return currentFixed(anchor, reference, 7);
    case "biweekly":
      return currentFixed(anchor, reference, 14);
    case "monthly":
      return currentMonthly(anchor, reference);
    case "semimonthly":
      return currentSemimonthly(reference);
  }
}

/** The first regular cadence boundary strictly after `reference`. */
export function nextBoundaryAfter(
  company: CadenceCompany,
  reference: Date,
): Date {
  return payPeriodWindow(company, reference).end;
}

/**
 * The period a company is currently accumulating hours in.
 *
 * - With no retrieval on record, it is the plain cadence window.
 * - Right after a retrieval, it is the custom window chosen at retrieval
 *   time: from the retrieval instant to the chosen end.
 * - Once that custom window lapses, the cadence window containing
 *   `reference` resumes, with its start never earlier than the custom end.
 *
 * `unretrievedSince` is set when hours older than the window start are still
 * waiting to be retrieved, so the dashboard can flag them.
 */
export function currentPeriod(
  company: CadenceCompany,
  latest: RetrievalMarker | null,
  reference = new Date(),
): CurrentPeriod {
  if (latest && reference < latest.nextPeriodEnd) {
    return {
      start: latest.periodEnd,
      end: latest.nextPeriodEnd,
      source: "custom",
      unretrievedSince: null,
    };
  }
  const regular = payPeriodWindow(company, reference);
  if (!latest) {
    return { ...regular, source: "cadence", unretrievedSince: null };
  }
  const start =
    latest.nextPeriodEnd > regular.start ? latest.nextPeriodEnd : regular.start;
  return {
    start,
    end: regular.end,
    source: "cadence",
    unretrievedSince: latest.periodEnd < start ? latest.periodEnd : null,
  };
}

/**
 * Choices for when the period that follows a manual retrieval should end.
 * `retrievedOn` is the day the retrieval happens.
 */
export function nextPeriodOptions(
  company: CadenceCompany,
  retrievedOn: Date,
): NextPeriodOption[] {
  const today = startOfDay(retrievedOn);
  const nextBoundary = nextBoundaryAfter(company, today);
  const skipBoundary = nextBoundaryAfter(company, nextBoundary);
  const cadenceLabel = cadenceLabels[company.payPeriodCadence].toLowerCase();
  const options: NextPeriodOption[] = [
    {
      key: "next_boundary",
      label: "Restart today, keep the regular schedule",
      detail: "Runs from now until the next regular cutoff.",
      end: nextBoundary,
      reanchor: false,
    },
    {
      key: "skip_boundary",
      label: "Skip the next cutoff",
      detail: "Fold the remaining days into the following period.",
      end: skipBoundary,
      reanchor: false,
    },
  ];
  if (company.payPeriodCadence !== "semimonthly") {
    options.push({
      key: "full_cadence",
      label: `Full period from today (${cadenceLabel})`,
      detail: "Moves the schedule so future periods start from today.",
      end: addCadence(company.payPeriodCadence, today),
      reanchor: true,
    });
  }
  options.push({
    key: "custom",
    label: "Pick an end date",
    detail: "Choose exactly when the next period should end.",
    end: null,
    reanchor: false,
  });
  return options;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** Plain-language schedule, e.g. "Every 2 weeks, Mon to Sun". */
export function describeCadence(company: CadenceCompany): string {
  const anchor = anchorOf(company);
  switch (company.payPeriodCadence) {
    case "weekly":
    case "biweekly": {
      const first = WEEKDAYS[anchor.getDay()];
      const last = WEEKDAYS[(anchor.getDay() + 6) % 7];
      return `${cadenceLabels[company.payPeriodCadence]}, ${first} to ${last}`;
    }
    case "semimonthly":
      return "1st to 15th, then 16th to month end";
    case "monthly":
      return anchor.getDate() === 1
        ? "Monthly, calendar month"
        : `Monthly, from the ${ordinal(anchor.getDate())}`;
  }
}

/** The cadence window containing `reference` followed by `count - 1` more. */
export function upcomingPeriods(
  company: CadenceCompany,
  reference = new Date(),
  count = 3,
): PayPeriodWindow[] {
  const windows: PayPeriodWindow[] = [];
  let window = payPeriodWindow(company, reference);
  for (let index = 0; index < count; index += 1) {
    windows.push(window);
    window = payPeriodWindow(company, window.end);
  }
  return windows;
}
