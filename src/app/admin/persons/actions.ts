"use server";

// Server actions for the staff people/households surface (#166). Every
// action self-authorizes via requireAdmin — persons carry PII and
// identity links drive who can see what in the portal.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import {
  createHousehold,
  createPerson,
  getPersonDetail,
  linkIdentityToPerson,
  listHouseholds,
  listPersons,
  removeHouseholdMember,
  setHouseholdMember,
  unlinkIdentity,
  updateHousehold,
  updatePerson,
  type HouseholdRecord,
  type HouseholdWriteInput,
  type PersonDetail,
  type PersonRecord,
  type PersonWriteInput,
} from "@/lib/registry/persons";
import { logError } from "@/lib/logger";

export async function getPersonsDataAction(): Promise<{
  persons: PersonRecord[];
  households: HouseholdRecord[];
}> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const [persons, households] = await Promise.all([
    listPersons(),
    listHouseholds(),
  ]);
  return { persons, households };
}

export async function getPersonDetailAction(
  personId: string,
): Promise<PersonDetail | null> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getPersonDetail(personId);
}

export interface SaveResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict" | "overlap";
  field?: string;
}

export async function savePersonAction(
  input: PersonWriteInput,
  personId: string | null,
  expectedUpdatedAt?: string,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = personId
      ? await updatePerson(
          personId,
          input,
          expectedUpdatedAt ?? "",
          user?.email ?? "unknown",
        )
      : await createPerson(input, user?.email ?? "unknown");
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        ...("field" in result ? { field: result.field } : {}),
      };
    }
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "save-person", error);
    return { ok: false };
  }
}

export async function saveHouseholdAction(
  input: HouseholdWriteInput,
  householdId: string | null,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = householdId
      ? await updateHousehold(householdId, input, user?.email ?? "unknown")
      : await createHousehold(input, user?.email ?? "unknown");
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "save-household", error);
    return { ok: false };
  }
}

export async function setHouseholdMemberAction(
  householdId: string,
  personId: string,
  role: "member" | "primary",
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await setHouseholdMember(
      householdId,
      personId,
      role,
      user?.email ?? "unknown",
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "set-household-member", error);
    return { ok: false };
  }
}

export async function removeHouseholdMemberAction(
  householdId: string,
  personId: string,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await removeHouseholdMember(
      householdId,
      personId,
      user?.email ?? "unknown",
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "remove-household-member", error);
    return { ok: false };
  }
}

export async function linkIdentityAction(
  identityId: string,
  personId: string,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await linkIdentityToPerson(
      identityId,
      personId,
      user?.email ?? "unknown",
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "link-identity", error);
    return { ok: false };
  }
}

export async function unlinkIdentityAction(
  identityId: string,
): Promise<SaveResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await unlinkIdentity(identityId, user?.email ?? "unknown");
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath("/admin/persons");
    return { ok: true };
  } catch (error) {
    logError("owners", "unlink-identity", error);
    return { ok: false };
  }
}
