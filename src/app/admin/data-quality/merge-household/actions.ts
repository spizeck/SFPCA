"use server";

// Server actions for the household-merge review (#211) — same shape as
// the person and animal merge actions: admin-only, server-computed
// preview, execute revalidates under row locks.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  executeHouseholdMerge,
  getHouseholdMergePair,
  previewHouseholdMerge,
  type HouseholdMergePreviewResult,
  type HouseholdMergeResult,
  type HouseholdMergeSide,
} from "@/lib/registry/household-merge";
import { logError } from "@/lib/logger";

export async function getHouseholdMergePairAction(
  aId: string,
  bId: string,
): Promise<{ a: HouseholdMergeSide; b: HouseholdMergeSide } | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getHouseholdMergePair(aId, bId);
}

export async function previewHouseholdMergeAction(
  survivorId: string,
  retiredId: string,
): Promise<HouseholdMergePreviewResult> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return previewHouseholdMerge(survivorId, retiredId);
}

export interface ExecuteHouseholdMergeInput {
  survivorId: string;
  retiredId: string;
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
}

export async function executeHouseholdMergeAction(
  input: ExecuteHouseholdMergeInput,
): Promise<HouseholdMergeResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await executeHouseholdMerge({
      ...input,
      actorLabel: user?.email ?? "unknown",
      actorIdentityId: null,
    });
    if (result.ok) {
      revalidatePath("/admin/persons");
      revalidatePath("/admin/data-quality");
      revalidatePath("/admin");
    }
    return result;
  } catch (error) {
    logError("owners", "household-merge-execute", error);
    return { ok: false, reason: "invalid" };
  }
}
