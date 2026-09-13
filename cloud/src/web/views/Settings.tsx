import { useState } from "react";
import { PencilIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cadenceLabels, payPeriodWindow } from "../../lib/pay-period";
import type { Company } from "../api";
import { CompanyDialog } from "../components/CompanyDialog";
import { CompanyMark, companyStyle } from "../components/CompanyMark";
import { formatDate, formatRange } from "../format";
import type { TimeClockData } from "../use-time-clock";

export function Settings({ data }: { data: TimeClockData }) {
  const { companies, now } = data;
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const visible = companies.filter(
    (company) => showArchived || !company.archived,
  );

  function openEditor(company: Company | null) {
    setEditing(company);
    setDialogOpen(true);
  }

  return (
    <>
      <section className="section section--first">
        <div className="section-heading">
          <div>
            <h2>Companies</h2>
            <p className="section-subtitle">
              Each company keeps its own pay-period cadence. The ID is what the
              desk switch sends.
            </p>
          </div>
          <Button onClick={() => openEditor(null)}>
            <PlusIcon />
            Add company
          </Button>
        </div>

        <div className="settings-toolbar">
          <Label htmlFor="show-archived" className="flex items-center gap-2">
            <Switch
              id="show-archived"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            Show archived
          </Label>
        </div>

        {visible.length ? (
          <ul className="company-list">
            {visible.map((company) => {
              const window = payPeriodWindow(company, new Date(now));
              return (
                <li
                  key={company.id}
                  className={company.archived ? "is-archived" : ""}
                  style={companyStyle(company)}
                >
                  <CompanyMark company={company} size="lg" />
                  <div className="company-list-body">
                    <strong>
                      {company.name}
                      {company.archived && (
                        <Badge variant="secondary" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </strong>
                    <span>
                      {cadenceLabels[company.payPeriodCadence]}
                      {company.payPeriodCadence !== "semimonthly" &&
                      company.payPeriodAnchorDate
                        ? ` · anchored ${formatDate(company.payPeriodAnchorDate + "T00:00", true)}`
                        : ""}
                      {" · "}current {formatRange(window.start, window.end)}
                    </span>
                    <code>{company.id}</code>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditor(company)}
                  >
                    <PencilIcon />
                    Edit
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty-panel">
            <strong>No companies yet</strong>
            <p>Add one to start tracking time against it.</p>
            <Button onClick={() => openEditor(null)}>
              <PlusIcon />
              Add company
            </Button>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-heading">
          <div>
            <h2>Desk switch</h2>
            <p className="section-subtitle">
              Assign a company to each switch position from the device's USB
              console.
            </p>
          </div>
        </div>
        <pre className="console-sample">
          {`set left_company_id  <company ID>
set right_company_id <company ID>
reboot`}
        </pre>
      </section>

      <CompanyDialog
        open={dialogOpen}
        company={editing}
        onOpenChange={setDialogOpen}
        onSaved={async () => {
          setDialogOpen(false);
          await data.refresh();
        }}
        onError={data.setError}
      />
    </>
  );
}
