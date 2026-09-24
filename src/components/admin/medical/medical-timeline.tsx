"use client";

// The unified medical timeline (#174) — every clinical record type in
// one chronological feed so a rotating vet scans one list instead of
// six tables. Row content is per-kind: each record type surfaces its
// most useful fields and an edit affordance.

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VaccinationStatusBadge } from "@/components/admin/vaccination-status-badge";
import {
  effectiveVaccinationDate,
  vaccinationDueState,
} from "@/lib/vaccinations";
import {
  ENCOUNTER_KIND_LABELS,
  PROCEDURE_KIND_LABELS,
  ALERT_KIND_LABELS,
  ALERT_SEVERITY_LABELS,
  TIMELINE_KIND_LABELS,
  formatWeightGrams,
  isMedicationActive,
  type AlertKind,
  type AlertSeverity,
  type EncounterKind,
  type ProcedureKind,
} from "@/lib/medical";
import type { MedicalTimelineItem } from "@/lib/registry/medical";
import { Pencil } from "lucide-react";

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="text-xs text-muted-foreground mt-0.5">
      <span className="font-medium">{label}:</span> {value}
    </div>
  );
}

function ItemSummary({
  item,
  today,
}: {
  item: MedicalTimelineItem;
  today: string;
}) {
  switch (item.kind) {
    case "encounter": {
      const e = item.record;
      return (
        <div>
          <div className="font-medium">
            {e.reason ??
              ENCOUNTER_KIND_LABELS[e.kind as EncounterKind] ??
              "Entry"}
          </div>
          <Detail label="Complaint" value={e.complaint} />
          <Detail label="Findings" value={e.findings} />
          <Detail label="Assessment" value={e.assessment} />
          <Detail label="Plan" value={e.plan} />
          <Detail label="Notes" value={e.notes} />
        </div>
      );
    }
    case "vaccination": {
      const v = item.record;
      const effective = effectiveVaccinationDate(v.dueOn, v.validUntil);
      const details = [v.productName, v.lotNumber].filter(Boolean).join(" · ");
      return (
        <div>
          <div className="font-medium">{v.vaccineName}</div>
          {details && (
            <div className="text-xs text-muted-foreground">{details}</div>
          )}
          <Detail label="Next date" value={effective} />
          <Detail label="Notes" value={v.notes} />
        </div>
      );
    }
    case "procedure": {
      const p = item.record;
      return (
        <div>
          <div className="font-medium">
            {PROCEDURE_KIND_LABELS[p.kind as ProcedureKind] ?? "Procedure"}
            {": "}
            {p.description}
          </div>
          <Detail label="Notes" value={p.notes} />
        </div>
      );
    }
    case "medication": {
      const m = item.record;
      const course = [m.dose, m.route, m.frequency].filter(Boolean).join(" · ");
      return (
        <div>
          <div className="font-medium">{m.medication}</div>
          {course && (
            <div className="text-xs text-muted-foreground">{course}</div>
          )}
          <Detail
            label="Course"
            value={`${m.startOn} → ${m.endOn ?? "ongoing"}`}
          />
          <Detail label="Instructions" value={m.instructions} />
          <Detail label="Prescribed by" value={m.prescribedBy} />
          <Detail label="Notes" value={m.notes} />
        </div>
      );
    }
    case "weight": {
      const w = item.record;
      return (
        <div>
          <div className="font-medium">{formatWeightGrams(w.weightGrams)}</div>
          <Detail label="Notes" value={w.notes} />
        </div>
      );
    }
    case "alert": {
      const a = item.record;
      return (
        <div>
          <div className="font-medium">
            {ALERT_KIND_LABELS[a.kind as AlertKind] ?? "Alert"}: {a.summary}
          </div>
          <Detail label="Details" value={a.details} />
          {a.status === "resolved" && (
            <Detail label="Resolved" value={a.resolvedOn} />
          )}
        </div>
      );
    }
  }
}

function itemProvider(item: MedicalTimelineItem): string | null {
  switch (item.kind) {
    case "encounter":
      return item.record.provider;
    case "vaccination":
      return item.record.administeredBy;
    case "procedure":
      return item.record.provider;
    case "medication":
      return item.record.prescribedBy;
    default:
      return null;
  }
}

// Extra status context in the row — the derived vaccine badge, a
// medication's active course, or an alert's severity.
function ItemStatus({
  item,
  today,
}: {
  item: MedicalTimelineItem;
  today: string;
}) {
  if (item.kind === "vaccination") {
    const v = item.record;
    return (
      <VaccinationStatusBadge
        state={vaccinationDueState(
          effectiveVaccinationDate(v.dueOn, v.validUntil),
          today,
        )}
      />
    );
  }
  if (item.kind === "medication") {
    const m = item.record;
    return isMedicationActive(m.startOn, m.endOn, today) ? (
      <Badge variant="secondary">Active</Badge>
    ) : null;
  }
  if (item.kind === "alert") {
    const a = item.record;
    if (a.status === "resolved") {
      return <Badge variant="outline">Resolved</Badge>;
    }
    return (
      <Badge
        variant={a.severity === "critical" ? "destructive" : "secondary"}
      >
        {ALERT_SEVERITY_LABELS[a.severity as AlertSeverity] ?? a.severity}
      </Badge>
    );
  }
  return null;
}

export function MedicalTimeline({
  items,
  today,
  onEdit,
}: {
  items: MedicalTimelineItem[];
  today: string;
  onEdit: (item: MedicalTimelineItem) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Date</TableHead>
          <TableHead className="w-28">Type</TableHead>
          <TableHead>Record</TableHead>
          <TableHead className="w-28">Provider</TableHead>
          <TableHead className="w-28">Status</TableHead>
          <TableHead className="w-16 text-right">Edit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-gray-500">
              No medical history recorded yet.
            </TableCell>
          </TableRow>
        ) : (
          items.map((item) => {
            const kindLabel =
              item.kind === "encounter"
                ? (ENCOUNTER_KIND_LABELS[
                    item.record.kind as EncounterKind
                  ] ?? "Visit")
                : TIMELINE_KIND_LABELS[item.kind];
            return (
              <TableRow key={`${item.kind}-${item.record.id}`}>
                <TableCell className="align-top whitespace-nowrap">
                  {item.date ?? "Unknown"}
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline">{kindLabel}</Badge>
                </TableCell>
                <TableCell className="align-top">
                  <ItemSummary item={item} today={today} />
                </TableCell>
                <TableCell className="align-top">
                  {itemProvider(item) ?? "—"}
                </TableCell>
                <TableCell className="align-top">
                  <ItemStatus item={item} today={today} />
                </TableCell>
                <TableCell className="align-top text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={editLabel(item)}
                    onClick={() => onEdit(item)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function editLabel(item: MedicalTimelineItem): string {
  switch (item.kind) {
    case "vaccination":
      return `Edit ${item.record.vaccineName} vaccination`;
    case "encounter":
      return `Edit ${item.record.reason ?? "entry"}`;
    case "procedure":
      return `Edit ${item.record.description} procedure`;
    case "medication":
      return `Edit ${item.record.medication} medication`;
    case "weight":
      return `Edit weight ${formatWeightGrams(item.record.weightGrams)}`;
    case "alert":
      return `Edit ${item.record.summary} alert`;
  }
}
