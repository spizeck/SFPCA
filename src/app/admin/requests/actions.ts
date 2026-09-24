"use server";

// Server actions for the staff owner-request queue (#166). Every action
// self-authorizes via requireAdmin — owner requests carry PII and drive
// real ownership/identity changes.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  listOwnerRequests,
  resolveOwnerRequest,
  type OwnerRequestRecord,
  type ResolveInput,
} from "@/lib/registry/owner-requests";
import {
  listHouseholds,
  listPersons,
  type HouseholdRecord,
  type PersonRecord,
} from "@/lib/registry/persons";
import { logError } from "@/lib/logger";

export interface OwnerRequestsData {
  pending: OwnerRequestRecord[];
  resolved: OwnerRequestRecord[];
  persons: PersonRecord[];
  households: HouseholdRecord[];
}

export async function getOwnerRequestsAction(): Promise<OwnerRequestsData> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const [pending, resolved, persons, households] = await Promise.all([
    listOwnerRequests({ status: "pending" }),
    listOwnerRequests({ status: "resolved", limit: 100 }),
    listPersons(),
    listHouseholds(),
  ]);
  return { pending, resolved, persons, households };
}

export interface ResolveActionResult {
  ok: boolean;
  reason?: string;
}

export async function resolveOwnerRequestAction(
  requestId: string,
  input: ResolveInput,
): Promise<ResolveActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await resolveOwnerRequest(
      requestId,
      input,
      user?.email ?? "unknown",
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/requests");
    return { ok: true };
  } catch (error) {
    logError("owners", "resolve-request", error);
    return { ok: false };
  }
}
