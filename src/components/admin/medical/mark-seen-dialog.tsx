"use client";

// "Mark seen" dialog (#194) — resolves an expected clinic attendance
// and optionally links the real vet_encounters row that fulfilled it.
// The link is optional and only references an existing encounter: if
// the animal arrived but no visit has been logged yet, 'seen' still
// works — this dialog never manufactures clinical facts.

import { useState } from "react";
import {
  markClinicSeenAction,
} from "@/app/admin/vet/actions";
import type {
  AdminClinicExpectation,
  AdminVetEncounter,
} from "@/lib/registry/medical";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { EncounterLinkSelect } from "./fields";

export function MarkSeenDialog({
  expectation,
  animalName,
  encounters,
  open,
  onOpenChange,
  onResolved,
}: {
  expectation: AdminClinicExpectation | null;
  animalName: string;
  encounters: AdminVetEncounter[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const [encounterId, setEncounterId] = useState<string | null>(null);
  const mutation = useMutation();
  const { toast } = useToast();

  const confirm = () => {
    if (!expectation) return;
    mutation.run(async () => {
      try {
        const result = await markClinicSeenAction(
          expectation.id,
          expectation.updatedAt,
          encounterId,
        );
        if (result.ok) {
          toast({
            title: "Done",
            description: `${animalName} marked seen.`,
          });
          setEncounterId(null);
          onOpenChange(false);
          onResolved();
          return;
        }
        toast({
          title: "Error",
          description:
            result.reason === "conflict"
              ? "This expectation was already changed by someone else. Reload to see the latest state."
              : result.reason === "invalid"
                ? "That visit doesn't belong to this animal. Pick another or leave it unlinked."
                : "Failed to save. Try again.",
          variant: "destructive",
        });
      } catch {
        toast({
          title: "Error",
          description: "Failed to save. Try again.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {animalName} seen</DialogTitle>
          <DialogDescription>
            Confirms the animal came in for &quot;{expectation?.reason}
            &quot; on {expectation?.expectedOn}. Optionally link the visit
            record — leave unlinked if it hasn&apos;t been logged yet.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <EncounterLinkSelect
            encounters={encounters}
            value={encounterId}
            onChange={setEncounterId}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.pending}
            autoFocus
          >
            Back
          </Button>
          <Button onClick={confirm} disabled={mutation.pending}>
            {mutation.pending ? "Saving…" : "Mark seen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
