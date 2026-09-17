import { useCallback, useEffect, useState } from "react";
import { AlertTriangleIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/web/components/ui/alert";
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
import { Skeleton } from "@/web/components/ui/skeleton";
import { timeClock, type PurgeResult } from "../api";
import { formatDuration, formatHours, formatRange } from "../format";

/**
 * Clears the stray one- and two-second entries a latching switch collects on
 * the way past the middle position. The preview is a real dry run against the
 * whole ledger, so the count and the closed-period warnings are what the purge
 * will actually do.
 */
export function PurgeSessionsDialog({
  open,
  onOpenChange,
  onPurged,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPurged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [seconds, setSeconds] = useState("60");
  const [preview, setPreview] = useState<PurgeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [purging, setPurging] = useState(false);

  const cutoff = Number.parseInt(seconds, 10);
  const valid = Number.isFinite(cutoff) && cutoff > 0 && cutoff <= 86_400;

  const loadPreview = useCallback(
    async (maxDurationSeconds: number) => {
      setLoading(true);
      try {
        setPreview(
          await timeClock.purgeSessions({ maxDurationSeconds, dryRun: true }),
        );
      } catch (cause) {
        setPreview(null);
        onError(
          cause instanceof Error
            ? cause.message
            : "Unable to preview the purge.",
        );
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPurging(false);
      return;
    }
    if (!valid) return;
    const timer = window.setTimeout(() => void loadPreview(cutoff), 250);
    return () => window.clearTimeout(timer);
  }, [open, cutoff, valid, loadPreview]);

  async function purge() {
    if (!valid) return;
    setPurging(true);
    try {
      const result = await timeClock.purgeSessions({
        maxDurationSeconds: cutoff,
        dryRun: false,
      });
      await onPurged();
      onOpenChange(false);
      if (result.affectedRetrievals.length) {
        onError(
          `Purged ${result.purgedCount} sessions. ${result.affectedRetrievals.length} retrieved pay ` +
            `period${result.affectedRetrievals.length === 1 ? "" : "s"} still store the older total — undo and redo ` +
            `${result.affectedRetrievals.length === 1 ? "it" : "them"} to bring the figures back in line.`,
        );
      }
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to purge sessions.",
      );
      setPurging(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Purge short sessions</DialogTitle>
          <DialogDescription>
            Removes every finished session shorter than the cutoff, across all
            companies and all time. A running session is never purged.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="field-stack">
            <Label htmlFor="purge-seconds">Shorter than (seconds)</Label>
            <Input
              id="purge-seconds"
              type="number"
              min={1}
              max={86400}
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
            />
          </div>

          {loading || !preview ? (
            <Skeleton className="h-16 w-full" />
          ) : preview.purgedCount === 0 ? (
            <p className="empty">
              No finished session is shorter than {preview.maxDurationSeconds}s.
            </p>
          ) : (
            <div className="grid gap-3">
              <div className="stat-row">
                <div className="stat">
                  <span>Sessions</span>
                  <strong className="tabular">{preview.purgedCount}</strong>
                </div>
                <div className="stat">
                  <span>Time removed</span>
                  <strong className="tabular">
                    {formatDuration(preview.purgedSeconds)}
                  </strong>
                </div>
              </div>
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {preview.byCompany.map((company) => (
                  <li key={company.companyId} className="flex justify-between">
                    <span>{company.name}</span>
                    <span className="tabular">
                      {company.count} · {formatDuration(company.totalSeconds)}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.affectedRetrievals.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangleIcon />
                  <AlertTitle>
                    {preview.affectedRetrievals.length} retrieved pay period
                    {preview.affectedRetrievals.length === 1 ? "" : "s"} will
                    disagree
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      Retrieved hours keep the total they were given, so these
                      stored figures will read high. Undo and redo each
                      retrieval to bring it back in line.
                    </p>
                    <ul className="grid gap-1">
                      {preview.affectedRetrievals.map((retrieval) => (
                        <li key={retrieval.id}>
                          {retrieval.companyName},{" "}
                          {formatRange(
                            retrieval.periodStart,
                            retrieval.periodEnd,
                          )}{" "}
                          — {formatHours(retrieval.totalSeconds)} h stored,{" "}
                          {formatDuration(retrieval.staleSeconds)} of it purged
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            disabled={!valid || loading || purging || !preview?.purgedCount}
            onClick={() => void purge()}
          >
            <Trash2Icon />
            {purging
              ? "Purging…"
              : `Purge ${preview?.purgedCount ?? 0} session${preview?.purgedCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
