"use client";

// Add/edit dialog for a significant procedure (#174) — spay/neuter,
// surgery, dental, wound care. performed_on is optional because
// historical procedures often have no known date.

import { useState } from "react";
import {
  saveProcedureAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type {
  AdminVetEncounter,
  AdminVetProcedure,
} from "@/lib/registry/medical";
import {
  PROCEDURE_KINDS,
  PROCEDURE_KIND_LABELS,
  type ProcedureKind,
} from "@/lib/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import { EncounterLinkSelect, FieldError, MedicalDialog } from "./fields";

const EMPTY_FORM = {
  kind: "other" as ProcedureKind,
  performedOn: "",
  provider: "",
  description: "",
  notes: "",
  encounterId: null as string | null,
};

const FIELD_MESSAGES: Record<string, string> = {
  description: "Describe what was done.",
  performedOn: "Enter a valid date — it can't be in the future.",
};

export function ProcedureDialog({
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
  editing: AdminVetProcedure | null;
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

  // Reset the form when the dialog (re)opens. Render-phase adjustment —
  // the documented alternative to an effect for derived state.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const base = editing
        ? {
            kind: editing.kind as ProcedureKind,
            performedOn: editing.performedOn ?? "",
            provider: editing.provider ?? "",
            description: editing.description,
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
      !window.confirm("Discard unsaved changes to this procedure?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!formData.description.trim()) {
      errors.description = FIELD_MESSAGES.description;
    }
    if (
      formData.performedOn &&
      (!isIsoDateString(formData.performedOn) || formData.performedOn > today)
    ) {
      errors.performedOn = FIELD_MESSAGES.performedOn;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveProcedureAction(
          {
            animalId,
            encounterId: formData.encounterId,
            kind: formData.kind,
            performedOn: formData.performedOn || null,
            provider: formData.provider || null,
            description: formData.description,
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
        description: editing ? "Procedure updated" : "Procedure recorded",
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
      title={editing ? "Edit procedure" : "Add procedure"}
      description={
        editing
          ? "Correct this procedure record"
          : `Record a significant procedure for ${animalName}`
      }
      submitLabel={editing ? "Update procedure" : "Add procedure"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="procKind">Type</Label>
          <Select
            value={formData.kind}
            onValueChange={(v) => set({ kind: v as ProcedureKind })}
          >
            <SelectTrigger id="procKind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROCEDURE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PROCEDURE_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="performedOn">Date (optional if unknown)</Label>
          <Input
            id="performedOn"
            type="date"
            value={formData.performedOn}
            onChange={(e) => set({ performedOn: e.target.value })}
            {...err("performedOn")}
          />
          <FieldError id="performedOn-error" message={fieldErrors.performedOn} />
        </div>
      </div>
      <div>
        <Label htmlFor="procDescription">Description</Label>
        <Input
          id="procDescription"
          value={formData.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="e.g., Ovariohysterectomy, laceration repair"
          {...err("description")}
        />
        <FieldError id="description-error" message={fieldErrors.description} />
      </div>
      <div>
        <Label htmlFor="procProvider">Provider (optional)</Label>
        <Input
          id="procProvider"
          value={formData.provider}
          onChange={(e) => set({ provider: e.target.value })}
          placeholder="e.g., Dr. Smith"
        />
      </div>
      <EncounterLinkSelect
        encounters={encounters}
        value={formData.encounterId}
        onChange={(v) => set({ encounterId: v })}
      />
      <div>
        <Label htmlFor="procNotes">Outcome / notes (optional)</Label>
        <Textarea
          id="procNotes"
          rows={3}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
    </MedicalDialog>
  );
}
