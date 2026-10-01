"use client";

// Clinical-document upload dialog (#192). The file goes straight from
// the staff member's browser to vet-docs/ under the admin-claim create
// rule; once the upload lands, registerVetDocumentAction verifies the
// object and writes the vet_documents row. An upload whose registration
// never completes is an orphan — the nightly sweep removes it.

import { useState } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase";
import {
  registerVetDocumentAction,
  type SaveResult,
} from "@/app/admin/animals/[id]/actions";
import type {
  AdminVetEncounter,
} from "@/lib/registry/medical";
import type { AdminVaccination } from "@/lib/registry/vaccinations";
import {
  isVetDocumentFile,
  vetDocStoragePath,
  VET_DOC_MAX_BYTES,
} from "@/lib/medical";
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
import {
  EncounterLinkSelect,
  FieldError,
  MedicalDialog,
} from "./fields";

const NONE = "__none__";

const FIELD_MESSAGES: Record<string, string> = {
  file: `Choose an image or PDF under ${Math.round(VET_DOC_MAX_BYTES / (1024 * 1024))} MB.`,
  label: "Give the document a short label (e.g. “Rabies certificate”).",
  notes: "Keep the note under 2000 characters.",
  storagePath: "The upload path was rejected — try the upload again.",
  encounterId: "That visit belongs to a different animal.",
  vaccinationId: "That vaccination belongs to a different animal.",
};

function VaccinationLinkSelect({
  vaccinations,
  value,
  onChange,
}: {
  vaccinations: AdminVaccination[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <div>
      <Label htmlFor="vaccinationId">Linked vaccination (optional)</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger id="vaccinationId">
          <SelectValue placeholder="Not linked to a vaccination" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not linked to a vaccination</SelectItem>
          {vaccinations.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.administeredOn} — {v.vaccineName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DocumentUploadDialog({
  animalId,
  animalName,
  encounters,
  vaccinations,
  open,
  onOpenChange,
  onSaved,
}: {
  animalId: string;
  animalName: string;
  encounters: AdminVetEncounter[];
  vaccinations: AdminVaccination[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [formData, setFormData] = useState({
    label: "",
    notes: "",
    encounterId: null as string | null,
    vaccinationId: null as string | null,
  });
  const [file, setFile] = useState<File | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [initialJson, setInitialJson] = useState("");
  // Remounts the file input on each open so a previous selection never
  // survives a close/reopen.
  const [resetKey, setResetKey] = useState(0);
  const mutation = useMutation();
  const { toast } = useToast();

  // Reset the form when the dialog (re)opens. Render-phase adjustment —
  // the documented alternative to an effect for derived state.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const base = {
        label: "",
        notes: "",
        encounterId: null,
        vaccinationId: null,
      };
      setFormData(base);
      setInitialJson(JSON.stringify(base));
      setFile(null);
      setResetKey((k) => k + 1);
      setFieldErrors({});
    }
  }

  const formDirty = JSON.stringify(formData) !== initialJson || file !== null;

  const handleOpenChange = (next: boolean) => {
    if (
      !next &&
      formDirty &&
      !window.confirm("Discard this document upload?")
    ) {
      return;
    }
    onOpenChange(next);
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!file || !isVetDocumentFile(file)) {
      errors.file = FIELD_MESSAGES.file;
    }
    if (!formData.label.trim() || formData.label.length > 200) {
      errors.label = FIELD_MESSAGES.label;
    }
    if (formData.notes.length > 2000) errors.notes = FIELD_MESSAGES.notes;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate() || !file) return;
    mutation.run(async () => {
      // Upload first so the storage path is real before the row exists —
      // a failed upload leaves no dangling document record.
      const storagePath = vetDocStoragePath(file.name);
      try {
        await uploadBytes(ref(storage, storagePath), file, {
          contentType: file.type,
        });
      } catch (error) {
        logError("medical", "document-upload", error);
        toast({
          title: "Upload failed",
          description: "The file could not be uploaded. Try again.",
          variant: "destructive",
        });
        return;
      }

      let result: SaveResult;
      try {
        result = await registerVetDocumentAction({
          animalId,
          storagePath,
          label: formData.label,
          notes: formData.notes || null,
          encounterId: formData.encounterId,
          vaccinationId: formData.vaccinationId,
        });
      } catch (error) {
        logError("medical", "admin-save", error);
        toast({
          title: "Error",
          description:
            "The file uploaded but the record could not be saved. Try again — the same file can be re-submitted safely.",
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
            "The file uploaded but the record could not be saved. Try again — the same file can be re-submitted safely.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Success",
        description: "Document added to the clinical record",
      });
      onOpenChange(false);
      onSaved();
    });
  };

  const set = (patch: Partial<typeof formData>) =>
    setFormData({ ...formData, ...patch });

  return (
    <MedicalDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Upload clinical document"
      description={`Attach a lab report, certificate, or referral document to ${animalName}'s record. Images and PDFs under ${Math.round(VET_DOC_MAX_BYTES / (1024 * 1024))} MB.`}
      submitLabel="Upload document"
      pending={mutation.pending}
      onSubmit={handleSubmit}
    >
      <div>
        <Label htmlFor="documentFile">File</Label>
        <Input
          key={resetKey}
          id="documentFile"
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-invalid={!!fieldErrors.file}
          aria-describedby={fieldErrors.file ? "file-error" : undefined}
        />
        <FieldError id="file-error" message={fieldErrors.file} />
      </div>
      <div>
        <Label htmlFor="documentLabel">Label</Label>
        <Input
          id="documentLabel"
          value={formData.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="e.g., Rabies certificate"
          aria-invalid={!!fieldErrors.label}
          aria-describedby={fieldErrors.label ? "label-error" : undefined}
        />
        <FieldError id="label-error" message={fieldErrors.label} />
      </div>
      <EncounterLinkSelect
        encounters={encounters}
        value={formData.encounterId}
        onChange={(v) => set({ encounterId: v })}
      />
      <VaccinationLinkSelect
        vaccinations={vaccinations}
        value={formData.vaccinationId}
        onChange={(v) => set({ vaccinationId: v })}
      />
      <div>
        <Label htmlFor="documentNotes">Notes (optional)</Label>
        <Textarea
          id="documentNotes"
          rows={2}
          value={formData.notes}
          onChange={(e) => set({ notes: e.target.value })}
          aria-invalid={!!fieldErrors.notes}
          aria-describedby={fieldErrors.notes ? "notes-error" : undefined}
        />
        <FieldError id="notes-error" message={fieldErrors.notes} />
      </div>
    </MedicalDialog>
  );
}
