import { useEffect, useRef, useState } from "react";
import { Trash2Icon, UploadIcon, XIcon } from "lucide-react";
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
import { Label } from "@/web/components/ui/label";
import { timeClock, type LogoObject } from "../api";

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Picks a company logo from the R2 bucket. Uploads go straight to
 * /api/v1/logos and the chosen object's same-origin path becomes the
 * company's logoUrl.
 */
export function LogoPicker({
  value,
  onChange,
  onError,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  onError: (message: string) => void;
}) {
  const [logos, setLogos] = useState<LogoObject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      setLogos(await timeClock.logos());
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Unable to load logos.");
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const stored = await timeClock.uploadLogo(file);
      onChange(stored.url);
      await reload();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(logo: LogoObject) {
    setBusy(true);
    try {
      await timeClock.deleteLogo(logo.key);
      if (value === logo.url) onChange(null);
      await reload();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field-stack">
      <Label>
        Logo
        <span className="ml-1 font-normal text-muted-foreground">
          optional, stored in R2
        </span>
      </Label>
      <div className="logo-picker">
        <button
          type="button"
          className={`logo-tile logo-tile--none ${value ? "" : "logo-tile--selected"}`}
          onClick={() => onChange(null)}
          aria-pressed={!value}
          title="No logo, use the color dot"
        >
          <XIcon />
          <span>None</span>
        </button>
        {(logos ?? []).map((logo) => (
          <div
            key={logo.key}
            className={`logo-tile ${value === logo.url ? "logo-tile--selected" : ""}`}
          >
            <button
              type="button"
              className="logo-tile-select"
              onClick={() => onChange(logo.url)}
              aria-pressed={value === logo.url}
              title={`${logo.key} · ${formatSize(logo.size)}`}
            >
              <img src={logo.url} alt="" />
            </button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="logo-tile-delete"
                  aria-label={`Delete ${logo.key}`}
                  disabled={busy}
                >
                  <Trash2Icon />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete this logo from storage?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {logo.key} ({formatSize(logo.size)}) is removed from the R2
                    bucket. Any company using it loses its logo, and this cannot
                    be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void remove(logo)}
                  >
                    Delete logo
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))}
        <button
          type="button"
          className="logo-tile logo-tile--upload"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
          <span>{busy ? "Working…" : "Upload"}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(event) => void upload(event.target.files?.[0])}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        PNG, JPEG, WebP, or SVG up to 1 MB.
        {logos && logos.length === 0 ? " The bucket is empty so far." : ""}
      </p>
    </div>
  );
}
