import { useEffect, useMemo, useState } from "react";
import {
  CpuIcon,
  LoaderCircleIcon,
  PlusIcon,
  UsbIcon,
  WifiIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/web/components/ui/alert";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { timeClock, type Device } from "../api";
import {
  installAndConfigureDevice,
  supportsBrowserInstaller,
  type InstallProgress,
} from "../device-installer";
import type { TimeClockData } from "../use-time-clock";

const ONLINE_WINDOW_MS = 90_000;

function deviceState(device: Device, now: number) {
  if (device.revokedAt)
    return { label: "Revoked", variant: "destructive" as const };
  if (!device.provisionedAt)
    return { label: "Setup incomplete", variant: "outline" as const };
  if (
    device.lastSeenAt &&
    now - new Date(device.lastSeenAt).getTime() < ONLINE_WINDOW_MS
  )
    return { label: "Online", variant: "default" as const };
  return { label: "Offline", variant: "secondary" as const };
}

async function waitForCheckIn(
  deviceId: string,
  onAttempt: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const devices = await timeClock.devices();
    if (devices.find((device) => device.id === deviceId)?.lastSeenAt) return;
    await onAttempt();
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  throw new Error(
    "Firmware was installed, but the device has not checked in. Verify the Wi-Fi details and try setup again.",
  );
}

export function Devices({ data }: { data: TimeClockData }) {
  const companies = data.activeCompanies;
  const [showSetup, setShowSetup] = useState(false);
  const [name, setName] = useState("Desk panel");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [leftCompanyId, setLeftCompanyId] = useState("");
  const [rightCompanyId, setRightCompanyId] = useState("");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const supported = useMemo(() => supportsBrowserInstaller(), []);

  useEffect(() => {
    if (!leftCompanyId && companies[0]) setLeftCompanyId(companies[0].id);
    if (!rightCompanyId && companies[1]) setRightCompanyId(companies[1].id);
  }, [companies, leftCompanyId, rightCompanyId]);

  async function install() {
    setSetupError(null);
    const ssidBytes = new TextEncoder().encode(wifiSsid.trim()).length;
    const passwordBytes = new TextEncoder().encode(wifiPassword).length;
    if (!name.trim()) return setSetupError("Give the device a name.");
    if (ssidBytes < 1 || ssidBytes > 32)
      return setSetupError("The Wi-Fi network name must be 1–32 bytes.");
    if (passwordBytes < 8 || passwordBytes > 63)
      return setSetupError("The Wi-Fi password must be 8–63 bytes.");
    if (!leftCompanyId || !rightCompanyId)
      return setSetupError("Choose a company for both switch positions.");
    if (leftCompanyId === rightCompanyId)
      return setSetupError("Choose a different company for each position.");

    setRunning(true);
    try {
      const result = await installAndConfigureDevice(async () => {
        const registration = await timeClock.createDevice(name.trim());
        return {
          apiUrl: window.location.origin,
          deviceId: registration.device.id,
          setupToken: registration.setupToken,
          wifiSsid: wifiSsid.trim(),
          wifiPassword,
          leftCompanyId,
          rightCompanyId,
        };
      }, setProgress);
      setProgress({
        phase: "configuring",
        percent: 100,
        detail: "Waiting for the first secure check-in…",
      });
      await waitForCheckIn(result.deviceId, data.refresh);
      await data.refresh();
      setShowSetup(false);
      setProgress(null);
      setWifiPassword("");
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Device setup did not finish.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="section section--first devices-view">
      <div className="section-heading">
        <div>
          <h2>Devices</h2>
          <p className="section-subtitle">
            Install, configure, and monitor controllers from one place.
          </p>
        </div>
        <Button onClick={() => setShowSetup(true)} disabled={running}>
          <PlusIcon />
          Add device
        </Button>
      </div>

      <Dialog
        open={showSetup}
        onOpenChange={(open) => {
          if (running) return;
          setShowSetup(open);
          if (!open) {
            setProgress(null);
            setSetupError(null);
            setWifiPassword("");
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
          showCloseButton={!running}
          onEscapeKeyDown={(event) => running && event.preventDefault()}
          onPointerDownOutside={(event) => running && event.preventDefault()}
        >
          <DialogHeader className="pr-10">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Set up a controller</DialogTitle>
              <Badge variant={supported ? "outline" : "destructive"}>
                <UsbIcon data-icon="inline-start" />
                {supported ? "USB ready" : "Unsupported browser"}
              </Badge>
            </div>
            <DialogDescription>
              Connect the ESP32 with USB. Wi-Fi credentials go directly from
              this browser to the device.
            </DialogDescription>
          </DialogHeader>
          <div className="device-setup-content">
            {!supported && (
              <Alert variant="destructive">
                <AlertDescription>
                  Open this page in desktop Chrome or Edge to install hardware.
                  Device status remains available on mobile and Safari.
                </AlertDescription>
              </Alert>
            )}

            <div className="device-form-grid">
              <div className="field-stack device-name-field">
                <Label htmlFor="device-name">Device name</Label>
                <Input
                  id="device-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={running}
                />
              </div>
              <div className="field-stack">
                <Label htmlFor="wifi-ssid">Wi-Fi network</Label>
                <Input
                  id="wifi-ssid"
                  value={wifiSsid}
                  onChange={(event) => setWifiSsid(event.target.value)}
                  autoComplete="off"
                  disabled={running}
                />
              </div>
              <div className="field-stack">
                <Label htmlFor="wifi-password">Wi-Fi password</Label>
                <Input
                  id="wifi-password"
                  type="password"
                  value={wifiPassword}
                  onChange={(event) => setWifiPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={running}
                />
              </div>
              <div className="field-stack">
                <Label>Left position</Label>
                <Select
                  value={leftCompanyId}
                  onValueChange={setLeftCompanyId}
                  disabled={running}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose company" />
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
                <Label>Right position</Label>
                <Select
                  value={rightCompanyId}
                  onValueChange={setRightCompanyId}
                  disabled={running}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose company" />
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
            </div>

            {progress && (
              <div className="install-progress" aria-live="polite">
                <div className="install-progress-heading">
                  <span>{progress.detail}</span>
                  <span className="tabular">{progress.percent}%</span>
                </div>
                <div className="install-progress-track" aria-hidden="true">
                  <span style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
            {setupError && (
              <Alert variant="destructive">
                <AlertDescription>{setupError}</AlertDescription>
              </Alert>
            )}
            <div className="device-setup-actions">
              <span>
                Installing firmware erases the controller’s previous
                configuration.
              </span>
              <Button
                onClick={() => void install()}
                disabled={!supported || running || companies.length < 2}
              >
                {running ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <CpuIcon />
                )}
                {running ? "Setting up…" : "Install and configure"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="device-list" aria-live="polite">
        {data.devices.length ? (
          data.devices.map((device) => {
            const state = deviceState(device, data.now);
            return (
              <Card key={device.id} size="sm" className="device-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CpuIcon className="size-4" />
                    {device.name}
                  </CardTitle>
                  <CardDescription>
                    {device.firmwareVersion
                      ? `Firmware ${device.firmwareVersion}`
                      : "Not provisioned"}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={state.variant}>{state.label}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="device-meta">
                  <span>
                    <WifiIcon />
                    Last seen
                  </span>
                  <strong>
                    {device.lastSeenAt
                      ? new Date(device.lastSeenAt).toLocaleString()
                      : "Never"}
                  </strong>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="empty-panel">
            <UsbIcon />
            <strong>No devices yet</strong>
            <p>Connect a controller to install and configure it.</p>
          </div>
        )}
      </div>
    </section>
  );
}
