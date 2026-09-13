import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  timeClock,
  type Company,
  type Retrieval,
  type Session,
  type Status,
} from "./api";
import { registerTimeClockTools } from "./webmcp";

const EMPTY_STATUS: Status = {
  activeSession: null,
  serverTime: new Date().toISOString(),
};

export interface TimeClockData {
  companies: Company[];
  activeCompanies: Company[];
  sessions: Session[];
  retrievals: Retrieval[];
  latestRetrievalByCompany: Map<string, Retrieval>;
  status: Status;
  now: number;
  connected: boolean;
  loading: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  refresh: () => Promise<void>;
  start: (company: Company) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Single source of truth for the dashboard. Loads everything once, refreshes
 * on every WebSocket message, and ticks a shared clock once a second so timers
 * across the page stay in step.
 */
export function useTimeClock(): TimeClockData {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [retrievals, setRetrievals] = useState<Retrieval[]>([]);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [now, setNow] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const task = Promise.all([
      timeClock.companies(true),
      timeClock.sessions({ limit: "200" }),
      timeClock.status(),
      timeClock.retrievals(),
    ])
      .then(([nextCompanies, nextSessions, nextStatus, nextRetrievals]) => {
        setCompanies(nextCompanies);
        setSessions(nextSessions);
        setStatus(nextStatus);
        setRetrievals(nextRetrievals);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load the time clock.",
        ),
      )
      .finally(() => {
        setLoading(false);
        refreshInFlight.current = null;
      });
    refreshInFlight.current = task;
    return task;
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/api/v1/live`,
      );
      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("message", () => void refresh());
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 1500);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, [refresh]);

  useEffect(() => registerTimeClockTools(refresh), [refresh]);

  const start = useCallback(
    async (company: Company) => {
      try {
        setError(null);
        await timeClock.startSession(company.id);
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to start the session.",
        );
      }
    },
    [refresh],
  );

  const stop = useCallback(async () => {
    if (!status.activeSession) return;
    try {
      setError(null);
      await timeClock.stopSession(status.activeSession.id);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to stop the session.",
      );
    }
  }, [refresh, status.activeSession]);

  const activeCompanies = useMemo(
    () => companies.filter((company) => !company.archived),
    [companies],
  );

  const latestRetrievalByCompany = useMemo(() => {
    const map = new Map<string, Retrieval>();
    for (const retrieval of retrievals) {
      const current = map.get(retrieval.companyId);
      if (!current || retrieval.periodEnd > current.periodEnd)
        map.set(retrieval.companyId, retrieval);
    }
    return map;
  }, [retrievals]);

  return {
    companies,
    activeCompanies,
    sessions,
    retrievals,
    latestRetrievalByCompany,
    status,
    now,
    connected,
    loading,
    error,
    setError,
    refresh,
    start,
    stop,
  };
}
