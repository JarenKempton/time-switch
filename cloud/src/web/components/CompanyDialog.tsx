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
} from "@/web/components/ui/alert-dialog";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { timeClock, type Company } from "../api";
import { DEFAULT_COMPANY_COLOR } from "./CompanyMark";
import { LogoPicker } from "./LogoPicker";

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
  const [logoUrl, setLogoUrl] = useState<string | null>(
    company?.logoUrl ?? null,
  );

  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setCopied(false);
    setLogoUrl(company?.logoUrl ?? null);
  }, [company, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const body = {
        name: form.get("name"),
        logoUrl,
        color: form.get("color"),
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
          <LogoPicker value={logoUrl} onChange={setLogoUrl} onError={onError} />

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
