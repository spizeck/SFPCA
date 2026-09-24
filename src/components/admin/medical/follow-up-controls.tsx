"use client";

// Shared follow-up UI (#175): the derived-state badge and the
// complete/cancel controls. Used by the /admin/vet work queue and the
// per-animal medical record — one component so both surfaces resolve
// items identically.

import { useState } from "react";
import {
  cancelFollowUpAction,
  completeFollowUpAction,
} from "@/app/admin/vet/actions";
import {
  FOLLOW_UP_STATE_LABELS,
  type FollowUpState,
} from "@/lib/medical";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@/hooks/use-mutation";
import { Check, X } from "lucide-react";

// Color supports the text but never carries meaning alone — the label
// always spells out the state.
const STATE_CLASSES: Record<FollowUpState, string> = {
  overdue: "bg-red-100 text-red-800",
  due: "bg-amber-100 text-amber-800",
  upcoming: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-gray-100 text-gray-800",
};

export function FollowUpStateBadge({ state }: { state: FollowUpState }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATE_CLASSES[state]}`}
    >
      {FOLLOW_UP_STATE_LABELS[state]}
    </span>
  );
}

// Complete is a one-tap action; cancel confirms because it removes the
// item from everyone's queue (the record itself is preserved — nothing
// is deleted). `updatedAt` is the rendered row's optimistic-concurrency
// token; a stale view surfaces "conflict" instead of double-resolving.
export function FollowUpResolveButtons({
  followUpId,
  updatedAt,
  label,
  onResolved,
}: {
  followUpId: string;
  updatedAt: string;
  // Identifies the item in dialogs/labels — e.g. "Recheck — Rex".
  label: string;
  onResolved: () => void;
}) {
  const mutation = useMutation();
  const { toast } = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const reportResult = (
    ok: boolean,
    reason: string | undefined,
    pastTense: string,
  ) => {
    if (ok) {
      toast({ title: "Done", description: `Follow-up ${pastTense}.` });
      onResolved();
      return;
    }
    toast({
      title: "Error",
      description:
        reason === "conflict"
          ? "This follow-up was already changed by someone else. Reload to see the latest state."
          : "Failed to save. Try again.",
      variant: "destructive",
    });
  };

  const complete = () =>
    mutation.run(async () => {
      try {
        const result = await completeFollowUpAction(followUpId, updatedAt);
        reportResult(result.ok, result.reason, "completed");
      } catch {
        toast({
          title: "Error",
          description: "Failed to save. Try again.",
          variant: "destructive",
        });
      }
    });

  const cancel = () =>
    mutation.run(async () => {
      try {
        const result = await cancelFollowUpAction(followUpId, updatedAt);
        reportResult(result.ok, result.reason, "cancelled");
        setConfirmCancel(false);
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
        onClick={complete}
        disabled={mutation.pending}
        aria-label={`Complete ${label}`}
      >
        <Check className="h-4 w-4 mr-1" />
        Complete
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmCancel(true)}
        disabled={mutation.pending}
        aria-label={`Cancel ${label}`}
      >
        <X className="h-4 w-4 mr-1" />
        Cancel
      </Button>
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel follow-up"
        description={
          <>
            Cancel <strong>{label}</strong>? It leaves the work queue but
            stays in the animal&apos;s history.
          </>
        }
        confirmLabel="Cancel follow-up"
        pendingLabel="Cancelling…"
        pending={mutation.pending}
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
