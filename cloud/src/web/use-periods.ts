import { useEffect, useState } from "react";
import { timeClock, type Company, type Retrieval, type Status } from "./api";

export interface CompanyPeriod {
  company: Company;
  /** Where the open period begins: the end of the last retrieval. */
  start: Date;
  /** Seconds worked since `start`, including the live session. */
  totalSeconds: number;
  sessionCount: number;
  latestRetrieval: Retrieval | null;
  loaded: boolean;
}

interface FetchedPeriod {
  start: Date;
  totalSeconds: number;
  sessionCount: number;
  fetchedAt: number;
}

/**
 * The open pay period for every active company. Bounds and totals come from
 * the server so they match what a retrieval will record; the elapsed part of
 * a live session is added locally between refreshes.
 */
export function usePeriods(
  companies: Company[],
  latestRetrievalByCompany: Map<string, Retrieval>,
  status: Status,
  now: number,
  refreshKey: unknown,
): CompanyPeriod[] {
  const [fetched, setFetched] = useState<Map<string, FetchedPeriod>>(new Map());
  const companyKey = companies.map((company) => company.id).join("|");

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      companies.map(async (company) => {
        const period = await timeClock.openPeriod(company.id);
        return [
          company.id,
          {
            start: new Date(period.start),
            totalSeconds: period.totalSeconds,
            sessionCount: period.sessionCount,
            fetchedAt: Date.now(),
          },
        ] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setFetched(new Map(entries));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // companyKey covers the company list; refreshKey changes on data updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyKey, refreshKey]);

  return companies.map((company) => {
    const period = fetched.get(company.id);
    const active = status.activeSession;
    const liveExtra =
      period && active && active.companyId === company.id
        ? Math.max(0, now - period.fetchedAt) / 1000
        : 0;
    return {
      company,
      start: period?.start ?? new Date(company.createdAt),
      totalSeconds: (period?.totalSeconds ?? 0) + liveExtra,
      sessionCount: period?.sessionCount ?? 0,
      latestRetrieval: latestRetrievalByCompany.get(company.id) ?? null,
      loaded: Boolean(period),
    };
  });
}
