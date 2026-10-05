"use server";

// Server actions for registration review (#183). Postgres
// registration_submissions is the only datastore; receipts are resolved
// to short-lived signed URLs through the Admin SDK so the objects stay
// private (no public-read Storage rule).

import { requireAdmin } from "@/lib/auth";
import { adminReceiptBucket } from "@/lib/firebase-admin-storage";
import {
  createRegistration,
  getRegistrationQueues,
  getSubmissionLinkTarget,
  listRegistrationSubmissions,
  updateSubmissionStatus,
  type AdminRegistrationSubmission,
  type RegistrationQueues,
} from "@/lib/registry/registrations";
import {
  applyRetentionHold,
  listActiveHoldsFor,
  releaseRetentionHold,
} from "@/lib/registry/retention";
import { isRetentionHoldEntityType } from "@/lib/retention";
import { getIdentityByProviderUid } from "@/lib/registry/persons";
import {
  searchAnimals,
  type AnimalSearchHit,
} from "@/lib/registry/animals";
import { isRegistrationStatus } from "@/lib/animal-registration";
import type { AnimalRegistration } from "@/lib/types";
import {
  listPendingPayments,
  type PendingPaymentItem,
} from "@/lib/registry/payments";
import {
  listOwnershipsRequiringConfirmation,
  type ConfirmationEligibilityRow,
} from "@/lib/registry/ownership";
import { logError } from "@/lib/logger";

function toRegistration(
  dto: AdminRegistrationSubmission,
): AnimalRegistration {
  return {
    id: dto.id,
    ownerInfo: {
      name: dto.ownerName,
      address: dto.ownerAddress ?? "",
      phone: dto.ownerPhone ?? "",
      email: dto.ownerEmail ?? "",
    },
    animals: (dto.animals ?? []).map((a) => ({
      name: a.name ?? "",
      type: a.type ?? "",
      sex: (a.sex ?? "") as "male" | "female" | "",
      isFixed: (a.isFixed ?? "") as "yes" | "no" | "",
    })),
    paymentReceipt: dto.paymentReceiptPath,
    receiptVerifiedAt: dto.receiptVerifiedAt,
    receiptPurgedAt: dto.receiptPurgedAt,
    source: (dto.source === "portal" ? "portal" : "public") as
      | "public"
      | "portal",
    linkedAnimalId: dto.animalId,
    linkedAnimalName: dto.linkedAnimalName,
    linkedAnimalRegistryRef: dto.linkedAnimalRegistryRef,
    requestedYear: dto.requestedYear,
    ownerNote: dto.ownerNote,
    totalFee: dto.totalFeeCents / 100,
    status: dto.status as AnimalRegistration["status"],
    createdAt: dto.submittedAt,
    updatedAt: dto.updatedAt,
  };
}

export async function listRegistrationsAction(): Promise<
  AnimalRegistration[]
> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const submissions = await listRegistrationSubmissions();
  const holds = await listActiveHoldsFor(
    "registration_submission",
    submissions.map((s) => s.id),
  );
  return submissions.map((s) => {
    const hold = holds.get(s.id);
    return {
      ...toRegistration(s),
      retentionHold: hold
        ? {
            reason: hold.reason,
            createdByLabel: hold.createdByLabel,
            createdAt: hold.createdAt,
          }
        : null,
    };
  });
}

// --- Retention holds (#130) -------------------------------------------------
// The deliberate exemption mechanism: an active hold shields the entity
// from every automated purge/anonymize path until released. Reason is
// required and audited; both actions re-authorize server-side.

export interface HoldActionResult {
  ok: boolean;
  reason?: "invalid" | "conflict" | "not-found";
}

export async function applyRetentionHoldAction(
  entityType: string,
  entityId: string,
  reason: string,
): Promise<HoldActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  if (!isRetentionHoldEntityType(entityType)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const identity = user?.uid
      ? await getIdentityByProviderUid(user.uid)
      : null;
    const result = await applyRetentionHold(
      entityType,
      entityId,
      reason,
      user?.email ?? "unknown",
      identity?.id ?? null,
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("retention", "hold-apply", error);
    return { ok: false };
  }
}

