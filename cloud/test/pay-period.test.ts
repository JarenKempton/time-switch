import { describe, expect, it } from "vitest";
import { payPeriodWindow, toDateInput } from "../src/web/pay-period";

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
