"use client";

// Active medical alerts panel (#174) — the first thing a vet sees.
// Alerts must never hide inside old encounter notes; they render here
// as prominent cards until resolved.

import {
  ALERT_KIND_LABELS,
  ALERT_SEVERITY_LABELS,
  type AlertKind,
  type AlertSeverity,
} from "@/lib/medical";
import type { MedicalTimelineItem } from "@/lib/registry/medical";
import type { AdminMedicalAlert } from "@/lib/registry/medical";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";

function alertFrom(item: MedicalTimelineItem): AdminMedicalAlert | null {
  return item.kind === "alert" ? item.record : null;
}

export function ActiveAlerts({
  timeline,
}: {
  timeline: MedicalTimelineItem[];
}) {
  const alerts = timeline
    .map(alertFrom)
    .filter(
      (a): a is AdminMedicalAlert => a !== null && a.status === "active",
    );
  if (alerts.length === 0) return null;

  return (
    <section aria-label="Active medical alerts" className="mb-4 space-y-2">
      {alerts.map((a) => (
        <div
          key={a.id}
          className={`flex items-start gap-3 rounded-md border p-3 ${
            a.severity === "critical"
              ? "border-red-300 bg-red-50"
              : "border-amber-300 bg-amber-50"
          }`}
        >
          <AlertTriangle
            className={`h-5 w-5 mt-0.5 shrink-0 ${
              a.severity === "critical" ? "text-red-600" : "text-amber-600"
            }`}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{a.summary}</span>
              <Badge variant="outline">
                {ALERT_KIND_LABELS[a.kind as AlertKind] ?? a.kind}
              </Badge>
              <Badge
                variant={
                  a.severity === "critical" ? "destructive" : "secondary"
                }
              >
                {ALERT_SEVERITY_LABELS[a.severity as AlertSeverity] ??
                  a.severity}
              </Badge>
            </div>
            {a.details && (
              <p className="text-sm text-muted-foreground mt-1">
                {a.details}
              </p>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
