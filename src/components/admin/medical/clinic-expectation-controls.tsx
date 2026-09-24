"use client";

// Shared clinic-expectation UI (#194): the derived-state badge and the
// seen/no-show/cancel controls. Used by the /admin/vet work queue and
// the per-animal medical record — one component so both surfaces
// resolve expectations identically.
//
// Seen is a one-tap action (or delegated to `onMarkSeen` when a
// surface offers the optional encounter link — the animal record does,
// the queue does not). No-show and cancel confirm because they remove
// the item from everyone's queue; the record itself is preserved —
// nothing is deleted. `updatedAt` is the rendered row's
// optimistic-concurrency token; a stale view surfaces "conflict"
// instead of double-resolving.

import { useState } from "react";
import {
  cancelClinicExpectationAction,
  markClinicNoShowAction,
  markClinicSeenAction,
} from "@/app/admin/vet/actions";
import {
  CLINIC_EXPECTATION_STATE_LABELS,
  type ClinicExpectationState,
} from "@/lib/medical";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { Check, UserX, X } from "lucide-react";

// Color supports the text but never carries meaning alone — the label
// always spells out the state.
const STATE_CLASSES: Record<ClinicExpectationState, string> = {
  overdue: "bg-red-100 text-red-800",
  due: "bg-amber-100 text-amber-800",
  upcoming: "bg-blue-100 text-blue-800",
  seen: "bg-green-100 text-green-800",
  no_show: "bg-orange-100 text-orange-800",
  cancelled: "bg-gray-100 text-gray-800",
};

export function ClinicExpectationStateBadge({
  state,
}: {
  state: ClinicExpectationState;
}) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATE_CLASSES[state]}`}
    >
      {CLINIC_EXPECTATION_STATE_LABELS[state]}
    </span>
  );
}

type Pending = "no_show" | "cancelled" | null;

export function ClinicExpectationResolveButtons({
  expectationId,
  updatedAt,
  label,
  onResolved,
  onMarkSeen,
}: {
  expectationId: string;
  updatedAt: string;
  // Identifies the item in dialogs/labels — e.g. "Vaccination visit — Rex".
  label: string;
  onResolved: () => void;
  // When provided, the Seen button delegates (e.g. the animal record
  // opens a dialog offering the optional encounter link). When absent,
  // Seen is a plain one-tap transition.
  onMarkSeen?: () => void;
}) {
  const mutation = useMutation();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<Pending>(null);

  const reportResult = (
    ok: boolean,
    reason: string | undefined,
    pastTense: string,
  ) => {
    if (ok) {
      toast({ title: "Done", description: `Expectation ${pastTense}.` });
      onResolved();
      return;
    }
    toast({
      title: "Error",
      description:
        reason === "conflict"
          ? "This expectation was already changed by someone else. Reload to see the latest state."
          : "Failed to save. Try again.",
      variant: "destructive",
    });
  };

  const seen = () =>
    mutation.run(async () => {
      try {
        const result = await markClinicSeenAction(expectationId, updatedAt);
        reportResult(result.ok, result.reason, "marked seen");
      } catch {
        toast({
          title: "Error",
          description: "Failed to save. Try again.",
          variant: "destructive",
        });
      }
    });

  const resolve = (target: "no_show" | "cancelled") =>
    mutation.run(async () => {
      try {
        const action =
          target === "no_show"
            ? markClinicNoShowAction
            : cancelClinicExpectationAction;
        const result = await action(expectationId, updatedAt);
        reportResult(
          result.ok,
          result.reason,
          target === "no_show" ? "marked no-show" : "cancelled",
        );
        setConfirm(null);
      } catch {
        toast({
          title: "Error",
          description: "Failed to save. Try again.",
          variant: "destructive",
        });
      }
    });

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={onMarkSeen ?? seen}
        disabled={mutation.pending}
        aria-label={`Mark ${label} seen`}
      >
        <Check className="h-4 w-4 mr-1" />
        Seen
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirm("no_show")}
        disabled={mutation.pending}
        aria-label={`Mark ${label} no-show`}
      >
        <UserX className="h-4 w-4 mr-1" />
        No-show
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirm("cancelled")}
        disabled={mutation.pending}
        aria-label={`Cancel ${label}`}
      >
        <X className="h-4 w-4 mr-1" />
        Cancel
      </Button>
      <ConfirmDialog
        open={confirm === "no_show"}
        title="Mark no-show"
        description={
          <>
            Mark <strong>{label}</strong> as a no-show? It leaves the work
            queue but stays in the animal&apos;s history.
          </>
        }
        confirmLabel="Mark no-show"
        pendingLabel="Saving…"
        pending={mutation.pending}
        onConfirm={() => resolve("no_show")}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "cancelled"}
        title="Cancel expectation"
        description={
          <>
            Cancel <strong>{label}</strong>? It leaves the work queue but
            stays in the animal&apos;s history.
          </>
        }
        confirmLabel="Cancel expectation"
        pendingLabel="Cancelling…"
        pending={mutation.pending}
        onConfirm={() => resolve("cancelled")}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
