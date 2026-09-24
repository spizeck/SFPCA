"use client";

// "Expect at clinic" / edit dialog (#194) — records that an animal is
// expected at an upcoming clinic session. This is scheduling intent,
// not a visit record and not an appointment slot: a date, an optional
// session label, and a reason. Edits only apply while the expectation
// is still 'expected'; resolved rows are history.

import { useState } from "react";
import {
  saveClinicExpectationAction,
  type SaveResult,
} from "@/app/admin/vet/actions";
import type { AdminClinicExpectation } from "@/lib/registry/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import { FieldError, MedicalDialog } from "./fields";

const EMPTY_FORM = {
  expectedOn: "",
  sessionLabel: "",
  reason: "",
  notes: "",
};

const FIELD_MESSAGES: Record<string, string> = {
  expectedOn: "Enter the expected clinic date.",
  reason: "Say why the animal is coming.",
  sessionLabel: "Keep the session label short.",
};

export function ClinicExpectationDialog({
  animalId,
  animalName,
  editing,
  open,
  onOpenChange,
  onSaved,
}: {
  animalId: string;
  animalName: string;
  editing: AdminClinicExpectation | null;
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
            expectedOn: editing.expectedOn,
            sessionLabel: editing.sessionLabel ?? "",
            reason: editing.reason,
            notes: editing.notes ?? "",
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
      !window.confirm("Discard unsaved changes to this expectation?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!isIsoDateString(formData.expectedOn)) {
      errors.expectedOn = FIELD_MESSAGES.expectedOn;
    }
    if (!formData.reason.trim()) {
      errors.reason = FIELD_MESSAGES.reason;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveClinicExpectationAction(
          {
            animalId,
            expectedOn: formData.expectedOn,
            sessionLabel: formData.sessionLabel || null,
            reason: formData.reason,
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
              ? "This expectation was changed by someone else. Reopen it to see the latest version."
              : "Failed to save. Your entries are kept — try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Success",
        description: editing
          ? "Expectation updated"
          : `${animalName} expected at clinic`,
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
      title={editing ? "Edit clinic expectation" : "Expect at clinic"}
      description={
        editing
          ? "Correct this unresolved expectation"
          : `Record that ${animalName} is expected at an upcoming clinic session`
      }
      submitLabel={editing ? "Update expectation" : "Expect at clinic"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="ceExpectedOn">Expected date</Label>
          <Input
            id="ceExpectedOn"
            type="date"
            value={formData.expectedOn}
            onChange={(e) => set({ expectedOn: e.target.value })}
            {...err("expectedOn")}
          />
          <FieldError id="expectedOn-error" message={fieldErrors.expectedOn} />
        </div>
        <div>
          <Label htmlFor="ceSession">Session (optional)</Label>
          <Input
            id="ceSession"
            value={formData.sessionLabel}
            onChange={(e) => set({ sessionLabel: e.target.value })}
            placeholder="e.g., Saturday AM clinic"
            {...err("sessionLabel")}
          />
          <FieldError id="sessionLabel-error" message={fieldErrors.sessionLabel} />
        </div>
      </div>
      <div>
        <Label htmlFor="ceReason">Why they&apos;re coming</Label>
        <Input
          id="ceReason"
          value={formData.reason}
          onChange={(e) => set({ reason: e.target.value })}
          placeholder="e.g., vaccination visit, post-op check"
          {...err("reason")}
        />
        <FieldError id="reason-error" message={fieldErrors.reason} />
      </div>
      <div>
        <Label htmlFor="ceNotes">Notes (optional)</Label>
        <Textarea
          id="ceNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
    </MedicalDialog>
  );
}
