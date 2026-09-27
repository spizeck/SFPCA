"use server";

// Server actions for the person-merge review (#211). Admin-only end to
// end: the preview is server-computed and execute revalidates under
// row locks — including the auth-identity gate, so a stale preview can
// never fuse two accounts.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  executePersonMerge,
  getPersonMergePair,
  previewPersonMerge,
  type PersonMergePreviewResult,
  type PersonMergeResult,
  type PersonMergeSide,
} from "@/lib/registry/person-merge";
import { logError } from "@/lib/logger";

export async function getPersonMergePairAction(
  aId: string,
  bId: string,
): Promise<{ a: PersonMergeSide; b: PersonMergeSide } | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getPersonMergePair(aId, bId);
}

export async function previewPersonMergeAction(
  survivorId: string,
  retiredId: string,
): Promise<PersonMergePreviewResult> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return previewPersonMerge(survivorId, retiredId);
}

export interface ExecutePersonMergeInput {
  survivorId: string;
  retiredId: string;
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
}

export async function executePersonMergeAction(
  input: ExecutePersonMergeInput,
): Promise<PersonMergeResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await executePersonMerge({
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
    logError("owners", "person-merge-execute", error);
    return { ok: false, reason: "invalid" };
  }
}
