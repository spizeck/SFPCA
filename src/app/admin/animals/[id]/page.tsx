"use client";

// Per-animal medical record (#173 → #174). The staff-facing continuity
// view: active alerts up top, open rechecks next, then one chronological
// timeline combining encounters, vaccinations, procedures, medications,
// and weights. Volunteer-first UX — a flat scannable list with derived
// badges, not an EMR. Nothing here is public; the page sits behind
// requireAdmin and every action re-authorizes server-side.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getAnimalMedicalAction,
  type AnimalMedicalRecord,
} from "./actions";
import type {
  AdminMedicalAlert,
  AdminVetEncounter,
  AdminVetMedication,
  AdminVetProcedure,
  AdminWeightRecord,
  MedicalTimelineItem,
} from "@/lib/registry/medical";
import type { AdminVaccination } from "@/lib/registry/vaccinations";
import { todayIsoDate } from "@/lib/vaccinations";
import { AnimalStatusBadge } from "@/components/admin/animal-status-badge";
import { ActiveAlerts } from "@/components/admin/medical/active-alerts";
import { MedicalTimeline } from "@/components/admin/medical/medical-timeline";
import { VaccinationDialog } from "@/components/admin/medical/vaccination-dialog";
import { EncounterDialog } from "@/components/admin/medical/encounter-dialog";
import { AlertDialog } from "@/components/admin/medical/alert-dialog";
import { ProcedureDialog } from "@/components/admin/medical/procedure-dialog";
import { MedicationDialog } from "@/components/admin/medical/medication-dialog";
import { WeightDialog } from "@/components/admin/medical/weight-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Plus, CalendarClock } from "lucide-react";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";

type DialogType =
  | "encounter"
  | "vaccination"
  | "procedure"
  | "medication"
  | "weight"
  | "alert";

export default function AnimalMedicalPage() {
  const params = useParams<{ id: string }>();
  const registryId = params.id;

  const [record, setRecord] = useState<AnimalMedicalRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<{
    type: DialogType;
    editing: MedicalTimelineItem | null;
  } | null>(null);
  // Derived states are date-relative; fix "today" when the page loads
  // so rows don't shift mid-session.
  const [today] = useState(() => todayIsoDate());

  useEffect(() => {
    loadRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryId]);

  const loadRecord = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await getAnimalMedicalAction(registryId);
      if (!result) {
        setNotFound(true);
        setRecord(null);
      } else {
        setNotFound(false);
        setRecord(result);
      }
    } catch (error) {
      logError("medical", "admin-load", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  if (loadError) {
    return <LoadError label="medical record" onRetry={loadRecord} />;
  }

  if (notFound || !record) {
    return (
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle>Animal not found</CardTitle>
            <CardDescription>
              This animal record doesn&apos;t exist or was removed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/animals">Back to animals</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { animal, timeline, openFollowUps } = record;
  const encounters = timeline
    .filter((i) => i.kind === "encounter")
    .map((i) => i.record as AdminVetEncounter);

  const openDialog = (type: DialogType, editing: MedicalTimelineItem | null) =>
    setDialog({ type, editing });
  const closeDialog = () => setDialog(null);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
          <Link href="/admin/animals">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to animals
          </Link>
        </Button>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold">{animal.name}</h1>
          <AnimalStatusBadge status={animal.lifecycleStatus} />
        </div>
        <p className="text-muted-foreground mt-1 capitalize">
          {animal.species} · {animal.sex}
          {animal.approxAge ? ` · ${animal.approxAge}` : ""}
        </p>
      </div>

      <ActiveAlerts timeline={timeline} />

      {openFollowUps.length > 0 && (
        <section
          aria-label="Open follow-ups"
          className="mb-4 space-y-2"
        >
          {openFollowUps.map((fu) => (
            <div
              key={fu.id}
              className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50 p-3"
            >
              <CalendarClock className="h-5 w-5 text-blue-600 shrink-0" />
              <div className="min-w-0">
                <span className="font-medium">
                  {fu.kind === "recheck" ? "Recheck" : fu.kind} due{" "}
                  {fu.dueOn}
                  {fu.dueOn < today ? " (overdue)" : ""}
                </span>
                {fu.notes && (
                  <span className="text-sm text-muted-foreground">
                    {" "}
                    — {fu.notes}
                  </span>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle>Medical timeline</CardTitle>
            <CardDescription>
              Everything clinically important, newest first. &quot;Next
              date&quot; on a vaccination is the soonest of its next-due
              and expiry dates.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => openDialog("encounter", null)}>
              <Plus className="h-4 w-4 mr-1" />
              Log visit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog("vaccination", null)}
            >
              Add vaccination
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog("procedure", null)}
            >
              Add procedure
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog("medication", null)}
            >
              Add medication
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog("weight", null)}
            >
              Add weight
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openDialog("alert", null)}
            >
              Add alert
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <MedicalTimeline
            items={timeline}
            today={today}
            onEdit={(item) => openDialog(item.kind, item)}
          />
        </CardContent>
      </Card>

      <EncounterDialog
        animalId={animal.id}
        animalName={animal.name}
        editing={
          dialog?.type === "encounter"
            ? ((dialog.editing?.record as AdminVetEncounter) ?? null)
            : null
        }
        open={dialog?.type === "encounter"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
      <VaccinationDialog
        animalId={animal.id}
        animalName={animal.name}
        encounters={encounters}
        editing={
          dialog?.type === "vaccination"
            ? ((dialog.editing?.record as AdminVaccination) ?? null)
            : null
        }
        open={dialog?.type === "vaccination"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
      <ProcedureDialog
        animalId={animal.id}
        animalName={animal.name}
        encounters={encounters}
        editing={
          dialog?.type === "procedure"
            ? ((dialog.editing?.record as AdminVetProcedure) ?? null)
            : null
        }
        open={dialog?.type === "procedure"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
      <MedicationDialog
        animalId={animal.id}
        animalName={animal.name}
        encounters={encounters}
        editing={
          dialog?.type === "medication"
            ? ((dialog.editing?.record as AdminVetMedication) ?? null)
            : null
        }
        open={dialog?.type === "medication"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
      />
      <WeightDialog
        animalId={animal.id}
        animalName={animal.name}
        editing={
          dialog?.type === "weight"
            ? ((dialog.editing?.record as AdminWeightRecord) ?? null)
            : null
        }
        open={dialog?.type === "weight"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
      <AlertDialog
        animalId={animal.id}
        animalName={animal.name}
        editing={
          dialog?.type === "alert"
            ? ((dialog.editing?.record as AdminMedicalAlert) ?? null)
            : null
        }
        open={dialog?.type === "alert"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
    </div>
  );
}
