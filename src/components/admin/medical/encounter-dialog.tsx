"use client";

// "Log visit" / add-note dialog (#174) — the primary entry point of the
// medical record. On create it can also capture the weight taken at the
// visit and schedule a recheck, so one form covers the common visit
// workflow without extra screens. On edit only the encounter fields are
// editable — the weight/follow-up rows are their own records.

import { useState } from "react";
import {
  saveEncounterAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type { AdminVetEncounter } from "@/lib/registry/medical";
import {
  ENCOUNTER_KINDS,
  ENCOUNTER_KIND_LABELS,
  parseWeightToGrams,
  type EncounterKind,
} from "@/lib/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Checkbox } from "@/components/ui/checkbox";
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

const EMPTY_FORM = {
  kind: "visit" as EncounterKind,
  occurredOn: "",
  provider: "",
  reason: "",
  complaint: "",
  findings: "",
  assessment: "",
  plan: "",
  notes: "",
  weightValue: "",
  weightUnit: "kg" as "kg" | "lb",
  scheduleRecheck: false,
  recheckDueOn: "",
  recheckReason: "",
};

const FIELD_MESSAGES: Record<string, string> = {
  occurredOn: "Enter the date — it can't be in the future.",
  reason: "Say why the animal was seen (required for a visit).",
  weightGrams: "Enter a plausible weight.",
  followUpDueOn: "Enter the recheck date.",
  followUpReason: "Say what the recheck is for.",
};

export function EncounterDialog({
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
  editing: AdminVetEncounter | null;
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
            kind: editing.kind as EncounterKind,
            occurredOn: editing.occurredOn,
            provider: editing.provider ?? "",
            reason: editing.reason ?? "",
            complaint: editing.complaint ?? "",
            findings: editing.findings ?? "",
            assessment: editing.assessment ?? "",
            plan: editing.plan ?? "",
            notes: editing.notes ?? "",
            weightValue: "",
            weightUnit: "kg" as const,
            scheduleRecheck: false,
            recheckDueOn: "",
            recheckReason: "",
          }
        : { ...EMPTY_FORM, occurredOn: today };
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
      !window.confirm("Discard unsaved changes to this entry?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!isIsoDateString(formData.occurredOn) || formData.occurredOn > today) {
      errors.occurredOn = FIELD_MESSAGES.occurredOn;
    }
    if (formData.kind === "visit" && !formData.reason.trim()) {
      errors.reason = FIELD_MESSAGES.reason;
    }
    if (
      !editing &&
      formData.weightValue.trim() &&
      parseWeightToGrams(formData.weightValue, formData.weightUnit) === null
    ) {
      errors.weightGrams = FIELD_MESSAGES.weightGrams;
    }
    if (!editing && formData.scheduleRecheck) {
      if (!isIsoDateString(formData.recheckDueOn)) {
        errors.followUpDueOn = FIELD_MESSAGES.followUpDueOn;
      }
      if (!formData.recheckReason.trim()) {
        errors.followUpReason = FIELD_MESSAGES.followUpReason;
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const weightGrams =
      !editing && formData.weightValue.trim()
        ? parseWeightToGrams(formData.weightValue, formData.weightUnit)
        : null;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveEncounterAction(
          {
            animalId,
            kind: formData.kind,
            occurredOn: formData.occurredOn,
            provider: formData.provider || null,
            reason: formData.reason || null,
            complaint: formData.complaint || null,
            findings: formData.findings || null,
            assessment: formData.assessment || null,
            plan: formData.plan || null,
            notes: formData.notes || null,
            weightGrams,
            followUp:
              !editing && formData.scheduleRecheck
                ? {
                    dueOn: formData.recheckDueOn,
                    reason: formData.recheckReason,
                  }
                : null,
          },
          editing?.id ?? null,
          editing?.updatedAt,
        );
      } catch (error) {
        logError("medical", "admin-save", error);
        toast({
          title: "Error",
          description:
            "Failed to save. Your entries are kept — try again.",
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
        description: editing ? "Entry updated" : "Entry recorded",
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
  const titles: Record<EncounterKind, string> = {
    visit: "Log visit",
    history: "Add history",
    note: "Add note",
  };
  const title = editing ? "Edit entry" : titles[formData.kind];

  return (
    <MedicalDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={
        editing
          ? "Correct this record"
          : `Record clinical history for ${animalName}`
      }
      submitLabel={editing ? "Update entry" : "Save entry"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="encKind">Entry type</Label>
          <Select
            value={formData.kind}
            onValueChange={(v) => set({ kind: v as EncounterKind })}
          >
            <SelectTrigger id="encKind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENCOUNTER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {ENCOUNTER_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="occurredOn">Date</Label>
          <Input
            id="occurredOn"
            type="date"
            value={formData.occurredOn}
            onChange={(e) => set({ occurredOn: e.target.value })}
            {...err("occurredOn")}
          />
          <FieldError id="occurredOn-error" message={fieldErrors.occurredOn} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="encReason">
            Reason {formData.kind === "visit" ? "" : "(optional)"}
          </Label>
          <Input
            id="encReason"
            value={formData.reason}
            onChange={(e) => set({ reason: e.target.value })}
            placeholder="e.g., annual check, limping"
            {...err("reason")}
          />
          <FieldError id="reason-error" message={fieldErrors.reason} />
        </div>
        <div>
          <Label htmlFor="encProvider">Provider (optional)</Label>
          <Input
            id="encProvider"
            value={formData.provider}
            onChange={(e) => set({ provider: e.target.value })}
            placeholder="e.g., Dr. Smith"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="encComplaint">Complaint / history (optional)</Label>
        <Textarea
          id="encComplaint"
          rows={2}
          value={formData.complaint}
          onChange={(e) => set({ complaint: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="encFindings">Examination findings (optional)</Label>
        <Textarea
          id="encFindings"
          rows={2}
          value={formData.findings}
          onChange={(e) => set({ findings: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="encAssessment">Assessment (optional)</Label>
          <Textarea
            id="encAssessment"
            rows={2}
            value={formData.assessment}
            onChange={(e) => set({ assessment: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="encPlan">Plan (optional)</Label>
          <Textarea
            id="encPlan"
            rows={2}
            value={formData.plan}
            onChange={(e) => set({ plan: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="encNotes">Notes (optional)</Label>
        <Textarea
          id="encNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
      {!editing && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="encWeight">Weight at visit (optional)</Label>
              <Input
                id="encWeight"
                inputMode="decimal"
                value={formData.weightValue}
                onChange={(e) => set({ weightValue: e.target.value })}
                placeholder="e.g., 12.4"
                {...err("weightGrams")}
              />
              <FieldError
                id="weightGrams-error"
                message={fieldErrors.weightGrams}
              />
            </div>
            <div>
              <Label htmlFor="encWeightUnit">Unit</Label>
              <Select
                value={formData.weightUnit}
                onValueChange={(v) => set({ weightUnit: v as "kg" | "lb" })}
              >
                <SelectTrigger id="encWeightUnit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kg">kg</SelectItem>
                  <SelectItem value="lb">lb</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="scheduleRecheck"
              checked={formData.scheduleRecheck}
              onCheckedChange={(c) => set({ scheduleRecheck: c === true })}
            />
            <Label htmlFor="scheduleRecheck" className="font-normal">
              Schedule a recheck / follow-up
            </Label>
          </div>
          {formData.scheduleRecheck && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="recheckDueOn">Recheck date</Label>
                <Input
                  id="recheckDueOn"
                  type="date"
                  value={formData.recheckDueOn}
                  onChange={(e) => set({ recheckDueOn: e.target.value })}
                  {...err("followUpDueOn")}
                />
                <FieldError
                  id="followUpDueOn-error"
                  message={fieldErrors.followUpDueOn}
                />
              </div>
              <div>
                <Label htmlFor="recheckReason">Recheck for</Label>
                <Input
                  id="recheckReason"
                  value={formData.recheckReason}
                  onChange={(e) => set({ recheckReason: e.target.value })}
                  placeholder="e.g., suture removal"
                  {...err("followUpReason")}
                />
                <FieldError
                  id="followUpReason-error"
                  message={fieldErrors.followUpReason}
                />
              </div>
            </div>
          )}
        </>
      )}
    </MedicalDialog>
  );
}
