"use client";

// Add/edit dialog for a weight record (#174). Staff enter kg or lb;
// the record stores integer grams — the value is converted here and
// again server-side.

import { useState } from "react";
import {
  saveWeightAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type { AdminWeightRecord } from "@/lib/registry/medical";
import { parseWeightToGrams } from "@/lib/medical";
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
import { FieldError, MedicalDialog } from "./fields";

const FIELD_MESSAGES: Record<string, string> = {
  measuredOn: "Enter the date weighed — it can't be in the future.",
  weightGrams: "Enter a plausible weight.",
};

export function WeightDialog({
  animalId,
  animalName,
  editing,
  open,
  onOpenChange,
  onSaved,
  today,
}: {
  animalId: string;
  animalName: string;
  editing: AdminWeightRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  today: string;
}) {
  const [formData, setFormData] = useState({
    measuredOn: "",
    weightValue: "",
    weightUnit: "kg" as "kg" | "lb",
    notes: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialJson, setInitialJson] = useState("");
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
            measuredOn: editing.measuredOn,
            weightValue: (editing.weightGrams / 1000).toString(),
            weightUnit: "kg" as const,
            notes: editing.notes ?? "",
          }
        : {
            measuredOn: today,
            weightValue: "",
            weightUnit: "kg" as const,
            notes: "",
          };
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
      !window.confirm("Discard unsaved changes to this weight?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const grams = () =>
    parseWeightToGrams(formData.weightValue, formData.weightUnit);

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!isIsoDateString(formData.measuredOn) || formData.measuredOn > today) {
      errors.measuredOn = FIELD_MESSAGES.measuredOn;
    }
    if (grams() === null) errors.weightGrams = FIELD_MESSAGES.weightGrams;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveWeightAction(
          {
            animalId,
            encounterId: editing?.encounterId ?? null,
            measuredOn: formData.measuredOn,
            weightGrams: grams()!,
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
        description: editing ? "Weight updated" : "Weight recorded",
      });
      onOpenChange(false);
      onSaved();
    });
  };

  const set = (patch: Partial<typeof formData>) =>
    setFormData({ ...formData, ...patch });
  const err = (f: string) => ({
    "aria-invalid": !!fieldErrors[f],
    "aria-describedby": fieldErrors[f] ? `${f}-error` : undefined,
  });

  return (
    <MedicalDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={editing ? "Edit weight" : "Add weight"}
      description={
        editing
          ? "Correct this weight record"
          : `Record a weight for ${animalName}`
      }
      submitLabel={editing ? "Update weight" : "Add weight"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label htmlFor="weightDate">Date</Label>
          <Input
            id="weightDate"
            type="date"
            value={formData.measuredOn}
            onChange={(e) => set({ measuredOn: e.target.value })}
            {...err("measuredOn")}
          />
          <FieldError id="measuredOn-error" message={fieldErrors.measuredOn} />
        </div>
        <div>
          <Label htmlFor="weightValue">Weight</Label>
          <Input
            id="weightValue"
            inputMode="decimal"
            value={formData.weightValue}
            onChange={(e) => set({ weightValue: e.target.value })}
            placeholder="e.g., 12.4"
            {...err("weightGrams")}
          />
          <FieldError id="weightGrams-error" message={fieldErrors.weightGrams} />
        </div>
        <div>
          <Label htmlFor="weightUnit">Unit</Label>
          <Select
            value={formData.weightUnit}
            onValueChange={(v) => set({ weightUnit: v as "kg" | "lb" })}
          >
            <SelectTrigger id="weightUnit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="kg">kg</SelectItem>
              <SelectItem value="lb">lb</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="weightNotes">Notes (optional)</Label>
        <Textarea
          id="weightNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="e.g., BCS 4/9"
        />
      </div>
    </MedicalDialog>
  );
}
