"use client";

// Canonical animal profile (#167) — the staff-facing registry workspace
// for one permanent animal record: identity + lifecycle state and its
// transition history up top, then cross-domain registry context
// (ownership, registrations, payments, microchips, documents), then the
// medical continuity record (#173/#174: alerts, rechecks, one
// chronological timeline of encounters, vaccinations, procedures,
// medications, weights). Volunteer-first UX — a flat scannable list
// with derived badges, not an EMR. Nothing here is public; the page
// sits behind requireAdmin and every action re-authorizes server-side.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import {
  getAnimalMedicalAction,
  transitionLifecycleAction,
  type AnimalMedicalRecord,
} from "./actions";
import type {
  AdminClinicExpectation,
  AdminFollowUp,
  AdminMedicalAlert,
  AdminVetEncounter,
  AdminVetMedication,
  AdminVetProcedure,
  AdminWeightRecord,
  MedicalTimelineItem,
} from "@/lib/registry/medical";
import type { AdminVaccination } from "@/lib/registry/vaccinations";
import { todayIsoDate } from "@/lib/vaccinations";
import {
  ANIMAL_LIFECYCLE_LABELS,
  ANIMAL_LIFECYCLE_STATUSES,
  formatAnimalAge,
  getAnimalAdoptionLabel,
  getAnimalLifecycleLabel,
} from "@/lib/animal-lifecycle";
import {
  AnimalAdoptionBadge,
  AnimalLifecycleBadge,
} from "@/components/admin/animal-status-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ActiveAlerts } from "@/components/admin/medical/active-alerts";
import { MedicalTimeline } from "@/components/admin/medical/medical-timeline";
import { VaccinationDialog } from "@/components/admin/medical/vaccination-dialog";
import { EncounterDialog } from "@/components/admin/medical/encounter-dialog";
import { AlertDialog } from "@/components/admin/medical/alert-dialog";
import { ProcedureDialog } from "@/components/admin/medical/procedure-dialog";
import { MedicationDialog } from "@/components/admin/medical/medication-dialog";
import { WeightDialog } from "@/components/admin/medical/weight-dialog";
import { FollowUpDialog } from "@/components/admin/medical/follow-up-dialog";
import { FollowUpPanel } from "@/components/admin/medical/follow-up-panel";
import { ClinicExpectationDialog } from "@/components/admin/medical/clinic-expectation-dialog";
import { ClinicExpectationPanel } from "@/components/admin/medical/clinic-expectation-panel";
import { MarkSeenDialog } from "@/components/admin/medical/mark-seen-dialog";
import { CommunicationsPanel } from "@/components/admin/medical/communications-panel";
import { OwnershipPanel } from "@/components/admin/medical/ownership-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Plus } from "lucide-react";
import { logError } from "@/lib/logger";
import { LoadError } from "@/components/admin/load-error";

type DialogType =
  | "encounter"
  | "vaccination"
  | "procedure"
  | "medication"
  | "weight"
  | "alert"
  | "follow-up"
  | "clinic-expectation"
  | "mark-seen";

