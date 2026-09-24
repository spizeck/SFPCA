"use client";

// Add/edit dialog for a medical alert (#174). Alerts persist
// prominently on the record until resolved — resolution is an audited
// update (status + resolved_on), never a delete.

import { useState } from "react";
import {
  saveAlertAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type { AdminMedicalAlert } from "@/lib/registry/medical";
import {
  ALERT_KINDS,
  ALERT_KIND_LABELS,
  ALERT_SEVERITIES,
  ALERT_SEVERITY_LABELS,
  type AlertKind,
  type AlertSeverity,
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
import { FieldError, MedicalDialog } from "./fields";

const EMPTY_FORM = {
  kind: "condition" as AlertKind,
  severity: "important" as AlertSeverity,
  summary: "",
  details: "",
  recordedOn: "",
  status: "active" as "active" | "resolved",
  resolvedOn: "",
};

const FIELD_MESSAGES: Record<string, string> = {
  summary: "Describe the alert (e.g. “Penicillin allergy”).",
  recordedOn: "Enter the date this was recorded — it can't be in the future.",
  resolvedOn: "Enter the date it was resolved (on or after recorded date).",
};

export function AlertDialog({
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
  editing: AdminMedicalAlert | null;
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
            kind: editing.kind as AlertKind,
            severity: editing.severity as AlertSeverity,
            summary: editing.summary,
            details: editing.details ?? "",
            recordedOn: editing.recordedOn,
            status: editing.status as "active" | "resolved",
            resolvedOn: editing.resolvedOn ?? "",
          }
        : { ...EMPTY_FORM, recordedOn: today };
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
      !window.confirm("Discard unsaved changes to this alert?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!formData.summary.trim()) errors.summary = FIELD_MESSAGES.summary;
    if (
      !isIsoDateString(formData.recordedOn) ||
      formData.recordedOn > today
    ) {
      errors.recordedOn = FIELD_MESSAGES.recordedOn;
    }
    if (formData.status === "resolved") {
      if (
        !isIsoDateString(formData.resolvedOn) ||
        formData.resolvedOn < formData.recordedOn
      ) {
        errors.resolvedOn = FIELD_MESSAGES.resolvedOn;
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    mutation.run(async () => {
      let result: SaveResult;
      try {
        result = await saveAlertAction(
          {
            animalId,
            encounterId: editing?.encounterId ?? null,
            kind: formData.kind,
            severity: formData.severity,
            summary: formData.summary,
            details: formData.details || null,
            recordedOn: formData.recordedOn,
            status: formData.status,
            resolvedOn:
              formData.status === "resolved" ? formData.resolvedOn : null,
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
        description: editing ? "Alert updated" : "Alert added",
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
      title={editing ? "Edit alert" : "Add alert"}
      description={
        editing
          ? "Update or resolve this medical alert"
          : `Record an important alert for ${animalName} (allergy, contraindication, condition)`
      }
      submitLabel={editing ? "Update alert" : "Add alert"}
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="alertKind">Type</Label>
          <Select
            value={formData.kind}
            onValueChange={(v) => set({ kind: v as AlertKind })}
          >
            <SelectTrigger id="alertKind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALERT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {ALERT_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="alertSeverity">Severity</Label>
          <Select
            value={formData.severity}
            onValueChange={(v) => set({ severity: v as AlertSeverity })}
          >
            <SelectTrigger id="alertSeverity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALERT_SEVERITIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ALERT_SEVERITY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="alertSummary">Alert</Label>
        <Input
          id="alertSummary"
          value={formData.summary}
          onChange={(e) => set({ summary: e.target.value })}
          placeholder="e.g., Penicillin allergy"
          {...err("summary")}
        />
        <FieldError id="summary-error" message={fieldErrors.summary} />
      </div>
      <div>
        <Label htmlFor="alertDetails">Details (optional)</Label>
        <Textarea
          id="alertDetails"
          rows={3}
          value={formData.details}
          onChange={(e) => set({ details: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="alertRecordedOn">Recorded on</Label>
          <Input
            id="alertRecordedOn"
            type="date"
            value={formData.recordedOn}
            onChange={(e) => set({ recordedOn: e.target.value })}
            {...err("recordedOn")}
          />
          <FieldError id="recordedOn-error" message={fieldErrors.recordedOn} />
        </div>
        {editing && (
          <div>
            <Label htmlFor="alertStatus">Status</Label>
            <Select
              value={formData.status}
              onValueChange={(v) =>
                set({
                  status: v as "active" | "resolved",
                  resolvedOn: v === "resolved" ? formData.resolvedOn : "",
                })
              }
            >
              <SelectTrigger id="alertStatus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {editing && formData.status === "resolved" && (
        <div>
          <Label htmlFor="alertResolvedOn">Resolved on</Label>
          <Input
            id="alertResolvedOn"
            type="date"
            value={formData.resolvedOn}
            onChange={(e) => set({ resolvedOn: e.target.value })}
            {...err("resolvedOn")}
          />
          <FieldError id="resolvedOn-error" message={fieldErrors.resolvedOn} />
        </div>
      )}
    </MedicalDialog>
  );
}
