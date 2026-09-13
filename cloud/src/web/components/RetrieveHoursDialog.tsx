import { useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  dateOnly,
  nextPeriodOptions,
  payPeriodWindow,
  toDateInput,
  type NextPeriodChoice,
} from "../../lib/pay-period";
import { timeClock, type CompanyHours } from "../api";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatHours,
} from "../format";
import type { CompanyPeriod } from "../use-periods";
import { CompanyMark } from "./CompanyMark";

type EndChoice = "now" | "period_start";

/**
 * Closes out a company's open hours. The user picks how far to retrieve and
 * when the following period should end; the server records both and computes
 * the authoritative total.
 */
export function RetrieveHoursDialog({
  entry,
  onOpenChange,
  onSaved,
  onError,
}: {
  entry: CompanyPeriod | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const open = entry !== null;
  const [endChoice, setEndChoice] = useState<EndChoice>("now");
  const [nextChoice, setNextChoice] =
    useState<NextPeriodChoice>("next_boundary");
  const [customEnd, setCustomEnd] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<CompanyHours | null>(null);

  const company = entry?.company ?? null;
  const period = entry?.period ?? null;
  const hasBacklog = Boolean(period?.unretrievedSince);

  useEffect(() => {
    if (!open) return;
    setEndChoice("now");
    setNextChoice("next_boundary");
    setCustomEnd("");
    setNote("");
    setSaving(false);
    setPreview(null);
  }, [open, entry?.company.id]);

  const periodStart = useMemo(
    () => (period ? (period.unretrievedSince ?? period.start) : new Date()),
    [period],
  );
  const now = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const periodEnd = endChoice === "period_start" && period ? period.start : now;

  const options = useMemo(
    () => (company ? nextPeriodOptions(company, now) : []),
    [company, now],
  );
  const selected = options.find((option) => option.key === nextChoice);

  const nextPeriodEnd: Date | null = (() => {
    if (!company || !period) return null;
    if (endChoice === "period_start") return period.end;
    if (nextChoice === "custom")
      return /^\d{4}-\d{2}-\d{2}$/.test(customEnd) ? dateOnly(customEnd) : null;
    return selected?.end ?? null;
  })();

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    void timeClock
      .companyHours(company.id, periodStart, periodEnd)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [company, periodStart, periodEnd]);

  async function submit() {
    if (!company || !nextPeriodEnd) return;
    if (nextPeriodEnd <= periodEnd) {
      onError("The next period has to end after this retrieval.");
      return;
    }
    setSaving(true);
    try {
      await timeClock.createRetrieval(company.id, {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        nextPeriodEnd: nextPeriodEnd.toISOString(),
        note: note.trim() || null,
        ...(endChoice === "now" && selected?.reanchor
          ? { reanchorDate: toDateInput(now) }
          : {}),
      });
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to record the hours.",
      );
      setSaving(false);
    }
  }

  const exportUrl = company
    ? timeClock.exportUrl({
        companyId: company.id,
        from: periodStart.toISOString(),
        to: periodEnd.toISOString(),
      })
    : "#";

  const regularAfterBacklog =
    company && period && endChoice === "period_start"
      ? payPeriodWindow(company, period.start)
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {company && period && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CompanyMark company={company} size="sm" />
                Get hours for {company.name}
              </DialogTitle>
              <DialogDescription>
                Records what you are invoicing and sets when the next period
                ends.
              </DialogDescription>
            </DialogHeader>

            <div className="retrieve-summary">
              <div>
                <span className="eyebrow">Retrieving</span>
                <strong>
                  {formatDate(periodStart, true)} →{" "}
                  {endChoice === "now" ? "now" : formatDate(periodEnd, true)}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {preview
                    ? `${preview.sessionCount} session${preview.sessionCount === 1 ? "" : "s"}`
                    : "Counting…"}
                </span>
              </div>
              <div className="text-right">
                <span className="eyebrow">Total</span>
                <strong className="tabular">
                  {preview ? formatHours(preview.totalSeconds) : "—"}
                  <small> h</small>
                </strong>
                <span className="text-sm text-muted-foreground">
                  {preview ? formatDuration(preview.totalSeconds) : ""}
                </span>
              </div>
            </div>

            {hasBacklog && (
              <div className="field-stack">
                <Label>How far to retrieve</Label>
                <RadioGroup
                  value={endChoice}
                  onValueChange={(value) => setEndChoice(value as EndChoice)}
                  className="gap-2"
                >
                  <label className="choice">
                    <RadioGroupItem value="period_start" />
                    <span>
                      <strong>
                        Through {formatDate(period.start, true)} only
                      </strong>
                      <small>
                        Close the previous period. The current one keeps running
                        as scheduled.
                      </small>
                    </span>
                  </label>
                  <label className="choice">
                    <RadioGroupItem value="now" />
                    <span>
                      <strong>Everything up to now</strong>
                      <small>Include the current period so far.</small>
                    </span>
                  </label>
                </RadioGroup>
              </div>
            )}

            {endChoice === "now" ? (
              <div className="field-stack">
                <Label>Next period</Label>
                <RadioGroup
                  value={nextChoice}
                  onValueChange={(value) =>
                    setNextChoice(value as NextPeriodChoice)
                  }
                  className="gap-2"
                >
                  {options.map((option) => (
                    <label className="choice" key={option.key}>
                      <RadioGroupItem value={option.key} />
                      <span>
                        <strong>{option.label}</strong>
                        <small>
                          {option.end
                            ? `Ends ${formatDate(new Date(option.end.getTime() - 1), true)}. `
                            : ""}
                          {option.detail}
                        </small>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                {nextChoice === "custom" && (
                  <Input
                    type="date"
                    className="mt-1 sm:w-56"
                    value={customEnd}
                    min={toDateInput(new Date(now.getTime() + 86_400_000))}
                    onChange={(event) => setCustomEnd(event.target.value)}
                    aria-label="Next period end date"
                  />
                )}
              </div>
            ) : (
              regularAfterBacklog && (
                <p className="text-sm text-muted-foreground">
                  The current period stays {formatDate(period.start, true)} –{" "}
                  {formatDate(new Date(period.end.getTime() - 1), true)}.
                </p>
              )
            )}

            <div className="field-stack">
              <Label htmlFor="retrieve-note">
                Note
                <span className="ml-1 font-normal text-muted-foreground">
                  optional
                </span>
              </Label>
              <Textarea
                id="retrieve-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Invoice #, who you sent it to…"
                rows={2}
                maxLength={500}
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" asChild className="sm:mr-auto">
                <a href={exportUrl}>
                  <DownloadIcon />
                  Export CSV
                </a>
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={saving || !nextPeriodEnd || !preview}
              >
                {saving
                  ? "Recording…"
                  : `Record ${preview ? formatHours(preview.totalSeconds) : ""} h`}
              </Button>
            </DialogFooter>
            <p className="text-xs text-muted-foreground">
              Retrieval time is {formatDateTime(now)}. Sessions after this
              moment count toward the next period.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
