"use server";

// Server actions for the animal-merge review (#178). The pair page is
// admin-only end to end: every action self-authorizes, the preview is
// computed server-side, and the execute call revalidates under row
// locks — a stale preview can never blind-apply.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  executeAnimalMerge,
  getMergePair,
  previewAnimalMerge,
  type AnimalMergePreviewResult,
  type AnimalMergeResult,
  type MergePairSide,
} from "@/lib/registry/merge";
import { logError } from "@/lib/logger";

export async function getMergePairAction(
  aId: string,
  bId: string,
): Promise<{ a: MergePairSide; b: MergePairSide } | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getMergePair(aId, bId);
}

export async function previewMergeAction(
  survivorId: string,
  retiredId: string,
): Promise<AnimalMergePreviewResult> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return previewAnimalMerge(survivorId, retiredId);
}

export interface ExecuteMergeInput {
  survivorId: string;
  retiredId: string;
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
}

export async function executeMergeAction(
  input: ExecuteMergeInput,
): Promise<AnimalMergeResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await executeAnimalMerge({
      ...input,
      actorLabel: user?.email ?? "unknown",
      actorIdentityId: null,
    });
    if (result.ok) {
      revalidatePath("/admin/animals");
      revalidatePath("/admin/data-quality");
      revalidatePath("/admin");
    }
    return result;
  } catch (error) {
    logError("animals", "merge-execute", error);
    return { ok: false, reason: "invalid" };
  }
}
