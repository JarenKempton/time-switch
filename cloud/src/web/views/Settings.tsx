import { useState } from "react";
import { PencilIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Switch } from "@/web/components/ui/switch";
import { Label } from "@/web/components/ui/label";
import { describeCadence, upcomingPeriods } from "../lib/pay-period";
import type { Company } from "../api";
import { CompanyDialog } from "../components/CompanyDialog";
import { CompanyMark, companyStyle } from "../components/CompanyMark";
import { formatRange } from "../format";
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
              Each company keeps its own pay-period cadence.
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
              const [current, next] = upcomingPeriods(
                company,
                new Date(now),
                2,
              );
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
                    <span>{describeCadence(company)}</span>
                    <span>
                      Current {formatRange(current.start, current.end)} · next{" "}
                      {formatRange(next.start, next.end)}
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
