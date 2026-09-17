import { useMemo, useState } from "react";
import { ArrowRightIcon, PlayIcon, SquareIcon } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/skeleton";
import type { Company, Session } from "../api";
import { CompanyMark, companyStyle } from "../components/CompanyMark";
import { SessionDialog } from "../components/SessionDialog";
import {
  formatClock,
  formatDuration,
  formatHours,
  formatTime,
  formatWeekday,
} from "../format";
import type { TimeClockData } from "../use-time-clock";
import { navigate } from "../router";

const HOUR_MS = 3_600_000;
const HOUR_PX = 64;
/** The timeline never shows less than this many hours so blocks keep scale. */
const MIN_TIMELINE_HOURS = 6;

interface TodayBlock {
  session: Session;
  start: number;
  end: number;
  live: boolean;
}

/** Sessions clipped to today, oldest first. */
function todayBlocks(
  sessions: Session[],
  dayStart: number,
  dayEnd: number,
  now: number,
): TodayBlock[] {
  const blocks: TodayBlock[] = [];
  for (const session of sessions) {
    const started = new Date(session.startedAt).getTime();
    const ended = session.endedAt ? new Date(session.endedAt).getTime() : now;
    const start = Math.max(started, dayStart);
    const end = Math.min(ended, dayEnd);
    if (end <= start) continue;
    blocks.push({ session, start, end, live: !session.endedAt });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

export function Dashboard({ data }: { data: TimeClockData }) {
  const {
    status,
    now,
    companies,
    activeCompanies,
    sessions,
    loading,
    start,
    stop,
  } = data;
  const [editing, setEditing] = useState<Session | null>(null);
  const active = status.activeSession;
  const activeSeconds = active
    ? (now - new Date(active.startedAt).getTime()) / 1000
    : 0;

  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const dayEnd = dayStart + 24 * HOUR_MS;
  const blocks = useMemo(
    () => todayBlocks(sessions, dayStart, dayEnd, now),
    [sessions, dayStart, dayEnd, now],
  );

  const todaySeconds = blocks.reduce(
    (total, block) => total + (block.end - block.start) / 1000,
    0,
  );
  const split = useMemo(() => {
    const totals = new Map<string, number>();
    for (const block of blocks) {
      totals.set(
        block.session.companyId,
        (totals.get(block.session.companyId) ?? 0) +
          (block.end - block.start) / 1000,
      );
    }
    // Active companies always get a row, archived ones only if worked today.
    const listed = companies.filter(
      (company) => !company.archived || totals.has(company.id),
    );
    return listed
      .map((company) => ({ company, seconds: totals.get(company.id) ?? 0 }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [blocks, companies]);

  return (
    <>
      <section
        className={`hero ${active ? "hero--active" : ""}`}
        style={active ? companyStyle(active.company) : undefined}
      >
        <div className="hero-main">
          {active ? (
            <>
              <div className="hero-label">
                <span className="live-chip">
                  <i aria-hidden="true" />
                  Live
                </span>
                Clocked in
              </div>
              <div className="hero-company">
                <CompanyMark company={active.company} size="xl" />
                <div>
                  <h1>{active.company.name}</h1>
                  <p>Since {formatTime(active.startedAt)}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="hero-label">{formatWeekday(now)}</div>
              <h1>Clocked out</h1>
              <p>Pick a company to start a session.</p>
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
          <span>{active ? "This session" : "Today"}</span>
          <strong className="tabular">
            {active ? formatClock(activeSeconds) : formatDuration(todaySeconds)}
          </strong>
          {active && (
            <em className="tabular">{formatDuration(todaySeconds)} today</em>
          )}
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

      {!loading && !companies.length ? (
        <section className="section">
          <EmptyCompanies />
        </section>
      ) : (
        <section className="section today">
          <div className="today-main">
            <div className="section-heading">
              <h2>Today</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("history")}
              >
                History
                <ArrowRightIcon />
              </Button>
            </div>
            {loading ? (
              <Skeleton className="h-80" />
            ) : blocks.length ? (
              <Timeline
                blocks={blocks}
                dayStart={dayStart}
                now={now}
                onSelect={setEditing}
              />
            ) : (
              <div className="empty-panel">
                <strong>Nothing logged yet today</strong>
                <p>Sessions show up here as blocks once you clock in.</p>
              </div>
            )}
          </div>

          <aside className="today-side">
            <div className="today-total">
              <span className="eyebrow">Hours today</span>
              <strong className="tabular">
                {formatHours(todaySeconds)}
                <small> h</small>
              </strong>
              <span className="today-total-meta">
                {formatDuration(todaySeconds)} ·{" "}
                {blocks.length === 1
                  ? "1 session"
                  : `${blocks.length} sessions`}
              </span>
            </div>
            {split.length > 0 && (
              <div className="split-bar" aria-hidden="true">
                {split
                  .filter((entry) => entry.seconds > 0)
                  .map((entry) => (
                    <i
                      key={entry.company.id}
                      style={{
                        ...companyStyle(entry.company),
                        flexGrow: entry.seconds,
                      }}
                    />
                  ))}
              </div>
            )}
            <ul className="split-list">
              {split.map((entry) => (
                <li key={entry.company.id} style={companyStyle(entry.company)}>
                  <CompanyMark company={entry.company} size="sm" />
                  <span className="split-name">{entry.company.name}</span>
                  <span className="split-share">
                    {todaySeconds > 0
                      ? `${Math.round((entry.seconds / todaySeconds) * 100)}%`
                      : "—"}
                  </span>
                  <strong className="tabular">
                    {formatHours(entry.seconds)}
                    <small> h</small>
                  </strong>
                </li>
              ))}
            </ul>
          </aside>
        </section>
      )}

      <SessionDialog
        session={editing}
        companies={companies}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={async () => {
          setEditing(null);
          await data.refresh();
        }}
        onError={data.setError}
      />
    </>
  );
}

/**
 * A day schedule: hour rows down the page, one block per session placed by
 * its start and end. The visible window hugs the day's sessions and follows
 * the live session as it grows.
 */
function Timeline({
  blocks,
  dayStart,
  now,
  onSelect,
}: {
  blocks: TodayBlock[];
  dayStart: number;
  now: number;
  onSelect: (session: Session) => void;
}) {
  const firstStart = Math.min(...blocks.map((block) => block.start));
  const lastEnd = Math.max(...blocks.map((block) => block.end), now);
  const firstHour = Math.floor((firstStart - dayStart) / HOUR_MS);
  let lastHour = Math.ceil((lastEnd - dayStart) / HOUR_MS);
  if (lastHour - firstHour < MIN_TIMELINE_HOURS)
    lastHour = Math.min(24, firstHour + MIN_TIMELINE_HOURS);
  const windowStart = dayStart + firstHour * HOUR_MS;
  const hours = Array.from(
    { length: lastHour - firstHour + 1 },
    (_, index) => firstHour + index,
  );
  const y = (instant: number) => ((instant - windowStart) / HOUR_MS) * HOUR_PX;
  const height = (lastHour - firstHour) * HOUR_PX;
  const showNow = now >= windowStart && now <= dayStart + lastHour * HOUR_MS;

  return (
    <div className="timeline" style={{ height }}>
      <div className="timeline-hours" aria-hidden="true">
        {hours.map((hour) => (
          <span key={hour} style={{ top: (hour - firstHour) * HOUR_PX }}>
            {formatTime(dayStart + hour * HOUR_MS)}
          </span>
        ))}
      </div>
      <div className="timeline-track">
        {hours.map((hour) => (
          <i
            key={hour}
            className="timeline-rule"
            style={{ top: (hour - firstHour) * HOUR_PX }}
            aria-hidden="true"
          />
        ))}
        {blocks.map((block) => {
          const top = y(block.start);
          const blockHeight = Math.max(y(block.end) - top, 22);
          const compact = blockHeight < 44;
          const seconds = (block.end - block.start) / 1000;
          return (
            <button
              type="button"
              key={block.session.id}
              className={`timeline-block ${compact ? "timeline-block--compact" : ""} ${block.live ? "timeline-block--live" : ""}`}
              style={{
                ...companyStyle(block.session.company),
                top,
                height: blockHeight,
              }}
              onClick={() => onSelect(block.session)}
              title={`${block.session.company.name} · ${formatTime(block.start)} – ${block.live ? "now" : formatTime(block.end)} · ${formatDuration(seconds)}`}
            >
              <strong>{block.session.company.name}</strong>
              <span>
                {formatTime(block.start)} –{" "}
                {block.live ? "now" : formatTime(block.end)}
              </span>
              <em className="tabular">{formatDuration(seconds)}</em>
              {!compact && block.session.note && (
                <small>{block.session.note}</small>
              )}
            </button>
          );
        })}
        {showNow && (
          <div className="timeline-now" style={{ top: y(now) }}>
            <span className="tabular">{formatTime(now)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCompanies() {
  return (
    <div className="empty-panel">
      <strong>No companies yet</strong>
      <p>Add the companies you bill so you can clock into them.</p>
      <Button onClick={() => navigate("settings")}>Set up companies</Button>
    </div>
  );
}

export type { Company };
