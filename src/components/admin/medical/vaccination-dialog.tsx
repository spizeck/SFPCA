"use client";

// Add/edit dialog for a vaccination record (#173), extracted from the
// medical-record page in #174 and extended with the optional encounter
// link. Field labels are load-bearing — tests and e2e rely on them.

import { useState } from "react";
import {
  saveVaccinationAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type { AdminVaccination } from "@/lib/registry/vaccinations";
import type { AdminVetEncounter } from "@/lib/registry/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import { EncounterLinkSelect, FieldError, MedicalDialog } from "./fields";

const EMPTY_FORM = {
  vaccineName: "",
  administeredOn: "",
  dueOn: "",
  validUntil: "",
  administeredBy: "",
  productName: "",
  manufacturer: "",
  lotNumber: "",
  notes: "",
  encounterId: null as string | null,
};

const FIELD_MESSAGES: Record<string, string> = {
  vaccineName: "Enter the vaccine name (e.g. Rabies, DHPP).",
  administeredOn:
    "Enter the date the dose was given — it can't be in the future.",
  dueOn: "Next-due date can't be before the administered date.",
  validUntil: "Expiry date can't be before the administered date.",
};

export function VaccinationDialog({
  animalId,
  animalName,
  encounters,
  editing,
  open,
  onOpenChange,
  onSaved,
  today,
}: {
  animalId: string;
  animalName: string;
  encounters: AdminVetEncounter[];
  editing: AdminVaccination | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  today: string;
}) {
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialJson, setInitialJson] = useState(() =>
    JSON.stringify(EMPTY_FORM),
  );
  const mutation = useMutation();
  const { toast } = useToast();

  // Reinitialize the form whenever the dialog opens for a different
  // record (or a fresh create).
  // Reset the form when the dialog (re)opens. Render-phase adjustment —
  // the documented alternative to an effect for derived state.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const base = editing
        ? {
            vaccineName: editing.vaccineName,
            administeredOn: editing.administeredOn,
            dueOn: editing.dueOn ?? "",
            validUntil: editing.validUntil ?? "",
            administeredBy: editing.administeredBy ?? "",
            productName: editing.productName ?? "",
            manufacturer: editing.manufacturer ?? "",
            lotNumber: editing.lotNumber ?? "",
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
      !window.confirm("Discard unsaved changes to this vaccination?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!formData.vaccineName.trim()) {
      errors.vaccineName = FIELD_MESSAGES.vaccineName;
    }
    if (!isIsoDateString(formData.administeredOn)) {
      errors.administeredOn = "Enter the date the dose was given.";
    } else if (formData.administeredOn > today) {
      errors.administeredOn = FIELD_MESSAGES.administeredOn;
    }
    if (
      formData.dueOn &&
      (!isIsoDateString(formData.dueOn) ||
        formData.dueOn < formData.administeredOn)
    ) {
      errors.dueOn = FIELD_MESSAGES.dueOn;
    }
    if (
      formData.validUntil &&
      (!isIsoDateString(formData.validUntil) ||
        formData.validUntil < formData.administeredOn)
    ) {
      errors.validUntil = FIELD_MESSAGES.validUntil;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveVaccinationAction(
          {
            animalId,
            encounterId: formData.encounterId,
            vaccineName: formData.vaccineName,
            administeredOn: formData.administeredOn,
            dueOn: formData.dueOn || null,
            validUntil: formData.validUntil || null,
            administeredBy: formData.administeredBy || null,
            productName: formData.productName || null,
            manufacturer: formData.manufacturer || null,
            lotNumber: formData.lotNumber || null,
            notes: formData.notes || null,
          },
          editing?.id ?? null,
          editing?.updatedAt,
        );
      } catch (error) {
        logError("vaccinations", "admin-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save vaccination. Your entries are kept — try again.",
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
              : "Failed to save vaccination. Your entries are kept — try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Success",
        description: editing ? "Vaccination updated" : "Vaccination added",
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
      title={editing ? "Edit vaccination" : "Add vaccination"}
      description={
        editing
          ? "Correct this vaccination record"
          : `Record a dose given to ${animalName}`
      }
      submitLabel={editing ? "Update vaccination" : "Add vaccination"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div>
        <Label htmlFor="vaccineName">Vaccine</Label>
        <Input
          id="vaccineName"
          value={formData.vaccineName}
          onChange={(e) => set({ vaccineName: e.target.value })}
          placeholder="e.g., Rabies, DHPP, FVRCP"
          {...err("vaccineName")}
        />
        <FieldError id="vaccineName-error" message={fieldErrors.vaccineName} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label htmlFor="administeredOn">Date given</Label>
          <Input
            id="administeredOn"
            type="date"
            value={formData.administeredOn}
            onChange={(e) => set({ administeredOn: e.target.value })}
            {...err("administeredOn")}
          />
          <FieldError
            id="administeredOn-error"
            message={fieldErrors.administeredOn}
          />
        </div>
        <div>
          <Label htmlFor="dueOn">Next due</Label>
          <Input
            id="dueOn"
            type="date"
            value={formData.dueOn}
            onChange={(e) => set({ dueOn: e.target.value })}
            {...err("dueOn")}
          />
          <FieldError id="dueOn-error" message={fieldErrors.dueOn} />
        </div>
        <div>
          <Label htmlFor="validUntil">Valid until</Label>
          <Input
            id="validUntil"
            type="date"
            value={formData.validUntil}
            onChange={(e) => set({ validUntil: e.target.value })}
            {...err("validUntil")}
          />
          <FieldError id="validUntil-error" message={fieldErrors.validUntil} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="administeredBy">Given by (optional)</Label>
          <Input
            id="administeredBy"
            value={formData.administeredBy}
            onChange={(e) => set({ administeredBy: e.target.value })}
            placeholder="e.g., Dr. Smith"
          />
        </div>
        <div>
          <Label htmlFor="lotNumber">Lot/batch no. (optional)</Label>
          <Input
            id="lotNumber"
            value={formData.lotNumber}
            onChange={(e) => set({ lotNumber: e.target.value })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="productName">Product (optional)</Label>
          <Input
            id="productName"
            value={formData.productName}
            onChange={(e) => set({ productName: e.target.value })}
            placeholder="e.g., Nobivac Rabies"
          />
        </div>
        <div>
          <Label htmlFor="manufacturer">Manufacturer (optional)</Label>
          <Input
            id="manufacturer"
            value={formData.manufacturer}
            onChange={(e) => set({ manufacturer: e.target.value })}
          />
        </div>
      </div>
      <EncounterLinkSelect
        encounters={encounters}
        value={formData.encounterId}
        onChange={(v) => set({ encounterId: v })}
      />
      <div>
        <Label htmlFor="vaxNotes">Notes (optional)</Label>
        <Textarea
          id="vaxNotes"
          rows={3}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
    </MedicalDialog>
  );
}
