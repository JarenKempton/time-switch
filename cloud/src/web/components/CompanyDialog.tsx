import { type FormEvent, useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeClock, type Company } from "../api";
import {
  cadenceLabels,
  payPeriodWindow,
  toDateInput,
} from "../../lib/pay-period";
import { formatRange } from "../format";
import { DEFAULT_COMPANY_COLOR } from "./CompanyMark";
import type { PayPeriodCadence } from "../../db/schema";

const CADENCES = Object.keys(cadenceLabels) as PayPeriodCadence[];

export function CompanyDialog({
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
  const [cadence, setCadence] = useState<PayPeriodCadence>(
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

  const preview =
    /^\d{4}-\d{2}-\d{2}$/.test(anchor) &&
    payPeriodWindow(
      { payPeriodCadence: cadence, payPeriodAnchorDate: anchor, createdAt: "" },
      new Date(),
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const body = {
        name: form.get("name"),
        logoUrl: form.get("logoUrl"),
        color: form.get("color"),
        payPeriodCadence: cadence,
        payPeriodAnchorDate: anchor,
      };
      if (company) await timeClock.updateCompany(company.id, body);
      else await timeClock.createCompany(body);
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to save the company.",
      );
      setSaving(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!company) return;
    setSaving(true);
    try {
      await timeClock.updateCompany(company.id, { archived });
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Unable to update the company.",
      );
      setSaving(false);
    }
  }

  function copyId() {
    if (!company) return;
    if (!navigator.clipboard) {
      onError("Select and copy the company ID manually on this HTTP preview.");
      return;
    }
    void navigator.clipboard.writeText(company.id).then(() => setCopied(true));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{company ? "Edit company" : "New company"}</DialogTitle>
          <DialogDescription>
            How the company appears and when its pay periods roll over.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
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
              <Label htmlFor="company-color">Color</Label>
              <Input
                id="company-color"
                name="color"
                type="color"
                className="h-8 w-16 p-1"
                defaultValue={company?.color ?? DEFAULT_COMPANY_COLOR}
              />
            </div>
          </div>
          <div className="field-stack">
            <Label htmlFor="company-logo">
              Logo URL
              <span className="ml-1 font-normal text-muted-foreground">
                optional, HTTPS
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

          <fieldset className="rounded-lg border border-border p-4">
            <legend className="px-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Pay period
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-stack">
                <Label htmlFor="company-cadence">Cadence</Label>
                <Select
                  value={cadence}
                  onValueChange={(value) =>
                    setCadence(value as PayPeriodCadence)
                  }
                >
                  <SelectTrigger id="company-cadence" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CADENCES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {cadenceLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field-stack">
                <Label htmlFor="company-anchor">
                  {cadence === "semimonthly"
                    ? "Anchor (1st and 16th)"
                    : "A period start date"}
                </Label>
                <Input
                  id="company-anchor"
                  type="date"
                  value={anchor}
                  onChange={(event) => setAnchor(event.target.value)}
                  disabled={cadence === "semimonthly"}
                  required
                />
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {cadence === "semimonthly"
                ? "Periods always run the 1st–15th and 16th–end of month."
                : preview
                  ? `Current period would be ${formatRange(preview.start, preview.end)}.`
                  : "Pick any date a period started on; the schedule repeats from there."}
            </p>
          </fieldset>

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
                <Button variant="outline" type="button" onClick={copyId}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste into the desk switch console as left_company_id or
                right_company_id.
              </p>
            </div>
          )}

          <DialogFooter className="mt-1">
            {company && !company.archived && (
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
                      Its history stays in reports, but you cannot clock into it
                      until you restore it.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void setArchived(true)}
                    >
                      Archive company
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {company?.archived && (
              <Button
                variant="secondary"
                type="button"
                className="sm:mr-auto"
                disabled={saving}
                onClick={() => void setArchived(false)}
              >
                Restore
              </Button>
            )}
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : company ? "Save changes" : "Add company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
