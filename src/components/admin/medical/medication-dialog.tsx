"use client";

// Add/edit dialog for a medication/course record (#174) — treatment
// history, not prescribing. A blank end date means ongoing.

import { useState } from "react";
import {
  saveMedicationAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type {
  AdminVetEncounter,
  AdminVetMedication,
} from "@/lib/registry/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import { EncounterLinkSelect, FieldError, MedicalDialog } from "./fields";

const EMPTY_FORM = {
  medication: "",
  dose: "",
  route: "",
  frequency: "",
  startOn: "",
  endOn: "",
  instructions: "",
  prescribedBy: "",
  notes: "",
  encounterId: null as string | null,
};

const FIELD_MESSAGES: Record<string, string> = {
  medication: "Enter the medication name.",
  startOn: "Enter the start date.",
  endOn: "End date can't be before the start date.",
};

export function MedicationDialog({
  animalId,
  animalName,
  encounters,
  editing,
  open,
  onOpenChange,
  onSaved,
}: {
  animalId: string;
  animalName: string;
  encounters: AdminVetEncounter[];
  editing: AdminVetMedication | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialJson, setInitialJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const mutation = useMutation();
  const { toast } = useToast();

  // Reset the form when the dialog (re)opens. Render-phase adjustment —
  // the documented alternative to an effect for derived state.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const base = editing
        ? {
            medication: editing.medication,
            dose: editing.dose ?? "",
            route: editing.route ?? "",
            frequency: editing.frequency ?? "",
            startOn: editing.startOn,
            endOn: editing.endOn ?? "",
            instructions: editing.instructions ?? "",
            prescribedBy: editing.prescribedBy ?? "",
            notes: editing.notes ?? "",
            encounterId: editing.encounterId,
          }
        : { ...EMPTY_FORM };
      setFormData(base);
      setInitialJson(JSON.stringify(base));
      setFieldErrors({});
    }
  }

  const formDirty = JSON.stringify(formData) !== initialJson;

  const handleOpenChange = (next: boolean) => {
    if (
      !next &&
      formDirty &&
      !window.confirm("Discard unsaved changes to this medication?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!formData.medication.trim()) {
      errors.medication = FIELD_MESSAGES.medication;
    }
    if (!isIsoDateString(formData.startOn)) {
      errors.startOn = FIELD_MESSAGES.startOn;
    }
    if (
      formData.endOn &&
      (!isIsoDateString(formData.endOn) ||
        formData.endOn < formData.startOn)
    ) {
      errors.endOn = FIELD_MESSAGES.endOn;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveMedicationAction(
          {
            animalId,
            encounterId: formData.encounterId,
            medication: formData.medication,
            dose: formData.dose || null,
            route: formData.route || null,
            frequency: formData.frequency || null,
            startOn: formData.startOn,
            endOn: formData.endOn || null,
            instructions: formData.instructions || null,
            prescribedBy: formData.prescribedBy || null,
            notes: formData.notes || null,
          },
          editing?.id ?? null,
          editing?.updatedAt,
        );
      } catch (error) {
        logError("medical", "admin-save", error);
        toast({
          title: "Error",
          description: "Failed to save. Your entries are kept — try again.",
          variant: "destructive",
        });
        return;
      }
      if (!result.ok) {
        if (result.reason === "invalid" && result.field) {
          setFieldErrors({
            [result.field]:
              FIELD_MESSAGES[result.field] ??
              "Check this field and try again.",
          });
          return;
        }
        toast({
          title: "Error",
          description:
            result.reason === "conflict"
              ? "This record was changed by someone else. Reopen it to see the latest version."
              : "Failed to save. Your entries are kept — try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Success",
        description: editing ? "Medication updated" : "Medication added",
      });
      onOpenChange(false);
      onSaved();
    });
  };

  const set = (patch: Partial<typeof EMPTY_FORM>) =>
    setFormData({ ...formData, ...patch });
  const err = (f: string) => ({
    "aria-invalid": !!fieldErrors[f],
    "aria-describedby": fieldErrors[f] ? `${f}-error` : undefined,
  });

  return (
    <MedicalDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={editing ? "Edit medication" : "Add medication"}
      description={
        editing
          ? "Correct this medication record"
          : `Record a medication/course for ${animalName}`
      }
      submitLabel={editing ? "Update medication" : "Add medication"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div>
        <Label htmlFor="medName">Medication</Label>
        <Input
          id="medName"
          value={formData.medication}
          onChange={(e) => set({ medication: e.target.value })}
          placeholder="e.g., Doxycycline"
          {...err("medication")}
        />
        <FieldError id="medication-error" message={fieldErrors.medication} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label htmlFor="medDose">Dose (optional)</Label>
          <Input
            id="medDose"
            value={formData.dose}
            onChange={(e) => set({ dose: e.target.value })}
            placeholder="e.g., 10 mg"
          />
        </div>
        <div>
          <Label htmlFor="medRoute">Route (optional)</Label>
          <Input
            id="medRoute"
            value={formData.route}
            onChange={(e) => set({ route: e.target.value })}
            placeholder="e.g., oral"
          />
        </div>
        <div>
          <Label htmlFor="medFrequency">Frequency (optional)</Label>
          <Input
            id="medFrequency"
            value={formData.frequency}
            onChange={(e) => set({ frequency: e.target.value })}
            placeholder="e.g., twice daily"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="medStartOn">Start date</Label>
          <Input
            id="medStartOn"
            type="date"
            value={formData.startOn}
            onChange={(e) => set({ startOn: e.target.value })}
            {...err("startOn")}
          />
          <FieldError id="startOn-error" message={fieldErrors.startOn} />
        </div>
        <div>
          <Label htmlFor="medEndOn">End date (blank = ongoing)</Label>
          <Input
            id="medEndOn"
            type="date"
            value={formData.endOn}
            onChange={(e) => set({ endOn: e.target.value })}
            {...err("endOn")}
          />
          <FieldError id="endOn-error" message={fieldErrors.endOn} />
        </div>
      </div>
      <div>
        <Label htmlFor="medInstructions">Instructions (optional)</Label>
        <Textarea
          id="medInstructions"
          rows={2}
          value={formData.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="e.g., give with food"
        />
      </div>
      <div>
        <Label htmlFor="medPrescribedBy">Prescribed by (optional)</Label>
        <Input
          id="medPrescribedBy"
          value={formData.prescribedBy}
          onChange={(e) => set({ prescribedBy: e.target.value })}
          placeholder="e.g., Dr. Smith"
        />
      </div>
      <EncounterLinkSelect
        encounters={encounters}
        value={formData.encounterId}
        onChange={(v) => set({ encounterId: v })}
      />
      <div>
        <Label htmlFor="medNotes">Notes (optional)</Label>
        <Textarea
          id="medNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
    </MedicalDialog>
  );
}
