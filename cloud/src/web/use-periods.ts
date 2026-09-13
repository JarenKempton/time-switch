import { useEffect, useMemo, useState } from "react";
import { currentPeriod, type CurrentPeriod } from "../lib/pay-period";
import { timeClock, type Company, type Retrieval, type Status } from "./api";

export interface CompanyPeriod {
  company: Company;
  period: CurrentPeriod;
  /** Seconds worked inside the period, including the live session. */
  totalSeconds: number;
  /** Seconds still owed from before the period start, if any. */
  unretrievedSeconds: number;
  sessionCount: number;
  latestRetrieval: Retrieval | null;
  loaded: boolean;
}

interface FetchedTotal {
  totalSeconds: number;
  unretrievedSeconds: number;
  sessionCount: number;
  fetchedAt: number;
}

/**
 * Current pay period and running total for every active company. Totals come
 * from the server so they match what a retrieval will record; the elapsed part
 * of a live session is added locally between refreshes.
 */
export function usePeriods(
  companies: Company[],
  latestRetrievalByCompany: Map<string, Retrieval>,
  status: Status,
  now: number,
  refreshKey: unknown,
): CompanyPeriod[] {
  // Recompute period bounds at most once a minute so effects stay quiet.
  const minute = Math.floor(now / 60_000);
  const periods = useMemo(
    () =>
      companies.map((company) => {
        const latest = latestRetrievalByCompany.get(company.id) ?? null;
        return {
          company,
          latest,
          period: currentPeriod(
            company,
            latest
              ? {
                  periodEnd: new Date(latest.periodEnd),
                  nextPeriodEnd: new Date(latest.nextPeriodEnd),
                }
              : null,
            new Date(minute * 60_000),
          ),
        };
      }),
    [companies, latestRetrievalByCompany, minute],
  );

  const [totals, setTotals] = useState<Map<string, FetchedTotal>>(new Map());
  const boundsKey = periods
    .map(
      ({ company, period }) =>
        `${company.id}:${period.start.getTime()}:${period.end.getTime()}`,
    )
    .join("|");

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      periods.map(async ({ company, period }) => {
        const [inPeriod, before] = await Promise.all([
          timeClock.companyHours(company.id, period.start, period.end),
          period.unretrievedSince
            ? timeClock.companyHours(
                company.id,
                new Date(period.unretrievedSince),
                period.start,
              )
            : Promise.resolve(null),
        ]);
        return [
          company.id,
          {
            totalSeconds: inPeriod.totalSeconds,
            unretrievedSeconds: before?.totalSeconds ?? 0,
            sessionCount: inPeriod.sessionCount,
            fetchedAt: Date.now(),
          },
        ] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setTotals(new Map(entries));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // boundsKey captures every period bound; refreshKey changes on data updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, refreshKey]);

  return periods.map(({ company, period, latest }) => {
    const fetched = totals.get(company.id);
    const active = status.activeSession;
    const liveExtra =
      fetched &&
      active &&
      active.companyId === company.id &&
      new Date(active.startedAt) < period.end
        ? Math.max(0, now - fetched.fetchedAt) / 1000
        : 0;
    return {
      company,
      period,
      totalSeconds: (fetched?.totalSeconds ?? 0) + liveExtra,
      unretrievedSeconds: fetched?.unretrievedSeconds ?? 0,
      sessionCount: fetched?.sessionCount ?? 0,
      latestRetrieval: latest,
      loaded: Boolean(fetched),
    };
  });
}
