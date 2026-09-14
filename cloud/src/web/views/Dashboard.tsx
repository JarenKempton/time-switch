import { useState } from "react";
import {
  ArrowRightIcon,
  DownloadIcon,
  PlayIcon,
  ReceiptTextIcon,
  SquareIcon,
} from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/skeleton";
import { describeCadence } from "../lib/pay-period";
import { timeClock, type Company } from "../api";
import { CompanyMark, companyStyle } from "../components/CompanyMark";
import { RetrieveHoursDialog } from "../components/RetrieveHoursDialog";
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatDuration,
  formatHours,
  formatRange,
  formatRelative,
  formatTime,
  sessionSeconds,
} from "../format";
import type { CompanyPeriod } from "../use-periods";
import type { TimeClockData } from "../use-time-clock";
import { navigate } from "../router";

function periodProgress(period: CompanyPeriod["period"], now: number): number {
  const span = period.end.getTime() - period.start.getTime();
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - period.start.getTime()) / span));
}

function daysLeft(end: Date, now: number): string {
  const days = Math.ceil((end.getTime() - now) / 86_400_000);
  if (days <= 0) return "ends today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

export function Dashboard({
  data,
  periods,
}: {
  data: TimeClockData;
  periods: CompanyPeriod[];
}) {
  const { status, now, activeCompanies, sessions, loading, start, stop } = data;
  const [retrieving, setRetrieving] = useState<CompanyPeriod | null>(null);
  const active = status.activeSession;
  const activeSeconds = active
    ? (now - new Date(active.startedAt).getTime()) / 1000
    : 0;
  const activeEntry = active
    ? periods.find((entry) => entry.company.id === active.companyId)
    : null;
  const recent = sessions.slice(0, 8);
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const todaySeconds = sessions.reduce((total, session) => {
    const end = session.endedAt ? new Date(session.endedAt).getTime() : now;
    const startMs = Math.max(new Date(session.startedAt).getTime(), todayStart);
    return end > startMs ? total + (end - startMs) / 1000 : total;
  }, 0);

  return (
    <>
      <section
        className={`hero ${active ? "hero--active" : ""}`}
        style={active ? companyStyle(active.company) : undefined}
      >
        <div className="hero-main">
          {active ? (
            <>
              <div className="hero-label">Clocked in</div>
              <div className="hero-company">
                <div>
                  <h1>{active.company.name}</h1>
                  <p>
                    Since {formatTime(active.startedAt)}
                    {activeEntry && (
                      <>
                        {" · "}
                        {formatDuration(activeEntry.totalSeconds)} this period
                      </>
                    )}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="hero-label">Clocked out</div>
              <h1>Clocked out</h1>
              <p>Flip the desk switch or pick a company to start a session.</p>
            </>
          )}
          {!active && (
            <div className="hero-actions">
              {loading ? (
                <Skeleton className="h-9 w-40" />
              ) : (
                activeCompanies.map((company) => (
                  <Button
                    key={company.id}
                    size="lg"
                    variant="outline"
                    className="clock-in"
                    style={companyStyle(company)}
                    onClick={() => void start(company)}
                  >
                    <PlayIcon className="fill-current" />
                    {company.name}
                  </Button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="hero-timer">
          <span>{active ? "Session" : "Today"}</span>
          <strong className="tabular">
            {active ? formatClock(activeSeconds) : formatDuration(todaySeconds)}
          </strong>
        </div>
        {active && (
          <Button
            size="lg"
            variant="outline"
            className="clock-out"
            onClick={() => void stop()}
          >
            <SquareIcon className="fill-current" />
            Clock out
          </Button>
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <h2>Pay periods</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate("history")}>
            Full history
            <ArrowRightIcon />
          </Button>
        </div>
        {loading ? (
          <div className="period-grid">
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </div>
        ) : periods.length ? (
          <div className="period-grid">
            {periods.map((entry) => (
              <PeriodCard
                key={entry.company.id}
                entry={entry}
                now={now}
                isActive={active?.companyId === entry.company.id}
                onRetrieve={() => setRetrieving(entry)}
              />
            ))}
          </div>
        ) : (
          <EmptyCompanies />
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <h2>Recent sessions</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate("history")}>
            All sessions
            <ArrowRightIcon />
          </Button>
        </div>
        {recent.length ? (
          <ul className="session-list">
            {recent.map((session) => (
              <li key={session.id} style={companyStyle(session.company)}>
                <CompanyMark company={session.company} size="sm" />
                <div className="session-list-body">
                  <strong>{session.company.name}</strong>
                  <span>
                    {formatDateTime(session.startedAt)}
                    {session.endedAt
                      ? ` – ${formatTime(session.endedAt)}`
                      : " – now"}
                    {session.note ? ` · ${session.note}` : ""}
                  </span>
                </div>
                {!session.endedAt && (
                  <span className="live-chip">
                    <i aria-hidden="true" />
                    Live
                  </span>
                )}
                <span className="tabular session-list-duration">
                  {formatDuration(sessionSeconds(session, now))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Sessions will show up here as you work.</p>
        )}
      </section>

      <RetrieveHoursDialog
        entry={retrieving}
        onOpenChange={(open) => {
          if (!open) setRetrieving(null);
        }}
        onSaved={async () => {
          setRetrieving(null);
          await data.refresh();
        }}
        onError={data.setError}
      />
    </>
  );
}

function PeriodCard({
  entry,
  now,
  isActive,
  onRetrieve,
}: {
  entry: CompanyPeriod;
  now: number;
  isActive: boolean;
  onRetrieve: () => void;
}) {
  const { company, period, totalSeconds, unretrievedSeconds, latestRetrieval } =
    entry;
  const progress = periodProgress(period, now);
  const exportUrl = timeClock.exportUrl({
    companyId: company.id,
    from: (period.unretrievedSince ?? period.start).toISOString(),
    to: period.end.toISOString(),
  });
  return (
    <article
      className={`period-card ${isActive ? "period-card--active" : ""}`}
      style={companyStyle(company)}
    >
      <header>
        <CompanyMark company={company} />
        <div>
          <h3>{company.name}</h3>
          <span>
            {describeCadence(company)}
            {period.source === "custom" ? " · custom" : ""}
          </span>
        </div>
        {isActive && (
          <span className="live-chip">
            <i aria-hidden="true" />
            Live
          </span>
        )}
      </header>

      <div className="period-total">
        <strong className="tabular">
          {entry.loaded ? formatHours(totalSeconds) : "—"}
          <small> h</small>
          {entry.loaded && (
            <em className="tabular">{formatDuration(totalSeconds)}</em>
          )}
        </strong>
        <span>{formatRange(period.start, period.end)}</span>
      </div>

      <div
        className="period-progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${company.name} pay period progress`}
      >
        <i style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="period-meta">
        <span>{daysLeft(period.end, now)}</span>
        <span>
          {latestRetrieval
            ? `Last pulled ${formatRelative(latestRetrieval.createdAt, now)}`
            : "Never pulled"}
        </span>
      </div>

      {period.unretrievedSince && (
        <p className="period-backlog">
          <ReceiptTextIcon />
          {formatHours(unretrievedSeconds)} h from before{" "}
          {formatDate(period.start)} still to retrieve.
        </p>
      )}

      <footer>
        <Button onClick={onRetrieve} className="grow">
          <ReceiptTextIcon />
          Get hours
        </Button>
        <Button variant="outline" size="icon" asChild>
          <a href={exportUrl} aria-label={`Export ${company.name} CSV`}>
            <DownloadIcon />
          </a>
        </Button>
      </footer>
    </article>
  );
}

function EmptyCompanies() {
  return (
    <div className="empty-panel">
      <strong>No companies yet</strong>
      <p>Add the companies you bill so each one gets its own pay period.</p>
      <Button onClick={() => navigate("settings")}>Set up companies</Button>
    </div>
  );
}

export type { Company };
