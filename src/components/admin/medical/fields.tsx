"use client";

// Shared building blocks for the medical-record dialogs (#174):
// the field-error line, the dialog shell, and the encounter-link
// select. Keeping these tiny and shared is what lets each entry dialog
// stay concise.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { AdminVetEncounter } from "@/lib/registry/medical";

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-red-600 mt-1">
      {message}
    </p>
  );
}

export function MedicalDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {children}
          <Button
            onClick={onSubmit}
            className="w-full"
            disabled={pending}
          >
            {pending ? "Saving…" : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NONE = "__none__";

// "Which visit was this part of?" — optional link for vaccinations,
// procedures, medications, weights. Standalone records stay legal
// (historical/external data has no SFPCA visit).
export function EncounterLinkSelect({
  encounters,
  value,
  onChange,
}: {
  encounters: AdminVetEncounter[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <div>
      <Label htmlFor="encounterId">Linked visit (optional)</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger id="encounterId">
          <SelectValue placeholder="Not linked to a visit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not linked to a visit</SelectItem>
          {encounters.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.occurredOn} — {e.reason ?? "Visit"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