export async function releaseRetentionHoldAction(
  entityType: string,
  entityId: string,
): Promise<HoldActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  if (!isRetentionHoldEntityType(entityType)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const identity = user?.uid
      ? await getIdentityByProviderUid(user.uid)
      : null;
    const result = await releaseRetentionHold(
      entityType,
      entityId,
      user?.email ?? "unknown",
      identity?.id ?? null,
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("retention", "hold-release", error);
    return { ok: false };
  }
}

export interface StatusActionResult {
  ok: boolean;
  reason?: "not-found" | "invalid" | "conflict";
}

export async function setRegistrationStatusAction(
  id: string,
  status: string,
): Promise<StatusActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  if (!isRegistrationStatus(status)) return { ok: false, reason: "invalid" };

  try {
    const result = await updateSubmissionStatus(
      id,
      status,
      user?.email ?? "unknown",
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("admin", "registration-update", error);
    return { ok: false };
  }
}

// Short-lived signed URL for the receipt object. Receipts stay private:
// public/anonymous Storage reads are denied, so staff review goes
// through this privileged mint instead of a public download URL.
export async function getReceiptUrlAction(
  path: string,
): Promise<{ ok: boolean; url?: string }> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  if (!path.startsWith("receipts/") || path.includes("..")) {
    return { ok: false };
  }

  try {
    const [url] = await adminReceiptBucket()
      .file(path)
      .getSignedUrl({ action: "read", expires: Date.now() + 10 * 60 * 1000 });
    return { ok: true, url };
  } catch (error) {
    logError("admin", "receipt-view", error);
    return { ok: false };
  }
}

// --- Current-period queues (#169) -------------------------------------------
// The exception-first registration surface: canonical queue data from
// the registration service, not page-side recomputation.

export async function getRegistrationQueuesAction(): Promise<RegistrationQueues> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getRegistrationQueues();
}

// Link a reviewed submission to a registry animal and create the
// authoritative registration. For PUBLIC submissions matching is
// ALWAYS the staff member's choice via the animal picker — intake data
// never auto-matches (#178 owns generic duplicate detection). For
// PORTAL-originated requests the canonical animal and year are already
// stored on the row (server-resolved at submit time); passing
// animalId=null makes the server use them rather than trusting the
// client's pick.
export async function createRegistrationFromSubmissionAction(
  animalId: string | null,
  submissionId: string,
): Promise<StatusActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const target = await getSubmissionLinkTarget(submissionId);
    if (!target) return { ok: false, reason: "not-found" };
    // A rejected submission records a staff decision — registering it
    // anyway would contradict that decision. Reconsideration goes
    // through the review transition back to pending first.
    if (target.status === "rejected") {
      return { ok: false, reason: "invalid" };
    }
    const resolvedAnimalId =
      target.source === "portal" && target.animalId
        ? target.animalId
        : animalId;
    if (!resolvedAnimalId) return { ok: false, reason: "invalid" };
    const result = await createRegistration(
      {
        animalId: resolvedAnimalId,
        submissionId,
        ...(target.source === "portal" && target.requestedYear !== null
          ? { year: target.requestedYear }
          : {}),
      },
      user?.email ?? "unknown",
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    logError("registration", "registration-create", error);
    return { ok: false };
  }
}

// Ledger rows declared but not yet money — pending bank transfers staff
// must confirm or void (#170 reconciliation; #177 dashboard source).
export async function listPendingPaymentsAction(): Promise<
  PendingPaymentItem[]
> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return listPendingPayments();
}

// Ownership relationships past their annual re-affirmation (#166) —
// the canonical eligibility read, same as the reminder evaluator uses.
export async function listConfirmationsDueAction(): Promise<
  ConfirmationEligibilityRow[]
> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return listOwnershipsRequiringConfirmation();
}

// Lightweight animal search for the link-animal picker — name, registry
// ref, owner, or chip. Bounded result set from the canonical search.
export async function searchAnimalsForLinkAction(
  query: string,
): Promise<AnimalSearchHit[]> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return searchAnimals(query, { lifecycleStatus: "active" });
}
