// Registration submission + review domain service (#183).
// registration_submissions is the intake record: what the public form
// submits and what staff review. Owner fields are an applicant-provided
// snapshot — linking to real Person/Household records is the later
// verification workflow (#178), not something intake guesses at.
//
// Status transitions and the submission write run in transactions with
// their audit_events rows. Receipt references are Storage object paths
// only — binary data never enters Postgres.

import "server-only";

import { desc, eq } from "drizzle-orm";
import { auditEvents, registrationSubmissions } from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  REGISTRATION_INITIAL_STATUS,
  canTransitionRegistrationStatus,
  calculateRegistrationFee,
  isRegistrationStatus,
  validateRegistration,
  type RegistrationAnimalInput,
  type RegistrationFormInput,
  type RegistrationStatus,
} from "../animal-registration";
import type { RegistryDb } from "./public-animals";

export interface AdminRegistrationSubmission {
  id: string;
  legacyId: string | null;
  ownerName: string;
  ownerAddress: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  animals: RegistrationAnimalInput[];
  paymentReceiptPath: string | null;
  totalFeeCents: number;
  currency: string;
  status: string;
  submittedAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

const SUBMISSION_COLUMNS = {
  id: registrationSubmissions.id,
  legacyId: registrationSubmissions.legacyId,
  ownerName: registrationSubmissions.ownerName,
  ownerAddress: registrationSubmissions.ownerAddress,
  ownerPhone: registrationSubmissions.ownerPhone,
  ownerEmail: registrationSubmissions.ownerEmail,
  animals: registrationSubmissions.animals,
  paymentReceiptPath: registrationSubmissions.paymentReceiptPath,
  totalFeeCents: registrationSubmissions.totalFeeCents,
  currency: registrationSubmissions.currency,
  status: registrationSubmissions.status,
  submittedAt: registrationSubmissions.submittedAt,
  decidedAt: registrationSubmissions.decidedAt,
  updatedAt: registrationSubmissions.updatedAt,
} as const;

function toSubmissionDto(
  row: Pick<
    typeof registrationSubmissions.$inferSelect,
    keyof typeof SUBMISSION_COLUMNS
  >,
): AdminRegistrationSubmission {
  return {
    ...row,
    animals: Array.isArray(row.animals)
      ? (row.animals as RegistrationAnimalInput[])
      : [],
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listRegistrationSubmissions(
  db: RegistryDb = getRegistryDb(),
): Promise<AdminRegistrationSubmission[]> {
  const rows = await db
    .select(SUBMISSION_COLUMNS)
    .from(registrationSubmissions)
    // Newest first — staff work the pending queue top-down.
    .orderBy(desc(registrationSubmissions.submittedAt));
  return rows.map(toSubmissionDto);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_PATH_RE = /^receipts\/[0-9a-f-]{36}$/i;

export interface SubmissionInput extends RegistrationFormInput {
  // Client-generated uuid — also the receipt object name, so the form
  // can upload the receipt before the row exists and a retry of a
  // possibly-failed insert is idempotent (same id → conflict → success).
  submissionId: string;
  // Storage object path or null when no receipt was provided.
  receiptPath: string | null;
}

export type CreateSubmissionResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: "invalid" };

// Public intake. The fee is recomputed server-side from the validated
// animal list — a tampered client-side total is simply ignored.
export async function createRegistrationSubmission(
  input: SubmissionInput,
  db: RegistryDb = getRegistryDb(),
): Promise<CreateSubmissionResult> {
  if (!UUID_RE.test(input.submissionId)) {
    return { ok: false, reason: "invalid" };
  }
  if (Object.keys(validateRegistration(input)).length > 0) {
    return { ok: false, reason: "invalid" };
  }
  const receiptPath = input.receiptPath?.trim() || null;
  if (receiptPath !== null && !RECEIPT_PATH_RE.test(receiptPath)) {
    return { ok: false, reason: "invalid" };
  }

  const totalFee = calculateRegistrationFee(input.animals);
  try {
    await db.insert(registrationSubmissions).values({
      id: input.submissionId,
      ownerName: input.ownerName.trim(),
      ownerAddress: input.ownerAddress.trim(),
      ownerPhone: input.ownerPhone.trim(),
      ownerEmail: input.ownerEmail.trim(),
      animals: input.animals.map((a) => ({
        name: a.name.trim(),
        type: a.type.trim(),
        sex: a.sex,
        isFixed: a.isFixed,
      })),
      paymentReceiptPath: receiptPath,
      totalFeeCents: Math.round(totalFee * 100),
      currency: "USD",
      status: REGISTRATION_INITIAL_STATUS,
    });
  } catch (error) {
    // Idempotent retry: the row landing before the response was lost is
    // indistinguishable from a failed insert — a PK conflict on the same
    // client id means the submission already succeeded. postgres.js
    // exposes the SQLSTATE on the error itself; PGlite/drizzle wrap it
    // on the cause, so check both.
    const code = (error as { code?: unknown })?.code;
    const causeCode = (error as { cause?: { code?: unknown } })?.cause
      ?.code;
    if (code === "23505" || causeCode === "23505") {
      return { ok: true, submissionId: input.submissionId };
    }
    throw error;
  }
  return { ok: true, submissionId: input.submissionId };
}

export type StatusUpdateResult =
  | { ok: true; submission: AdminRegistrationSubmission }
  | { ok: false; reason: "not-found" | "invalid" };

// Staff review transition. decidedAt records when the submission left
// the pending state; returning to pending clears it. The status update
// and its audit row commit together.
export async function updateSubmissionStatus(
  id: string,
  status: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<StatusUpdateResult> {
  if (!isRegistrationStatus(status)) {
    return { ok: false, reason: "invalid" };
  }
  if (!UUID_RE.test(id)) {
    return { ok: false, reason: "not-found" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(SUBMISSION_COLUMNS)
      .from(registrationSubmissions)
      .where(eq(registrationSubmissions.id, id))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (!canTransitionRegistrationStatus(before.status, status)) {
      return { ok: false as const, reason: "invalid" as const };
    }

    const [row] = await tx
      .update(registrationSubmissions)
      .set({
        status: status as RegistrationStatus,
        decidedAt: status === "pending" ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(registrationSubmissions.id, id))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration_submission",
      entityId: id,
      action: "status-change",
      // Status transitions only — owner PII stays out of the audit log.
      before: { status: before.status },
      after: { status },
    });
    return { ok: true, submission: toSubmissionDto(row) };
  });
}

// Orphan-receipt sweep existence check — receipt object names are the
// submission uuid.
export async function registrationSubmissionExists(
  id: string,
  db: RegistryDb = getRegistryDb(),
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await db
    .select({ id: registrationSubmissions.id })
    .from(registrationSubmissions)
    .where(eq(registrationSubmissions.id, id))
    .limit(1);
  return !!row;
}
