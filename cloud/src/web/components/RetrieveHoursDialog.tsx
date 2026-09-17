import { useEffect, useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";
import { Textarea } from "@/web/components/ui/textarea";
import { timeClock, type CompanyHours } from "../api";
import { formatDateTime, formatDuration, formatHours } from "../format";
import type { CompanyPeriod } from "../use-periods";
import { CompanyMark } from "./CompanyMark";

type EndChoice = "now" | "custom";

function toLocalInput(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * Closes a company's open pay period. The period always starts where the
 * previous one ended; the user only picks where this one stops, and the
 * server records the authoritative total.
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
  const [customEnd, setCustomEnd] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<CompanyHours | null>(null);

  const company = entry?.company ?? null;
  const periodStart = entry?.start ?? null;
  const now = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setEndChoice("now");
    setCustomEnd(toLocalInput(now));
    setNote("");
    setSaving(false);
    setPreview(null);
  }, [open, entry?.company.id, now]);

  const periodEnd: Date | null = (() => {
    if (endChoice === "now") return now;
    const parsed = new Date(customEnd);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  })();
  const endProblem =
    !periodEnd || !periodStart
      ? null
      : periodEnd > now
        ? "A pay period cannot end in the future."
        : periodEnd <= periodStart
          ? "The end has to come after the period start."
          : null;

  useEffect(() => {
    if (!company || !periodStart || !periodEnd || endProblem) {
      setPreview(null);
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, periodStart?.getTime(), periodEnd?.getTime(), endProblem]);

  async function submit() {
    if (!company || !periodEnd || endProblem) return;
    setSaving(true);
    try {
      await timeClock.createRetrieval(company.id, {
        periodEnd: periodEnd.toISOString(),
        note: note.trim() || null,
      });
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to record the hours.",
      );
      setSaving(false);
    }
  }

  const exportUrl =
    company && periodStart && periodEnd
      ? timeClock.exportUrl({
          companyId: company.id,
          from: periodStart.toISOString(),
          to: periodEnd.toISOString(),
        })
      : "#";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {company && periodStart && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CompanyMark company={company} size="sm" />
                Close pay period for {company.name}
              </DialogTitle>
              <DialogDescription>
                Records the hours since the last close. The next period starts
                right where this one ends.
              </DialogDescription>
            </DialogHeader>

            <div className="retrieve-summary">
              <div>
                <span className="eyebrow">Period</span>
                <strong>
                  {formatDateTime(periodStart)} →{" "}
                  {endChoice === "now" || !periodEnd
                    ? "now"
                    : formatDateTime(periodEnd)}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {endProblem
                    ? endProblem
                    : preview
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

            <div className="field-stack">
              <Label>Close the period at</Label>
              <RadioGroup
                value={endChoice}
                onValueChange={(value) => setEndChoice(value as EndChoice)}
                className="gap-2"
              >
                <label className="choice">
                  <RadioGroupItem value="now" />
                  <strong>Right now</strong>
                  <small>
                    Everything up to {formatDateTime(now)}. Anything after
                    counts toward the next period.
                  </small>
                </label>
                <label className="choice">
                  <RadioGroupItem value="custom" />
                  <strong>A specific time</strong>
                  <small>
                    Use this when the cutoff already passed, e.g. midnight last
                    night.
                  </small>
                </label>
              </RadioGroup>
              {endChoice === "custom" && (
                <Input
                  type="datetime-local"
                  className="mt-1 sm:w-64"
                  value={customEnd}
                  max={toLocalInput(now)}
                  onChange={(event) => setCustomEnd(event.target.value)}
                  aria-label="Period end"
                />
              )}
            </div>

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
                disabled={saving || Boolean(endProblem) || !preview}
              >
                {saving
                  ? "Recording…"
                  : `Close at ${preview ? formatHours(preview.totalSeconds) : ""} h`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
