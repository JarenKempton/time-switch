import { type FormEvent, useEffect, useState } from "react";
import { Trash2Icon } from "lucide-react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Textarea } from "@/web/components/ui/textarea";
import { timeClock, type Company, type Session } from "../api";

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

/** Corrects a ledger entry: company, start, end, and note — or removes it. */
export function SessionDialog({
  session,
  companies,
  onOpenChange,
  onSaved,
  onDeleted,
  onError,
}: {
  session: Session | null;
  companies: Company[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const open = session !== null;
  const [companyId, setCompanyId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCompanyId(session?.companyId ?? "");
    setSaving(false);
  }, [open, session]);

  async function remove() {
    if (!session) return;
    setSaving(true);
    try {
      await timeClock.deleteSession(session.id);
      await onDeleted();
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Unable to delete the session.",
      );
      setSaving(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const form = new FormData(event.currentTarget);
    const startedAt = fromLocalInput(String(form.get("startedAt") ?? ""));
    const endedAt = fromLocalInput(String(form.get("endedAt") ?? ""));
    if (!startedAt) {
      onError("A start time is required.");
      return;
    }
    setSaving(true);
    try {
      await timeClock.updateSession(session.id, {
        companyId,
        startedAt,
        endedAt,
        note: String(form.get("note") ?? "").trim() || null,
      });
      await onSaved();
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Unable to save the session.",
      );
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
          <DialogDescription>
            Fix a missed switch flip or add a note. Leave the end empty to keep
            the session running.
          </DialogDescription>
        </DialogHeader>
        {session && (
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <div className="field-stack">
              <Label htmlFor="session-company">Company</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger id="session-company" className="w-full">
                  <SelectValue />
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-stack">
                <Label htmlFor="session-start">Started</Label>
                <Input
                  id="session-start"
                  name="startedAt"
                  type="datetime-local"
                  defaultValue={toLocalInput(session.startedAt)}
                  required
                />
              </div>
              <div className="field-stack">
                <Label htmlFor="session-end">Ended</Label>
                <Input
                  id="session-end"
                  name="endedAt"
                  type="datetime-local"
                  defaultValue={toLocalInput(session.endedAt)}
                />
              </div>
            </div>
            <div className="field-stack">
              <Label htmlFor="session-note">Note</Label>
              <Textarea
                id="session-note"
                name="note"
                defaultValue={session.note ?? ""}
                rows={2}
                maxLength={500}
              />
            </div>
            <DialogFooter className="sm:justify-between">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    type="button"
                    className="text-destructive hover:text-destructive"
                    disabled={saving}
                  >
                    <Trash2Icon />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this session?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The entry leaves the ledger for good. Hours already
                      retrieved keep the total they were given, so undo and redo
                      that retrieval if this session fell inside a closed pay
                      period.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void remove()}>
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save session"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
