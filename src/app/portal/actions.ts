"use server";

// Server actions for the owner portal (#166). Authorization is the
// FIRST thing every action does: requireOwner resolves the session to
// the linked registry person, and every animal-scoped action re-verifies
// through getOwnedOwnership that the ownership is currently valid AND
// held by that person — an ownership id from the client is never proof.
// A session without a linked person (claim pending) can do nothing.

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { getOwnedOwnership, recordOwnershipConfirmation } from "@/lib/registry/ownership";
import { updateOwnerProfile, type PersonWriteInput } from "@/lib/registry/persons";
import {
  cancelOwnerRequest,
  submitOwnerRequest,
} from "@/lib/registry/owner-requests";
import {
  OWNER_SUBMITTABLE_KINDS,
  type OwnerRequestKind,
} from "@/lib/registry/owner-request-kinds";
import { logError } from "@/lib/logger";

export interface PortalActionResult {
  ok: boolean;
  error?: string;
}



async function requireLinkedOwner() {
  const ctx = await requireOwner();
  if (!ctx.authorized || !ctx.identity) {
    return { ok: false as const, error: "Unauthorized" };
  }
  if (!ctx.person) {
    // Unlinked identity — either the claim is still pending review or
    // provisioning failed. Fail closed either way.
    return {
      ok: false as const,
      error:
        "Your account is not linked to an owner record yet. Please try again later or contact SFPCA.",
    };
  }
  return { ok: true as const, identity: ctx.identity, person: ctx.person };
}

// "Yes — this animal is still living on Saba and associated with me."
// Writes a deliberate, durable confirmation row (#166's annual
// confirmation evidence), audited under the owner's own identity.
export async function confirmAnimalAction(
  ownershipId: string,
): Promise<PortalActionResult> {
  const ctx = await requireLinkedOwner();
  if (!ctx.ok) return { ok: false, error: ctx.error };

  try {
    // The service enforces current-interval + party-to-relationship, but
    // authorize explicitly first — the portal contract is that an id
    // from the client means nothing until this check passes.
    const owned = await getOwnedOwnership(ownershipId, ctx.person.id);
    if (!owned) {
      return { ok: false, error: "That animal is not associated with you." };
    }
    const result = await recordOwnershipConfirmation({
      ownershipId,
      personId: ctx.person.id,
      method: "owner-portal",
      confirmedByIdentityId: ctx.identity.id,
      actorLabel: ctx.identity.email ?? ctx.person.fullName,
    });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === "not-current"
            ? "This relationship is no longer current — staff may need to review it."
            : "Unable to record the confirmation. Please try again.",
      };
    }
    revalidatePath("/portal");
    return { ok: true };
  } catch (error) {
    logError("portal", "confirm-animal", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export interface OwnerReportInput {
  ownershipId: string;
  kind: OwnerRequestKind;
  detail?: string;
  // 'transfer' only — free-text hints for staff to identify the new
  // owner. Never a link key: the target is verified at resolution.
  targetName?: string;
  targetContact?: string;
  effectiveOn?: string;
}

// Report a change about an owned animal — "no longer mine", transfer,
// deceased, moved off Saba. Everything is a staff-reviewed request;
// the portal never applies ownership or lifecycle changes itself.
export async function submitOwnerReportAction(
  input: OwnerReportInput,
): Promise<PortalActionResult> {
  const ctx = await requireLinkedOwner();
  if (!ctx.ok) return { ok: false, error: ctx.error };

  if (!OWNER_SUBMITTABLE_KINDS.includes(input.kind)) {
    return { ok: false, error: "Unknown request type." };
  }
  if (input.kind === "transfer" && !input.targetName?.trim()) {
    return {
      ok: false,
      error: "Please tell us who the animal is going to (a name helps staff find them).",
    };
  }

  try {
    const owned = await getOwnedOwnership(input.ownershipId, ctx.person.id);
    if (!owned) {
      return { ok: false, error: "That animal is not associated with you." };
    }
    const result = await submitOwnerRequest(
      {
        kind: input.kind,
        authIdentityId: ctx.identity.id,
        personId: ctx.person.id,
        animalId: owned.animalId,
        ownershipId: owned.id,
        detail: input.detail?.trim() || null,
        payload: {
          ...(input.kind === "transfer"
            ? {
                targetName: input.targetName?.trim() || null,
                targetContact: input.targetContact?.trim() || null,
              }
            : {}),
          effectiveOn: input.effectiveOn?.trim() || null,
        },
      },
      ctx.identity.email ?? ctx.person.fullName,
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === "duplicate"
            ? "You already have a pending request of this type for this animal."
            : "Unable to submit the request. Please try again.",
      };
    }
    revalidatePath("/portal");
    return { ok: true };
  } catch (error) {
    logError("portal", "submit-owner-report", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

// Withdraw a pending request the owner submitted.
export async function cancelOwnerRequestAction(
  requestId: string,
): Promise<PortalActionResult> {
  const ctx = await requireLinkedOwner();
  if (!ctx.ok) return { ok: false, error: ctx.error };

  try {
    const result = await cancelOwnerRequest(
      requestId,
      ctx.person.id,
      ctx.identity.id,
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === "not-pending"
            ? "That request has already been resolved."
            : "Request not found.",
      };
    }
    revalidatePath("/portal");
    return { ok: true };
  } catch (error) {
    logError("portal", "cancel-owner-request", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

// Owner self-service contact details. `notes` is staff-only scratch
// space — never writable through this path.
export async function updateOwnerProfileAction(
  input: Omit<PersonWriteInput, "notes">,
): Promise<PortalActionResult> {
  const ctx = await requireLinkedOwner();
  if (!ctx.ok) return { ok: false, error: ctx.error };

  try {
    const result = await updateOwnerProfile(
      ctx.person.id,
      input,
      ctx.identity.id,
      ctx.identity.email ?? ctx.person.fullName,
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.reason === "invalid"
            ? `Invalid ${result.field}.`
            : "Unable to save your profile. Please try again.",
      };
    }
    revalidatePath("/portal");
    return { ok: true };
  } catch (error) {
    logError("portal", "update-profile", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
