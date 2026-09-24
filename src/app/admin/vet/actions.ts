"use server";

// Server actions for the veterinary work queue (#175) — the /admin/vet
// page and the per-animal follow-up panel both call these. Every action
// self-authorizes via requireAdmin; clinical and owner data is
// staff-only and never crosses into public surfaces.

import { requireAdmin } from "@/lib/auth";
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  updateFollowUp,
  type FollowUpWriteInput,
} from "@/lib/registry/medical";
import {
  listVetQueue,
  vetQueueSummary,
  VET_QUEUE_WINDOW_DAYS,
  type VetQueueItem,
  type VetQueueSummary,
} from "@/lib/registry/vet-queue";
import { logError, type LogSubsystem } from "@/lib/logger";

// The queue horizon is a read-window knob, not a security boundary, but
// it is clamped anyway — a huge window is a slow query, not more data
// than staff may see.
const MAX_WINDOW_DAYS = 366;

export async function getVetQueueAction(
  withinDays: number = VET_QUEUE_WINDOW_DAYS,
): Promise<VetQueueItem[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const days =
    Number.isInteger(withinDays) && withinDays >= 1
      ? Math.min(withinDays, MAX_WINDOW_DAYS)
      : VET_QUEUE_WINDOW_DAYS;
  return listVetQueue({ withinDays: days });
}

export async function getVetQueueSummaryAction(): Promise<VetQueueSummary> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return vetQueueSummary();
}

export interface SaveResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
  field?: string;
}

type MutationOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" | "conflict" | "invalid"; field?: string };

function toSaveResult(result: MutationOutcome): SaveResult {
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason: result.reason,
    ...("field" in result ? { field: result.field } : {}),
  };
}

// Same logged boundary as the medical-record actions: authorized, then
// one error log per failure.
async function save(
  subsystem: LogSubsystem,
  run: (actor: string) => Promise<MutationOutcome>,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    return toSaveResult(await run(user?.email ?? "unknown"));
  } catch (error) {
    logError(subsystem, "admin-save", error);
    return { ok: false };
  }
}

export async function saveFollowUpAction(
  input: FollowUpWriteInput,
  followUpId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    followUpId
      ? updateFollowUp(followUpId, input, expectedUpdatedAt ?? "", actor)
      : createFollowUp(input, actor),
  );
}

// Terminal transitions — no delete exists. expectedUpdatedAt is the
// optimistic-concurrency token from the rendered row; a stale token
// returns 'conflict' so two staff members can't double-resolve.
export async function completeFollowUpAction(
  followUpId: string,
  expectedUpdatedAt: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    completeFollowUp(followUpId, expectedUpdatedAt, actor),
  );
}

export async function cancelFollowUpAction(
  followUpId: string,
  expectedUpdatedAt: string,
): Promise<SaveResult> {
  return save("medical", (actor) =>
    cancelFollowUp(followUpId, expectedUpdatedAt, actor),
  );
}