export default function AnimalMedicalPage() {
  const params = useParams<{ id: string }>();
  const registryId = params.id;

  const [record, setRecord] = useState<AnimalMedicalRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [dialog, setDialog] = useState<{
    type: DialogType;
    // Timeline records edit via `editing`; follow-ups and clinic
    // expectations are not timeline items so they travel on their own
    // fields.
    editing: MedicalTimelineItem | null;
    followUp?: AdminFollowUp | null;
    expectation?: AdminClinicExpectation | null;
  } | null>(null);
  // Derived states are date-relative; fix "today" when the page loads
  // so rows don't shift mid-session.
  const [today] = useState(() => todayIsoDate());
  const [lifecycleDialog, setLifecycleDialog] = useState<{
    toStatus: string;
    effectiveOn: string;
    reason: string;
  } | null>(null);
  const [savingLifecycle, setSavingLifecycle] = useState(false);
  const { toast } = useToast();

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

  const {
    animal,
    timeline,
    followUps,
    clinicExpectations,
    communications,
    ownerships,
    confirmations,
    lifecycleHistory,
    sterilization,
    registry,
    persons,
    households,
  } = record;
  const encounters = timeline
    .filter((i) => i.kind === "encounter")
    .map((i) => i.record as AdminVetEncounter);

  const openDialog = (type: DialogType, editing: MedicalTimelineItem | null) =>
    setDialog({ type, editing });
  const closeDialog = () => setDialog(null);

  const submitLifecycleTransition = async () => {
    if (!lifecycleDialog?.toStatus) return;
    setSavingLifecycle(true);
    try {
      const result = await transitionLifecycleAction(
        animal.id,
        lifecycleDialog.toStatus,
        lifecycleDialog.effectiveOn || null,
        lifecycleDialog.reason || null,
      );
      if (!result.ok) {
        toast({
          title: "Transition not applied",
          description:
            result.reason === "invalid"
              ? "That transition is not valid from the current state."
              : "Failed to update the registry status. Try again.",
          variant: "destructive",
        });
        return;
      }
      setLifecycleDialog(null);
      toast({ title: "Registry status updated" });
      loadRecord();
    } catch (error) {
      logError("animals", "lifecycle-transition", error);
      toast({
        title: "Error",
        description: "Failed to update the registry status. Try again.",
        variant: "destructive",
      });
    } finally {
      setSavingLifecycle(false);
    }
  };

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
          <AnimalLifecycleBadge status={animal.lifecycleStatus} />
          <AnimalAdoptionBadge
            status={animal.adoptionStatus}
            lifecycleStatus={animal.lifecycleStatus}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setLifecycleDialog({
                toStatus: "",
                effectiveOn: today,
                reason: "",
              })
            }
          >
            Change registry status
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 capitalize">
          {animal.registryRef} · {animal.species} · {animal.sex}
          {formatAnimalAge(animal.birthDate, animal.birthDateEstimated)
            ? ` · ${formatAnimalAge(animal.birthDate, animal.birthDateEstimated)}`
            : ""}
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Registry</CardTitle>
          <CardDescription>
            The permanent record — identity, lifecycle history, and the
            linked registry domains.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <dt className="text-muted-foreground">Registry ref</dt>
              <dd className="font-mono">{animal.registryRef}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Registry status since</dt>
              <dd>
                {getAnimalLifecycleLabel(animal.lifecycleStatus)}
                {animal.lifecycleEffectiveOn
                  ? ` — effective ${animal.lifecycleEffectiveOn}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Birth date</dt>
              <dd>
                {animal.birthDate
                  ? `${animal.birthDate}${animal.birthDateEstimated ? " (estimated)" : ""}`
                  : "Unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sterilization</dt>
              <dd>
                {sterilization.status === "sterilized"
                  ? `Sterilized${sterilization.sterilizedOn ? ` ${sterilization.sterilizedOn}` : ""}${sterilization.sterilizedBy ? ` by ${sterilization.sterilizedBy}` : ""}`
                  : sterilization.status === "intact"
                    ? "Not sterilized"
                    : "Unknown"}
                {sterilization.evidence.length > 0 &&
                  ` (${sterilization.evidence.length} procedure record${sterilization.evidence.length === 1 ? "" : "s"})`}
              </dd>
            </div>
            {animal.identifyingNotes && (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Identifying notes</dt>
                <dd>{animal.identifyingNotes}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Adoption listing</dt>
              <dd>{getAnimalAdoptionLabel(animal.adoptionStatus)}</dd>
            </div>
          </dl>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h3 className="font-medium mb-1">Microchips</h3>
              {registry.microchips.length === 0 ? (
                <p className="text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="space-y-1">
                  {registry.microchips.map((c) => (
                    <li key={c.id} className="font-mono text-xs">
                      {c.chipNumber}
                      <span className="text-muted-foreground font-sans">
                        {" "}
                        {c.assignedTo
                          ? `${c.assignedFrom} → ${c.assignedTo}`
                          : `active since ${c.assignedFrom}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="font-medium mb-1">Registrations</h3>
              {registry.registrations.length === 0 ? (
                <p className="text-muted-foreground">
                  No registrations — the animal stays in the registry
                  regardless.
                </p>
              ) : (
                <ul className="space-y-1">
                  {registry.registrations.map((r) => (
                    <li key={r.id}>
                      {r.year} — <span className="capitalize">{r.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="font-medium mb-1">Payments</h3>
              {registry.payments.length === 0 ? (
                <p className="text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="space-y-1">
                  {registry.payments.map((p) => (
                    <li key={p.id}>
                      {(p.amountCents / 100).toFixed(2)} {p.currency} —{" "}
                      <span className="capitalize">{p.status}</span>{" "}
                      <span className="text-muted-foreground">
                        {p.occurredAt.slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="font-medium mb-1">Documents</h3>
              {registry.documents.length === 0 ? (
                <p className="text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="space-y-1">
                  {registry.documents.map((d) => (
                    <li key={d.id}>{d.label}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-medium mb-1">Lifecycle history</h3>
            <ul className="space-y-1">
              {lifecycleHistory.map((e) => (
                <li key={e.id}>
                  <span className="text-muted-foreground">{e.effectiveOn}</span>{" "}
                  {e.fromStatus
                    ? `${getAnimalLifecycleLabel(e.fromStatus)} → `
                    : "Entered registry as "}
                  <strong>{getAnimalLifecycleLabel(e.toStatus)}</strong>
                  {e.reason ? ` — ${e.reason}` : ""}
                  <span className="text-muted-foreground">
                    {" "}
                    ({e.source === "owner-request" ? "owner report" : e.source}
                    {e.actorLabel ? `, ${e.actorLabel}` : ""})
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="font-medium mb-1">Recent audit activity</h3>
            {registry.auditTrail.length === 0 ? (
              <p className="text-muted-foreground">No recorded changes.</p>
            ) : (
              <ul className="space-y-1 text-muted-foreground">
                {registry.auditTrail.map((a) => (
                  <li key={a.id}>
                    {a.createdAt.slice(0, 16).replace("T", " ")} — {a.action}
                    {a.actorLabel ? ` by ${a.actorLabel}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <ActiveAlerts timeline={timeline} />

      <FollowUpPanel
        followUps={followUps}
        encounters={encounters}
        today={today}
        onChanged={loadRecord}
        onAdd={() => openDialog("follow-up", null)}
        onEdit={(fu) => setDialog({ type: "follow-up", editing: null, followUp: fu })}
      />

      <ClinicExpectationPanel
        expectations={clinicExpectations}
        encounters={encounters}
        today={today}
        onChanged={loadRecord}
        onAdd={() => openDialog("clinic-expectation", null)}
        onEdit={(ex) =>
          setDialog({ type: "clinic-expectation", editing: null, expectation: ex })
        }
        onMarkSeen={(ex) =>
          setDialog({ type: "mark-seen", editing: null, expectation: ex })
        }
      />

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

      <OwnershipPanel
        animalId={animal.id}
        ownerships={ownerships}
        confirmations={confirmations}
        persons={persons}
        households={households}
        today={today}
        onChanged={loadRecord}
      />

      <CommunicationsPanel communications={communications} />

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
      <FollowUpDialog
        animalId={animal.id}
        animalName={animal.name}
        encounters={encounters}
        editing={dialog?.type === "follow-up" ? (dialog.followUp ?? null) : null}
        open={dialog?.type === "follow-up"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
        today={today}
      />
      <ClinicExpectationDialog
        animalId={animal.id}
        animalName={animal.name}
        editing={
          dialog?.type === "clinic-expectation"
            ? (dialog.expectation ?? null)
            : null
        }
        open={dialog?.type === "clinic-expectation"}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={loadRecord}
      />
      <MarkSeenDialog
        expectation={
          dialog?.type === "mark-seen" ? (dialog.expectation ?? null) : null
        }
        animalName={animal.name}
        encounters={encounters}
        open={dialog?.type === "mark-seen"}
        onOpenChange={(o) => !o && closeDialog()}
        onResolved={loadRecord}
      />

      <Dialog
        open={lifecycleDialog !== null}
        onOpenChange={(o) => !o && setLifecycleDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change registry status</DialogTitle>
            <DialogDescription>
              Records a permanent lifecycle transition for {animal.name}.
              Marking an animal deceased or moved off Saba closes every
              current ownership — including co-owners — and cancels open
              follow-ups and clinic expectations. The animal stays in the
              registry and the change is preserved in lifecycle history.
            </DialogDescription>
          </DialogHeader>
          {lifecycleDialog && (
            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="lifecycle-to">New status</Label>
                <Select
                  value={lifecycleDialog.toStatus}
                  onValueChange={(v) =>
                    setLifecycleDialog({ ...lifecycleDialog, toStatus: v })
                  }
                >
                  <SelectTrigger id="lifecycle-to">
                    <SelectValue placeholder="Choose a status" />
                  </SelectTrigger>
                  <SelectContent>
                    {ANIMAL_LIFECYCLE_STATUSES.filter(
                      (s) => s !== animal.lifecycleStatus,
                    ).map((s) => (
                      <SelectItem key={s} value={s}>
                        {ANIMAL_LIFECYCLE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="lifecycle-effective">Effective date</Label>
                <Input
                  id="lifecycle-effective"
                  type="date"
                  value={lifecycleDialog.effectiveOn}
                  onChange={(e) =>
                    setLifecycleDialog({
                      ...lifecycleDialog,
                      effectiveOn: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <Label htmlFor="lifecycle-reason">Reason / notes</Label>
                <Input
                  id="lifecycle-reason"
                  value={lifecycleDialog.reason}
                  placeholder="Optional — kept in lifecycle history"
                  onChange={(e) =>
                    setLifecycleDialog({
                      ...lifecycleDialog,
                      reason: e.target.value,
                    })
                  }
                />
              </div>
              <Button
                className="w-full"
                disabled={!lifecycleDialog.toStatus || savingLifecycle}
                onClick={submitLifecycleTransition}
              >
                {savingLifecycle ? "Saving…" : "Apply transition"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
