"use server";

// Server actions for the /admin/data-quality workspace (#178). Every
// action self-authorizes via requireAdmin — findings can carry owner
// names and internal identifiers, so nothing here is public.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  clearDataQualityReview,
  listDataQualityFindings,
  recordDataQualityReview,
  type DataQualityFilters,
  type DataQualityFinding,
} from "@/lib/registry/data-quality";
import { logError } from "@/lib/logger";

export async function listDataQualityFindingsAction(
  filters: DataQualityFilters,
): Promise<DataQualityFinding[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return listDataQualityFindings(filters);
}

export interface ReviewActionResult {
  ok: boolean;
}

// Persist a human verdict on a finding — 'confirmed' keeps it visible
// and flagged; 'dismissed' suppresses it while the evidence is
// unchanged (the stored fingerprint resurfaces it if evidence changes).
export async function decideFindingAction(input: {
  detector: string;
  entityType: string;
  entityIds: string[];
  fingerprint: string;
  decision: string;
  note?: string | null;
}): Promise<ReviewActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await recordDataQualityReview({
      ...input,
      actorLabel: user?.email ?? "unknown",
      actorIdentityId: null,
    });
    revalidatePath("/admin/data-quality");
    return { ok: result.ok };
  } catch (error) {
    logError("animals", "data-quality-review", error);
    return { ok: false };
  }
}

// Reopen a decided finding — clears the persisted decision so the
// finding stands on its current evidence again.
export async function reopenFindingAction(input: {
  detector: string;
  entityType: string;
  entityIds: string[];
}): Promise<ReviewActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await clearDataQualityReview({
      ...input,
      actorLabel: user?.email ?? "unknown",
    });
    revalidatePath("/admin/data-quality");
    return { ok: result.ok };
  } catch (error) {
    logError("animals", "data-quality-reopen", error);
    return { ok: false };
  }
}
