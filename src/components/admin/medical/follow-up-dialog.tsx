"use client";

// "Add follow-up" / edit dialog (#175) — standalone recheck creation
// when no full encounter is being logged (encounters also create
// rechecks inline). Edits only apply to open items; resolved rows are
// history.

import { useState } from "react";
import {
  saveFollowUpAction,
  type SaveResult,
} from "@/app/admin/vet/actions";
import type {
  AdminFollowUp,
  AdminVetEncounter,
} from "@/lib/registry/medical";
import { isIsoDateString } from "@/lib/vaccinations";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { logError } from "@/lib/logger";
import {
  EncounterLinkSelect,
  FieldError,
  MedicalDialog,
} from "./fields";

const EMPTY_FORM = {
  dueOn: "",
  reason: "",
  notes: "",
  encounterId: null as string | null,
};

const FIELD_MESSAGES: Record<string, string> = {
  dueOn: "Enter the follow-up date.",
  reason: "Say what needs to happen.",
};

export function FollowUpDialog({
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
  editing: AdminFollowUp | null;
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
            dueOn: editing.dueOn,
            reason: editing.reason ?? "",
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
      !window.confirm("Discard unsaved changes to this follow-up?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!isIsoDateString(formData.dueOn)) {
      errors.dueOn = FIELD_MESSAGES.dueOn;
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
        result = await saveFollowUpAction(
          {
            animalId,
            encounterId: formData.encounterId,
            dueOn: formData.dueOn,
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
              ? "This follow-up was changed by someone else. Reopen it to see the latest version."
              : "Failed to save. Your entries are kept — try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Success",
        description: editing ? "Follow-up updated" : "Follow-up scheduled",
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
      title={editing ? "Edit follow-up" : "Schedule follow-up"}
      description={
        editing
          ? "Correct this open follow-up"
          : `Schedule a recheck or follow-up task for ${animalName}`
      }
      submitLabel={editing ? "Update follow-up" : "Schedule follow-up"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="fuDueOn">Due date</Label>
          <Input
            id="fuDueOn"
            type="date"
            value={formData.dueOn}
            onChange={(e) => set({ dueOn: e.target.value })}
            {...err("dueOn")}
          />
          <FieldError id="dueOn-error" message={fieldErrors.dueOn} />
          {formData.dueOn && isIsoDateString(formData.dueOn) && formData.dueOn < today && (
            <p className="text-xs text-muted-foreground mt-1">
              A past date lands on the queue as overdue.
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="fuReason">What needs to happen</Label>
          <Input
            id="fuReason"
            value={formData.reason}
            onChange={(e) => set({ reason: e.target.value })}
            placeholder="e.g., suture removal, recheck limp"
            {...err("reason")}
          />
          <FieldError id="reason-error" message={fieldErrors.reason} />
        </div>
      </div>
      <div>
        <Label htmlFor="fuNotes">Notes (optional)</Label>
        <Textarea
          id="fuNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
      <EncounterLinkSelect
        encounters={encounters}
        value={formData.encounterId}
        onChange={(v) => set({ encounterId: v })}
      />
    </MedicalDialog>
  );
}
