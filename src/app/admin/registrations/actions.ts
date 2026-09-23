"use server";

// Server actions for registration review (#183). Postgres
// registration_submissions is the only datastore; receipts are resolved
// to short-lived signed URLs through the Admin SDK so the objects stay
// private (no public-read Storage rule).

import { requireAdmin } from "@/lib/auth";
import { adminReceiptBucket } from "@/lib/firebase-admin";
import {
  listRegistrationSubmissions,
  updateSubmissionStatus,
  type AdminRegistrationSubmission,
} from "@/lib/registry/registrations";
import { isRegistrationStatus } from "@/lib/animal-registration";
import type { AnimalRegistration } from "@/lib/types";
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
  return (await listRegistrationSubmissions()).map(toRegistration);
}

export interface StatusActionResult {
  ok: boolean;
  reason?: "not-found" | "invalid";
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
