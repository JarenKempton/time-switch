import { describe, expect, it } from "vitest";
import {
  currentPeriod,
  nextPeriodOptions,
  payPeriodWindow,
  toDateInput,
} from "../src/web/lib/pay-period";

const baseCompany = {
  createdAt: "2026-01-01T00:00:00.000Z",
  payPeriodAnchorDate: "2026-09-01",
} as const;

describe("pay period windows", () => {
  it("aligns a biweekly window to the company anchor", () => {
    const window = payPeriodWindow(
      { ...baseCompany, payPeriodCadence: "biweekly" },
      new Date(2026, 8, 20),
    );
    expect(toDateInput(window.start)).toBe("2026-09-15");
    expect(toDateInput(window.end)).toBe("2026-09-29");
  });

  it("uses the first and sixteenth as semimonthly boundaries", () => {
    const window = payPeriodWindow(
      { ...baseCompany, payPeriodCadence: "semimonthly" },
      new Date(2026, 8, 20),
    );
    expect(toDateInput(window.start)).toBe("2026-09-16");
    expect(toDateInput(window.end)).toBe("2026-10-01");
  });

  it("preserves a month-end anchor without drifting after February", () => {
    const window = payPeriodWindow(
      {
        ...baseCompany,
        payPeriodCadence: "monthly",
        payPeriodAnchorDate: "2026-01-31",
      },
      new Date(2026, 2, 30),
    );
    expect(toDateInput(window.start)).toBe("2026-02-28");
    expect(toDateInput(window.end)).toBe("2026-03-31");
  });

  it("derives an override end from the configured cadence", () => {
    const window = payPeriodWindow(
      { ...baseCompany, payPeriodCadence: "weekly" },
      new Date(2026, 8, 20),
      "2026-09-10",
    );
    expect(toDateInput(window.start)).toBe("2026-09-10");
    expect(toDateInput(window.end)).toBe("2026-09-17");
  });
});

describe("current period with retrievals", () => {
  const company = {
    ...baseCompany,
    payPeriodCadence: "biweekly",
  } as const;

  it("uses the custom window right after a retrieval", () => {
    const period = currentPeriod(
      company,
      {
        periodEnd: new Date(2026, 8, 13, 14, 0),
        nextPeriodEnd: new Date(2026, 8, 29),
      },
      new Date(2026, 8, 20),
    );
    expect(period.source).toBe("custom");
    expect(period.start).toEqual(new Date(2026, 8, 13, 14, 0));
    expect(toDateInput(period.end)).toBe("2026-09-29");
    expect(period.unretrievedSince).toBeNull();
  });

  it("falls back to the cadence once the custom window lapses", () => {
    const period = currentPeriod(
      company,
      {
        periodEnd: new Date(2026, 8, 13, 14, 0),
        nextPeriodEnd: new Date(2026, 8, 20),
      },
      new Date(2026, 8, 25),
    );
    expect(period.source).toBe("cadence");
    expect(toDateInput(period.start)).toBe("2026-09-20");
    expect(toDateInput(period.end)).toBe("2026-09-29");
    expect(period.unretrievedSince).toEqual(new Date(2026, 8, 13, 14, 0));
  });

  it("offers next-period choices relative to the retrieval day", () => {
    const options = nextPeriodOptions(company, new Date(2026, 8, 13, 10));
    const byKey = Object.fromEntries(options.map((o) => [o.key, o.end]));
    expect(toDateInput(byKey.next_boundary!)).toBe("2026-09-15");
    expect(toDateInput(byKey.skip_boundary!)).toBe("2026-09-29");
    expect(toDateInput(byKey.full_cadence!)).toBe("2026-09-27");
    expect(byKey.custom).toBeNull();
  });

  it("omits the full-cadence choice for semimonthly companies", () => {
    const options = nextPeriodOptions(
      { ...baseCompany, payPeriodCadence: "semimonthly" },
      new Date(2026, 8, 13),
    );
    expect(options.map((o) => o.key)).not.toContain("full_cadence");
  });
});
