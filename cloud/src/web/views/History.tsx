import { useEffect, useMemo, useState } from "react";
import {
  DownloadIcon,
  PencilIcon,
  ReceiptTextIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/web/components/ui/alert-dialog";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import { dateOnly, toDateInput } from "../lib/dates";
import { timeClock, type Session, type Summary } from "../api";
import { CompanyMark, companyStyle } from "../components/CompanyMark";
import { RetrieveHoursDialog } from "../components/RetrieveHoursDialog";
import { SessionDialog } from "../components/SessionDialog";
import {
  formatDateTime,
  formatDuration,
  formatHours,
  formatRange,
  formatRelative,
  formatTime,
  sessionSeconds,
} from "../format";
import { usePeriods, type CompanyPeriod } from "../use-periods";
import type { TimeClockData } from "../use-time-clock";

const ALL = "all";

export function History({ data }: { data: TimeClockData }) {
  const {
    companies,
    activeCompanies,
    retrievals,
    latestRetrievalByCompany,
    status,
    now,
    loading,
  } = data;
  const periods = usePeriods(
    activeCompanies,
    latestRetrievalByCompany,
    status,
    now,
    data.sessions,
  );
  const [retrieving, setRetrieving] = useState<CompanyPeriod | null>(null);
  const [companyId, setCompanyId] = useState(ALL);
  const [from, setFrom] = useState(() =>
    toDateInput(new Date(Date.now() - 30 * 86_400_000)),
  );
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Session[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [editing, setEditing] = useState<Session | null>(null);

  const range = useMemo(() => {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? dateOnly(from) : null;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? new Date(dateOnly(to).getTime() + 86_400_000)
      : null;
    return { start, end };
  }, [from, to]);

  const params = {
    companyId: companyId === ALL ? undefined : companyId,
    from: range.start?.toISOString(),
    to: range.end?.toISOString(),
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      timeClock.sessions({ ...params, limit: "500" }),
      range.start
        ? timeClock.summary(range.start, range.end ?? new Date(now + 1))
        : Promise.resolve(null),
    ])
      .then(([nextRows, nextSummary]) => {
        if (cancelled) return;
        setRows(nextRows);
        setSummary(nextSummary);
      })
      .catch((cause: unknown) =>
        data.setError(
          cause instanceof Error ? cause.message : "Unable to load history.",
        ),
      );
    return () => {
      cancelled = true;
    };
    // `now` is intentionally excluded so the range does not refetch each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range.start?.getTime(), range.end?.getTime(), data.sessions]);

  const totals = (summary?.companies ?? []).filter(
    (company) =>
      company.totalSeconds > 0 &&
      (companyId === ALL || company.id === companyId),
  );
  const grand = totals.reduce((sum, company) => sum + company.totalSeconds, 0);
  const visibleRetrievals = retrievals.filter(
    (retrieval) => companyId === ALL || retrieval.companyId === companyId,
  );

  async function remove(id: string) {
    try {
      await timeClock.deleteSession(id);
      await data.refresh();
    } catch (cause) {
      data.setError(
        cause instanceof Error
          ? cause.message
          : "Unable to delete the session.",
      );
    }
  }

  async function undo(id: string) {
    try {
      await timeClock.deleteRetrieval(id);
      await data.refresh();
    } catch (cause) {
      data.setError(
        cause instanceof Error ? cause.message : "Unable to undo retrieval.",
      );
    }
  }

  return (
    <>
      <section className="section section--first">
        <div className="section-heading">
          <h2>Pay periods</h2>
        </div>
        {loading ? (
          <div className="period-grid">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : periods.length ? (
          <div className="period-grid">
            {periods.map((entry) => (
              <PeriodCard
                key={entry.company.id}
                entry={entry}
                now={now}
                isActive={status.activeSession?.companyId === entry.company.id}
                onRetrieve={() => setRetrieving(entry)}
              />
            ))}
          </div>
        ) : (
          <p className="empty">Add a company to start tracking pay periods.</p>
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <h2>Closed periods</h2>
        </div>
        {visibleRetrievals.length ? (
          <div className="table-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRetrievals.map((retrieval) => {
                  const isLatest =
                    latestRetrievalByCompany.get(retrieval.companyId)?.id ===
                    retrieval.id;
                  return (
                    <TableRow key={retrieval.id}>
                      <TableCell>
                        <span className="cell-company">
                          <CompanyMark company={retrieval.company} size="sm" />
                          {retrieval.company.name}
                        </span>
                      </TableCell>
                      <TableCell>
                        {formatDateTime(retrieval.periodStart)} –{" "}
                        {formatDateTime(retrieval.periodEnd)}
                      </TableCell>
                      <TableCell className="text-right tabular font-semibold">
                        {formatHours(retrieval.totalSeconds)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(retrieval.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">
                        {retrieval.note ?? ""}
                      </TableCell>
                      <TableCell className="text-right">
                        {isLatest && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Reopen this period"
                                title="Reopen this period"
                              >
                                <Undo2Icon />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Reopen this period?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  Its hours are folded back into the open period
                                  for {retrieval.company.name}.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Keep</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => void undo(retrieval.id)}
                                >
                                  Reopen
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="empty">
            No periods closed yet. Use “Close period” above when you send hours
            in.
          </p>
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <h2>Sessions</h2>
          <Button variant="outline" size="sm" asChild>
            <a href={timeClock.exportUrl(params)}>
              <DownloadIcon />
              Export CSV
            </a>
          </Button>
        </div>
        <div className="filters">
          <div className="field-stack">
            <Label htmlFor="history-company">Company</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger id="history-company" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All companies</SelectItem>
                {companies.map((company) => (
                  <SelectItem key={company.id} value={company.id}>
                    {company.name}
                    {company.archived ? " (archived)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field-stack">
            <Label htmlFor="history-from">From</Label>
            <Input
              id="history-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="field-stack">
            <Label htmlFor="history-to">To</Label>
            <Input
              id="history-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </div>

        {summary && (
          <div className="stat-row">
            <div className="stat">
              <span>Total in range</span>
              <strong className="tabular">
                {formatHours(grand)}
                <small> h</small>
              </strong>
            </div>
            {totals.map((company) => (
              <div
                className="stat"
                key={company.id}
                style={companyStyle(company)}
              >
                <span>
                  <CompanyMark company={company} size="sm" /> {company.name}
                </span>
                <strong className="tabular">
                  {formatHours(company.totalSeconds)}
                  <small> h</small>
                </strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section section--tight">
        <div className="section-heading">
          <span className="text-sm text-muted-foreground">
            {rows.length} session{rows.length === 1 ? "" : "s"} in range
          </span>
        </div>
        {rows.length ? (
          <div className="table-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Ended</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <span className="cell-company">
                        <CompanyMark company={session.company} size="sm" />
                        {session.company.name}
                      </span>
                    </TableCell>
                    <TableCell>{formatDateTime(session.startedAt)}</TableCell>
                    <TableCell>
                      {session.endedAt ? (
                        formatTime(session.endedAt)
                      ) : (
                        <span className="text-muted-foreground">now</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular font-semibold">
                      {formatDuration(sessionSeconds(session, now))}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {session.note ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="row-actions">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Edit session"
                          title="Edit times, company, or note"
                          onClick={() => setEditing(session)}
                        >
                          <PencilIcon />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete session"
                              title="Delete this session"
                            >
                              <Trash2Icon />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Delete this session?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {session.company.name},{" "}
                                {formatDateTime(session.startedAt)}
                                {session.endedAt
                                  ? ` – ${formatTime(session.endedAt)}`
                                  : " – now"}{" "}
                                ({formatDuration(sessionSeconds(session, now))}
                                ). The hours are removed from every total and
                                this cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => void remove(session.id)}
                              >
                                Delete session
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="empty">No sessions in this range.</p>
        )}
      </section>

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
  const { company, start, totalSeconds, sessionCount, latestRetrieval } = entry;
  const exportUrl = timeClock.exportUrl({
    companyId: company.id,
    from: start.toISOString(),
  });
  return (
    <article
      className={`period-card ${isActive ? "period-card--active" : ""}`}
      style={companyStyle(company)}
    >
      <header className="period-card-header">
        <CompanyMark company={company} />
        <h3>{company.name}</h3>
        <span className="period-cadence">
          Open since {formatDateTime(start)}
        </span>
      </header>

      <div className="period-total">
        <strong className="tabular">
          {entry.loaded ? formatHours(totalSeconds) : "—"}
          <small> h</small>
          {entry.loaded && (
            <em className="tabular">{formatDuration(totalSeconds)}</em>
          )}
        </strong>
        <span>
          {entry.loaded
            ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
            : "Counting…"}
          {" · "}
          {latestRetrieval
            ? `last closed ${formatRelative(latestRetrieval.createdAt, now)}`
            : "never closed"}
        </span>
      </div>

      <footer>
        <Button onClick={onRetrieve} className="grow" disabled={!entry.loaded}>
          <ReceiptTextIcon />
          Close period
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
