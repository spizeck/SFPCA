"use client";

// Clinic-expectation panel on the animal medical record (#194) —
// unresolved expectations as actionable rows (mark seen via the
// encounter-link dialog, no-show/cancel inline, edit), then resolved
// history collapsed below. Resolving never deletes: the row moves to
// history with its resolved_at stamp and the audit trail records who
// acted.

import {
  clinicExpectationState,
  type ClinicExpectationState,
} from "@/lib/medical";
import type {
  AdminClinicExpectation,
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
  ClinicExpectationResolveButtons,
  ClinicExpectationStateBadge,
} from "./clinic-expectation-controls";
import { CalendarPlus, Pencil, Plus } from "lucide-react";

function encounterDate(
  encounters: AdminVetEncounter[],
  encounterId: string | null,
): string | null {
  if (!encounterId) return null;
  return encounters.find((e) => e.id === encounterId)?.occurredOn ?? null;
}

export function ClinicExpectationPanel({
  expectations,
  encounters,
  today,
  onChanged,
  onAdd,
  onEdit,
  onMarkSeen,
}: {
  expectations: AdminClinicExpectation[];
  encounters: AdminVetEncounter[];
  today: string;
  onChanged: () => void;
  onAdd: () => void;
  onEdit: (expectation: AdminClinicExpectation) => void;
  // Seen delegates to the page's mark-seen dialog so staff can link the
  // real visit; no-show/cancel resolve inline.
  onMarkSeen: (expectation: AdminClinicExpectation) => void;
}) {
  const live = expectations.filter((e) => e.status === "expected");
  const resolved = expectations.filter((e) => e.status !== "expected");

  return (
    <Card className="mb-4">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Clinic expectations</CardTitle>
            <CardDescription>
              When this animal is expected at a clinic session. Resolved
              expectations stay in history below.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4 mr-1" />
            Expect at clinic
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming clinic expectations for this animal.
          </p>
        ) : (
          live.map((ex) => {
            const state = clinicExpectationState(
              ex.expectedOn,
              ex.status,
              today,
            );
            return (
              <div
                key={ex.id}
                className={`flex items-center gap-3 rounded-md border p-3 flex-wrap ${
                  state === "overdue"
                    ? "border-red-200 bg-red-50"
                    : state === "due"
                      ? "border-amber-200 bg-amber-50"
                      : "border-blue-200 bg-blue-50"
                }`}
              >
                <CalendarPlus className="h-5 w-5 text-blue-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{ex.reason}</span>
                    <ClinicExpectationStateBadge state={state} />
                    <span className="text-sm text-muted-foreground">
                      expected {ex.expectedOn}
                    </span>
                    {ex.sessionLabel && (
                      <Badge variant="outline">{ex.sessionLabel}</Badge>
                    )}
                  </div>
                  {ex.notes && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {ex.notes}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${ex.reason}`}
                  onClick={() => onEdit(ex)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <ClinicExpectationResolveButtons
                  expectationId={ex.id}
                  updatedAt={ex.updatedAt}
                  label={ex.reason}
                  onResolved={onChanged}
                  onMarkSeen={() => onMarkSeen(ex)}
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
              {resolved.map((ex) => {
                const seenOn = encounterDate(encounters, ex.encounterId);
                return (
                  <div
                    key={ex.id}
                    className="flex items-center gap-3 rounded-md border p-3 text-muted-foreground"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{ex.reason}</span>
                        <ClinicExpectationStateBadge
                          state={ex.status as ClinicExpectationState}
                        />
                        <span className="text-sm">
                          expected {ex.expectedOn}
                        </span>
                        {ex.sessionLabel && (
                          <Badge variant="outline">{ex.sessionLabel}</Badge>
                        )}
                      </div>
                      <div className="text-xs mt-0.5 space-x-2">
                        {ex.resolvedAt && (
                          <span>
                            {ex.status === "seen"
                              ? "Seen"
                              : ex.status === "no_show"
                                ? "No-show"
                                : "Cancelled"}{" "}
                            {ex.resolvedAt.slice(0, 10)}
                          </span>
                        )}
                        {seenOn && <span>Visit on {seenOn}</span>}
                      </div>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      history
                    </Badge>
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
