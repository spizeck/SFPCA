"use client";

// Follow-up panel on the animal medical record (#175) — open rechecks
// as actionable rows (complete/cancel inline, edit, source-visit
// context), then resolved history collapsed below. Completing or
// cancelling never deletes: the item moves to history with its
// resolved_at stamp and the audit trail records who acted.

import {
  followUpState,
  type FollowUpState,
} from "@/lib/medical";
import type {
  AdminFollowUp,
  AdminVetEncounter,
} from "@/lib/registry/medical";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FollowUpResolveButtons,
  FollowUpStateBadge,
} from "./follow-up-controls";
import { CalendarClock, Pencil, Plus } from "lucide-react";

function encounterDate(
  encounters: AdminVetEncounter[],
  encounterId: string | null,
): string | null {
  if (!encounterId) return null;
  return encounters.find((e) => e.id === encounterId)?.occurredOn ?? null;
}

export function FollowUpPanel({
  followUps,
  encounters,
  today,
  onChanged,
  onAdd,
  onEdit,
}: {
  followUps: AdminFollowUp[];
  encounters: AdminVetEncounter[];
  today: string;
  onChanged: () => void;
  onAdd: () => void;
  onEdit: (followUp: AdminFollowUp) => void;
}) {
  const open = followUps.filter((f) => f.status === "open");
  const resolved = followUps.filter((f) => f.status !== "open");

  return (
    <Card className="mb-4">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Follow-ups</CardTitle>
            <CardDescription>
              Rechecks and follow-up work for this animal. Resolved items
              stay in history below.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4 mr-1" />
            Add follow-up
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open follow-ups for this animal.
          </p>
        ) : (
          open.map((fu) => {
            const state = followUpState(fu.dueOn, fu.status, today);
            const fromVisit = encounterDate(encounters, fu.encounterId);
            return (
              <div
                key={fu.id}
                className={`flex items-center gap-3 rounded-md border p-3 flex-wrap ${
                  state === "overdue"
                    ? "border-red-200 bg-red-50"
                    : state === "due"
                      ? "border-amber-200 bg-amber-50"
                      : "border-blue-200 bg-blue-50"
                }`}
              >
                <CalendarClock className="h-5 w-5 text-blue-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {fu.reason ?? "Recheck"}
                    </span>
                    <FollowUpStateBadge state={state} />
                    <span className="text-sm text-muted-foreground">
                      due {fu.dueOn}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                    {fromVisit && <span>From visit on {fromVisit}</span>}
                    {fu.notes && <span>{fu.notes}</span>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${fu.reason ?? "follow-up"}`}
                  onClick={() => onEdit(fu)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <FollowUpResolveButtons
                  followUpId={fu.id}
                  updatedAt={fu.updatedAt}
                  label={fu.reason ?? "follow-up"}
                  onResolved={onChanged}
                />
              </div>
            );
          })
        )}

        {resolved.length > 0 && (
          <details className="pt-2">
            <summary className="text-sm text-muted-foreground cursor-pointer">
              Resolved history ({resolved.length})
            </summary>
            <div className="space-y-2 mt-2">
              {resolved.map((fu) => (
                <div
                  key={fu.id}
                  className="flex items-center gap-3 rounded-md border p-3 text-muted-foreground"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{fu.reason ?? "Recheck"}</span>
                      <FollowUpStateBadge
                        state={fu.status as FollowUpState}
                      />
                      <span className="text-sm">due {fu.dueOn}</span>
                    </div>
                    {fu.resolvedAt && (
                      <div className="text-xs mt-0.5">
                        {fu.status === "completed" ? "Completed" : "Cancelled"}{" "}
                        {fu.resolvedAt.slice(0, 10)}
                      </div>
                    )}
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    history
                  </Badge>
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
