import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIcon,
  CalendarRangeIcon,
  DownloadIcon,
  EllipsisIcon,
  PlusIcon,
  SquareIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  type Company,
  type Session,
  type Status,
  type Summary,
} from "./api";
import { payPeriodWindow, toDateInput } from "./pay-period";
import { registerTimeClockTools } from "./webmcp";

const EMPTY_STATUS: Status = {
  activeSession: null,
  serverTime: new Date().toISOString(),
};

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

function formatDate(value: string | Date, dateOnly = false): string {
  return new Intl.DateTimeFormat(
    undefined,
    dateOnly
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(new Date(value));
}

function monthRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  };
}

function CompanyMark({
  company,
  large = false,
}: {
  company: Company;
  large?: boolean;
}) {
  const initials = company.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={`company-mark ${large ? "company-mark--large" : ""}`}
      style={{ "--company-color": company.color ?? "#62e6a7" } as CSSProperties}
      aria-hidden="true"
    >
      {company.logoUrl ? <img src={company.logoUrl} alt="" /> : initials}
    </span>
  );
}

export function App() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [summary, setSummary] = useState<Summary>({
    from: null,
    to: null,
    companies: [],
  });
  const [now, setNow] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyFormOpen, setCompanyFormOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [reportCompanyId, setReportCompanyId] = useState("");
  const [reportOverrideStart, setReportOverrideStart] = useState("");
  const [reportTotal, setReportTotal] = useState(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const range = monthRange();
    const task = Promise.all([
      api<Company[]>("/api/v1/companies"),
      api<Session[]>("/api/v1/sessions?limit=100"),
      api<Status>("/api/v1/status"),
      api<Summary>(
        `/api/v1/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    ])
      .then(([nextCompanies, nextSessions, nextStatus, nextSummary]) => {
        setCompanies(nextCompanies);
        setSessions(nextSessions);
        setStatus(nextStatus);
        setSummary(nextSummary);
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

  useEffect(() => {
    if (!companies.length) return;
    if (!companies.some((company) => company.id === reportCompanyId))
      setReportCompanyId(companies[0].id);
  }, [companies, reportCompanyId]);

  const reportCompany =
    companies.find((company) => company.id === reportCompanyId) ?? null;
  const reportMinute = Math.floor(now / 60_000);
  const reportWindow = useMemo(
    () =>
      reportCompany
        ? payPeriodWindow(
            reportCompany,
            new Date(reportMinute * 60_000),
            reportOverrideStart || undefined,
          )
        : null,
    [reportCompany, reportOverrideStart, reportMinute],
  );

  useEffect(() => {
    if (!reportCompany || !reportWindow) return;
    const params = new URLSearchParams({
      from: reportWindow.start.toISOString(),
      to: reportWindow.end.toISOString(),
    });
    void api<Summary>(`/api/v1/summary?${params}`)
      .then((result) =>
        setReportTotal(
          result.companies.find((company) => company.id === reportCompany.id)
            ?.totalSeconds ?? 0,
        ),
      )
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to calculate the pay period.",
        ),
      );
  }, [reportCompany, reportWindow, sessions]);

  const activeSeconds = status.activeSession
    ? (now - new Date(status.activeSession.startedAt).getTime()) / 1000
    : 0;
  const monthTotal = useMemo(
    () =>
      summary.companies.reduce(
        (total, company) => total + company.totalSeconds,
        0,
      ),
    [summary],
  );

  async function start(company: Company) {
    try {
      setError(null);
      await api<Session>("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          companyId: company.id,
          startedAt: new Date().toISOString(),
        }),
      });
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to start the session.",
      );
    }
  }

  async function stop() {
    if (!status.activeSession) return;
    try {
      setError(null);
      await api(`/api/v1/sessions/${status.activeSession.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ endedAt: new Date().toISOString() }),
      });
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to stop the session.",
      );
    }
  }

  const exportUrl =
    reportCompany && reportWindow
      ? `/api/v1/export.csv?${new URLSearchParams({
          companyId: reportCompany.id,
          from: reportWindow.start.toISOString(),
          to: reportWindow.end.toISOString(),
        })}`
      : "/api/v1/export.csv";

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-switch" aria-hidden="true">
              <i />
            </span>
            <span>Time Switch</span>
          </div>
          <Badge
            variant="outline"
            className={
              connected
                ? "border-emerald-400/30 text-emerald-300"
                : "text-muted-foreground"
            }
          >
            {connected ? <WifiIcon /> : <WifiOffIcon />}
            {connected ? "Live" : "Reconnecting"}
          </Badge>
        </header>

        {error && (
          <Alert variant="destructive" className="mt-5 bg-destructive/5">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
              >
                <XIcon />
              </Button>
            </AlertAction>
          </Alert>
        )}

        <Card
          className={`status-panel ${status.activeSession ? "status-panel--active" : ""}`}
        >
          <CardContent className="status-copy p-0">
            <p className="eyebrow">Current state</p>
            {status.activeSession ? (
              <>
                <div className="active-company">
                  <CompanyMark company={status.activeSession.company} large />
                  <div>
                    <h1>{status.activeSession.company.name}</h1>
                    <p>Started {formatDate(status.activeSession.startedAt)}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="mt-7"
                  onClick={() => void stop()}
                >
                  <SquareIcon className="fill-red-400 text-red-400" />
                  Clock out
                </Button>
              </>
            ) : (
              <>
                <h1>Clocked out</h1>
                <p>Choose a company below or move the desk switch.</p>
              </>
            )}
          </CardContent>
          <div className="timer-block" aria-live="off">
            <span>{status.activeSession ? "Session time" : "This month"}</span>
            <strong>
              {status.activeSession
                ? formatClock(activeSeconds)
                : formatDuration(monthTotal)}
            </strong>
          </div>
        </Card>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Quick clock</p>
              <h2>Companies</h2>
            </div>
            <Button
              variant="ghost"
              className="text-emerald-300"
              onClick={() => {
                setEditingCompany(null);
                setCompanyFormOpen(true);
              }}
            >
              <PlusIcon />
              Add company
            </Button>
          </div>
          {loading ? (
            <div className="company-grid" aria-label="Loading companies">
              <Skeleton className="h-60" />
              <Skeleton className="h-60" />
            </div>
          ) : companies.length ? (
            <div className="company-grid">
              {companies.map((company) => {
                const total =
                  summary.companies.find((item) => item.id === company.id)
                    ?.totalSeconds ?? 0;
                const isActive = status.activeSession?.companyId === company.id;
                return (
                  <Card
                    className={
                      isActive
                        ? "company-card company-card--active"
                        : "company-card"
                    }
                    key={company.id}
                  >
                    <CardHeader>
                      <CompanyMark company={company} />
                      <CardAction>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${company.name}`}
                          onClick={() => {
                            setEditingCompany(company);
                            setCompanyFormOpen(true);
                          }}
                        >
                          <EllipsisIcon />
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="mt-auto">
                      <CardTitle>{company.name}</CardTitle>
                      <CardDescription>
                        {formatDuration(total)} this month
                      </CardDescription>
                    </CardContent>
                    <CardFooter>
                      <Button
                        className="w-full"
                        variant={isActive ? "default" : "outline"}
                        disabled={Boolean(status.activeSession) && !isActive}
                        onClick={() =>
                          isActive ? void stop() : void start(company)
                        }
                      >
                        {isActive
                          ? "Clock out"
                          : status.activeSession
                            ? "Another session is active"
                            : "Clock in"}
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Button
              variant="outline"
              className="empty-company"
              onClick={() => setCompanyFormOpen(true)}
            >
              <PlusIcon className="size-7 text-emerald-300" />
              <strong>Add your first company</strong>
              <span>Name it, then assign its ID to the desk switch.</span>
            </Button>
          )}
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Reporting</p>
              <h2>Pay period</h2>
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarRangeIcon className="size-4 text-emerald-300" />
                Hours ready to deliver
              </CardTitle>
              <CardDescription>
                Each company keeps its own cadence. Override the start for a
                one-off reporting window.
              </CardDescription>
            </CardHeader>
            <CardContent className="report-grid">
              <div className="field-stack">
                <Label htmlFor="report-company">Company</Label>
                <Select
                  value={reportCompanyId}
                  onValueChange={(value) => {
                    setReportCompanyId(value);
                    setReportOverrideStart("");
                  }}
                >
                  <SelectTrigger id="report-company" className="w-full">
                    <SelectValue placeholder="Choose a company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field-stack">
                <Label htmlFor="report-start">Override start</Label>
                <div className="flex gap-2">
                  <Input
                    id="report-start"
                    type="date"
                    value={reportOverrideStart}
                    onChange={(event) =>
                      setReportOverrideStart(event.target.value)
                    }
                  />
                  {reportOverrideStart && (
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setReportOverrideStart("")}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
              <div className="report-total">
                <span>
                  {reportCompany?.payPeriodCadence.replace(
                    "biweekly",
                    "every 2 weeks",
                  ) ?? "Current period"}
                </span>
                <strong>{formatDuration(reportTotal)}</strong>
              </div>
            </CardContent>
            {reportCompany && reportWindow && (
              <CardFooter className="report-footer">
                <span>
                  {formatDate(reportWindow.start, true)} –{" "}
                  {formatDate(new Date(reportWindow.end.getTime() - 1), true)}
                </span>
                <Button variant="outline" asChild>
                  <a href={exportUrl}>
                    <DownloadIcon />
                    Export period CSV
                  </a>
                </Button>
              </CardFooter>
            )}
          </Card>
        </section>

        <Separator className="mt-14" />
        <section className="section-block history-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ledger</p>
              <h2>Recent sessions</h2>
            </div>
            <Button variant="ghost" asChild>
              <a href="/api/v1/export.csv">
                <DownloadIcon />
                Export all
              </a>
            </Button>
          </div>
          <Card className="py-0">
            {sessions.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => {
                    const end = session.endedAt
                      ? new Date(session.endedAt).getTime()
                      : now;
                    const duration =
                      (end - new Date(session.startedAt).getTime()) / 1000;
                    return (
                      <TableRow key={session.id}>
                        <TableCell>
                          <div className="session-company">
                            <CompanyMark company={session.company} />
                            <strong>{session.company.name}</strong>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(session.startedAt)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={session.endedAt ? "secondary" : "outline"}
                            className={
                              session.endedAt
                                ? ""
                                : "border-emerald-400/30 text-emerald-300"
                            }
                          >
                            {session.endedAt ? "Complete" : "Active"}
                          </Badge>
                        </TableCell>
                        <TableCell className="session-duration">
                          {formatDuration(duration)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="empty-history">
                <ActivityIcon />
                Completed work sessions will appear here.
              </div>
            )}
          </Card>
        </section>

        <CompanyDialog
          open={companyFormOpen}
          company={editingCompany}
          onOpenChange={setCompanyFormOpen}
          onSaved={async () => {
            setCompanyFormOpen(false);
            await refresh();
          }}
          onError={setError}
        />
      </main>
    </div>
  );
}

function CompanyDialog({
  open,
  company,
  onOpenChange,
  onSaved,
  onError,
}: {
  open: boolean;
  company: Company | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cadence, setCadence] = useState<Company["payPeriodCadence"]>(
    company?.payPeriodCadence ?? "biweekly",
  );
  const [anchor, setAnchor] = useState(
    company?.payPeriodAnchorDate ?? toDateInput(new Date()),
  );

  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setCopied(false);
    setCadence(company?.payPeriodCadence ?? "biweekly");
    setAnchor(company?.payPeriodAnchorDate ?? toDateInput(new Date()));
  }, [company, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      await api(
        company ? `/api/v1/companies/${company.id}` : "/api/v1/companies",
        {
          method: company ? "PATCH" : "POST",
          body: JSON.stringify({
            name: form.get("name"),
            logoUrl: form.get("logoUrl"),
            color: form.get("color"),
            payPeriodCadence: cadence,
            payPeriodAnchorDate: anchor,
          }),
        },
      );
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to save the company.",
      );
      setSaving(false);
    }
  }

  async function archive() {
    if (!company) return;
    setSaving(true);
    try {
      await api(`/api/v1/companies/${company.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Unable to archive the company.",
      );
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{company ? "Edit company" : "New company"}</DialogTitle>
          <DialogDescription>
            Company identity and its default pay-period schedule.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-5">
          {company && (
            <div className="field-stack">
              <Label htmlFor="company-id">Device company ID</Label>
              <div className="flex gap-2">
                <Input
                  id="company-id"
                  value={company.id}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    if (!navigator.clipboard) {
                      onError(
                        "Select and copy the company ID manually on this non-HTTPS preview.",
                      );
                      return;
                    }
                    void navigator.clipboard
                      .writeText(company.id)
                      .then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy ID"}
                </Button>
              </div>
            </div>
          )}
          <div className="field-stack">
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              name="name"
              defaultValue={company?.name}
              maxLength={100}
              required
              autoFocus
            />
          </div>
          <div className="field-stack">
            <Label htmlFor="company-logo">
              Logo URL{" "}
              <span className="font-normal text-muted-foreground">
                optional HTTPS image
              </span>
            </Label>
            <Input
              id="company-logo"
              name="logoUrl"
              type="url"
              defaultValue={company?.logoUrl ?? ""}
              placeholder="https://…"
            />
          </div>
          <div className="dialog-fields">
            <div className="field-stack">
              <Label htmlFor="company-cadence">Pay cadence</Label>
              <Select
                value={cadence}
                onValueChange={(value) =>
                  setCadence(value as Company["payPeriodCadence"])
                }
              >
                <SelectTrigger id="company-cadence" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="semimonthly">Twice monthly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="field-stack">
              <Label htmlFor="company-anchor">Period start / anchor</Label>
              <Input
                id="company-anchor"
                type="date"
                value={anchor}
                onChange={(event) => setAnchor(event.target.value)}
                required
              />
            </div>
          </div>
          <div className="field-stack">
            <Label htmlFor="company-color">Accent color</Label>
            <Input
              id="company-color"
              name="color"
              type="color"
              className="h-10 w-20 p-1"
              defaultValue={company?.color ?? "#62e6a7"}
            />
          </div>
          <DialogFooter className="mt-2">
            {company && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    type="button"
                    className="sm:mr-auto"
                  >
                    Archive
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive {company.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its existing sessions remain in reports, but no new
                      sessions can be started.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void archive()}
                    >
                      Archive company
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
