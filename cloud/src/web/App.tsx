import { XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatClock } from "./format";
import { navigate, useRoute, type Route } from "./router";
import { usePeriods } from "./use-periods";
import { useTimeClock } from "./use-time-clock";
import { Dashboard } from "./views/Dashboard";
import { History } from "./views/History";
import { Settings } from "./views/Settings";

const NAV: Array<{ route: Route; label: string }> = [
  { route: "dashboard", label: "Dashboard" },
  { route: "history", label: "History" },
  { route: "settings", label: "Settings" },
];

export function App() {
  const data = useTimeClock();
  const route = useRoute();
  const periods = usePeriods(
    data.activeCompanies,
    data.latestRetrievalByCompany,
    data.status,
    data.now,
    data.sessions,
  );
  const active = data.status.activeSession;

  return (
    <div className="dark app">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => navigate("dashboard")}
        >
          Time Switch
        </button>
        <nav className="nav" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.route}
              type="button"
              className={item.route === route ? "is-current" : ""}
              aria-current={item.route === route ? "page" : undefined}
              onClick={() => navigate(item.route)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="topbar-status">
          {active && route !== "dashboard" && (
            <button
              type="button"
              className="mini-timer tabular"
              onClick={() => navigate("dashboard")}
              title={`Clocked into ${active.company.name}`}
            >
              <span className="pulse" aria-hidden="true" />
              {formatClock(
                (data.now - new Date(active.startedAt).getTime()) / 1000,
              )}
            </button>
          )}
        </div>
      </header>

      <main className="shell">
        {data.error && (
          <Alert variant="destructive" className="mb-6 bg-destructive/5">
            <AlertDescription>{data.error}</AlertDescription>
            <AlertAction>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => data.setError(null)}
                aria-label="Dismiss error"
              >
                <XIcon />
              </Button>
            </AlertAction>
          </Alert>
        )}
        {route === "dashboard" && <Dashboard data={data} periods={periods} />}
        {route === "history" && <History data={data} />}
        {route === "settings" && <Settings data={data} />}
      </main>
    </div>
  );
}
