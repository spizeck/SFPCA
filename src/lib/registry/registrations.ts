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

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  animals,
  auditEvents,
  households,
  ownerships,
  persons,
  registrationSubmissions,
  registrations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  REGISTRATION_INITIAL_STATUS,
  REGISTRATION_FEE_FIXED,
  REGISTRATION_FEE_NOT_FIXED,
  canTransitionRegistrationStatus,
  calculateRegistrationFee,
  isRegistrationStatus,
  validateRegistration,
  type RegistrationAnimalInput,
  type RegistrationFormInput,
  type RegistrationStatus,
} from "../animal-registration";
import {
  currentRegistrationYear,
  isRegistrationResolution,
  isRegistrationYear,
  OUTSTANDING_PAYMENT_STATES,
  type RegistrationCancellationReason,
  type RegistrationPaymentState,
  type RegistrationResolution,
} from "../registrations";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import {
  deriveRegistrationBalance,
  emptyLedgerAggregate,
  type LedgerAggregate,
  type ManualPaymentMethod,
} from "../payments";
import { currentOwnershipSq } from "./ownership";
import { moneyByRegistration, recordManualPayment } from "./payments";
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

// === Authoritative registrations (#169) ======================================
// `registrations` is the durable per-animal-per-year record. Animal
// existence/lifecycle (#167), registration status, and payment state
// are deliberately separate concepts: a registration row never changes
// the animal, and "paid" is never a registration status — it is derived
// from the payments ledger plus the row's own non-payment resolution.
//
// Every write runs in a transaction with its audit_events row. History
// is preserved: cancellation marks the row, correction audits the
// before/after — nothing is deleted and no amount/state is silently
// rewritten.

export interface RegistrationRecord {
  id: string;
  animalId: string;
  submissionId: string | null;
  year: number;
  status: string;
  // Registration-time owner snapshot (null = unowned/unresolved at
  // that time). ownerLabel survives later renames/deletions.
  ownershipId: string | null;
  personId: string | null;
  householdId: string | null;
  ownerLabel: string | null;
  submittedAt: string;
  registeredAt: string | null;
  amountDueCents: number;
  currency: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  notes: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancellationNote: string | null;
  createdAt: string;
  updatedAt: string;
  // Derived from the canonical balance projection (#170) — never
  // stored. paidCents is net CONFIRMED settled money (payments -
  // refunds + adjustments); outstandingCents what is still owed;
  // pendingCents in-flight money that does NOT count.
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  pendingCents: number;
  paymentState: RegistrationPaymentState;
}

const REGISTRATION_COLUMNS = {
  id: registrations.id,
  animalId: registrations.animalId,
  submissionId: registrations.submissionId,
  year: registrations.year,
  status: registrations.status,
  ownershipId: registrations.ownershipId,
  personId: registrations.personId,
  householdId: registrations.householdId,
  ownerLabel: registrations.ownerLabel,
  submittedAt: registrations.submittedAt,
  registeredAt: registrations.registeredAt,
  amountDueCents: registrations.amountDueCents,
  currency: registrations.currency,
  resolution: registrations.resolution,
  resolutionNote: registrations.resolutionNote,
  resolvedAt: registrations.resolvedAt,
  resolvedBy: registrations.resolvedBy,
  notes: registrations.notes,
  cancelledAt: registrations.cancelledAt,
  cancellationReason: registrations.cancellationReason,
  cancellationNote: registrations.cancellationNote,
  createdAt: registrations.createdAt,
  updatedAt: registrations.updatedAt,
} as const;

type RegistrationRow = Pick<
  typeof registrations.$inferSelect,
  keyof typeof REGISTRATION_COLUMNS
>;

function toRegistrationDto(
  row: RegistrationRow,
  agg: LedgerAggregate,
): RegistrationRecord {
  const balance = deriveRegistrationBalance(
    {
      amountDueCents: row.amountDueCents,
      resolution: isRegistrationResolution(row.resolution)
        ? row.resolution
        : null,
    },
    agg,
  );
  return {
    ...row,
    submittedAt: row.submittedAt.toISOString(),
    registeredAt: row.registeredAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    paidCents: balance.settledCents,
    outstandingCents: balance.outstandingCents,
    overpaidCents: balance.overpaidCents,
    pendingCents: balance.pendingCents,
    paymentState: balance.paymentState,
  };
}

// Registration history for one animal — newest period first, cancelled
// rows included (they ARE the history). Used by the profile panel and
// the owner portal's per-animal view.
export async function listRegistrationsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(REGISTRATION_COLUMNS)
    .from(registrations)
    .where(eq(registrations.animalId, animalId))
    .orderBy(desc(registrations.year), desc(registrations.createdAt));
  const money = await moneyByRegistration(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    toRegistrationDto(r, money.get(r.id) ?? emptyLedgerAggregate()),
  );
}

// --- Creation ---------------------------------------------------------------

export interface CreateRegistrationInput {
  animalId: string;
  // Defaults to the current period — pass explicitly for backfills or
  // deterministic tests.
  year?: number;
  // Optional intake linkage — a reviewed submission this registration
  // answers. The linkage is evidence, not authority.
  submissionId?: string | null;
  // Explicit assessment override; when omitted the fee is assessed from
  // the animal's recorded sterilization state (REGISTRATION_FEE_*).
  amountDueCents?: number;
  notes?: string | null;
}

export type CreateRegistrationResult =
  | { ok: true; registration: RegistrationRecord }
  | { ok: false; reason: "invalid" | "not-found" | "conflict" };

// Creates the authoritative registration for one animal+period. The
// amount assessed and the owner snapshot are frozen at creation:
//   - amount: explicit override, else sterilized → fixed fee, else the
//     not-fixed fee — the same schedule the public form advertises;
//   - owner: the deterministic current-ownership row (person side
//     preferred) — multiple simultaneously-valid rows are legitimate
//     co-ownership, the snapshot records the primary relationship while
//     ownerships history keeps the rest.
export async function createRegistration(
  input: CreateRegistrationInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<CreateRegistrationResult> {
  if (!UUID_RE.test(input.animalId)) return { ok: false, reason: "invalid" };
  const year = input.year ?? currentRegistrationYear();
  if (!isRegistrationYear(year)) return { ok: false, reason: "invalid" };
  const amountDueCents = input.amountDueCents;
  if (
    amountDueCents !== undefined &&
    (!Number.isInteger(amountDueCents) || amountDueCents < 0)
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (input.submissionId != null && !UUID_RE.test(input.submissionId)) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [animal] = await tx
      .select({
        id: animals.id,
        sterilizationStatus: animals.sterilizationStatus,
      })
      .from(animals)
      .where(eq(animals.id, input.animalId))
      .for("update");
    if (!animal) return { ok: false as const, reason: "not-found" as const };

    const [existing] = await tx
      .select({ id: registrations.id, status: registrations.status })
      .from(registrations)
      .where(
        and(
          eq(registrations.animalId, input.animalId),
          eq(registrations.year, year),
        ),
      );
    // A cancelled row still holds the (animal, year) slot — resurrecting
    // it would hide the cancellation; staff correct instead of re-add.
    if (existing) return { ok: false as const, reason: "conflict" as const };

    // Owner snapshot: the deterministic current-ownership row — person
    // side preferred (persons carry contacts), earliest valid_from,
    // id tiebreak — mirroring currentOwnershipSq ordering.
    const ownershipRows = await tx
      .select({
        id: ownerships.id,
        personId: ownerships.personId,
        householdId: ownerships.householdId,
        personName: persons.fullName,
        householdName: households.name,
      })
      .from(ownerships)
      .leftJoin(persons, eq(ownerships.personId, persons.id))
      .leftJoin(households, eq(ownerships.householdId, households.id))
      .where(
        and(
          eq(ownerships.animalId, input.animalId),
          lte(ownerships.validFrom, todayIsoDate()),
          or(
            isNull(ownerships.validTo),
            gt(ownerships.validTo, todayIsoDate()),
          ),
        ),
      )
      .orderBy(
        asc(sql`(${ownerships.personId} IS NULL)`),
        asc(ownerships.validFrom),
        asc(ownerships.id),
      );
    const owner = ownershipRows[0] ?? null;

    let submittedAt: Date | undefined;
    if (input.submissionId) {
      const [sub] = await tx
        .select({ submittedAt: registrationSubmissions.submittedAt })
        .from(registrationSubmissions)
        .where(eq(registrationSubmissions.id, input.submissionId));
      if (!sub) return { ok: false as const, reason: "not-found" as const };
      submittedAt = sub.submittedAt;
    }

    const assessed =
      amountDueCents ??
      (animal.sterilizationStatus === "sterilized"
        ? REGISTRATION_FEE_FIXED
        : REGISTRATION_FEE_NOT_FIXED) * 100;

    const [row] = await tx
      .insert(registrations)
      .values({
        animalId: input.animalId,
        submissionId: input.submissionId ?? null,
        year,
        status: "active",
        ownershipId: owner?.id ?? null,
        personId: owner?.personId ?? null,
        householdId: owner?.householdId ?? null,
        ownerLabel: owner?.personName ?? owner?.householdName ?? null,
        submittedAt: submittedAt ?? new Date(),
        registeredAt: new Date(),
        amountDueCents: assessed,
        currency: "USD",
        notes: input.notes?.trim() || null,
      })
      .returning();
    if (!row) return { ok: false as const, reason: "invalid" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration",
      entityId: row.id,
      action: "create",
      after: {
        animalId: input.animalId,
        year,
        amountDueCents: assessed,
        ownerLabel: row.ownerLabel,
        submissionId: input.submissionId ?? null,
      },
    });
    return {
      ok: true,
      registration: toRegistrationDto(row, emptyLedgerAggregate()),
    };
  });
}

// --- Cancellation -------------------------------------------------------------

// Shared mutation outcome — every registration write either returns the
// updated record or a typed failure the UI can explain.
export type RegistrationMutationResult =
  | { ok: true; registration: RegistrationRecord }
  | { ok: false; reason: "invalid" | "not-found" | "conflict" };

// Cancels an active registration — 'correction' when the row itself was
// wrong, 'withdrawn' when the registration genuinely ended. The row is
// kept: it remains the historical record of what was believed.
export async function cancelRegistration(
  registrationId: string,
  options: {
    reason: RegistrationCancellationReason;
    note?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationMutationResult> {
  if (!UUID_RE.test(registrationId)) return { ok: false, reason: "invalid" };
  if (
    !["correction", "withdrawn"].includes(options.reason) ||
    (options.reason === "correction" && !options.note?.trim())
  ) {
    // A correction must say what was wrong — silent data fixes are the
    // failure mode this workflow exists to prevent.
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(REGISTRATION_COLUMNS)
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.status === "cancelled") {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(registrations)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: options.reason,
        cancellationNote: options.note?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, registrationId))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    const money = await moneyByRegistration(tx, [registrationId]);
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration",
      entityId: registrationId,
      action: "cancel",
      before: { status: before.status, year: before.year },
      after: {
        status: "cancelled",
        reason: options.reason,
        note: options.note?.trim() || null,
      },
    });
    return {
      ok: true,
      registration: toRegistrationDto(
        row,
        money.get(registrationId) ?? emptyLedgerAggregate(),
      ),
    };
  });
}

// --- Non-payment resolution -----------------------------------------------------

// Waive / mark complimentary — resolves the obligation WITHOUT a
// payment row. The resolution is deliberate staff action, audited;
// clearing it again (resolution null) is allowed and audited too.
export async function resolveRegistrationFee(
  registrationId: string,
  options: {
    resolution: RegistrationResolution;
    note?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationMutationResult> {
  if (!UUID_RE.test(registrationId)) return { ok: false, reason: "invalid" };
  if (!isRegistrationResolution(options.resolution)) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(REGISTRATION_COLUMNS)
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.status !== "active") {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(registrations)
      .set({
        resolution: options.resolution,
        resolutionNote: options.note?.trim() || null,
        resolvedAt: new Date(),
        resolvedBy: actorLabel,
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, registrationId))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    const money = await moneyByRegistration(tx, [registrationId]);
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration",
      entityId: registrationId,
      action: "resolve-fee",
      before: { resolution: before.resolution },
      after: {
        resolution: options.resolution,
        note: options.note?.trim() || null,
      },
    });
    return {
      ok: true,
      registration: toRegistrationDto(
        row,
        money.get(registrationId) ?? emptyLedgerAggregate(),
      ),
    };
  });
}

// --- Corrections ---------------------------------------------------------------

// Correct the assessed amount — history is the audit event carrying
// before/after; the row keeps the corrected value. A wrong ROW (animal,
// year) is a cancellation+correction, not an amount edit.
export async function correctRegistrationAmount(
  registrationId: string,
  amountDueCents: number,
  note: string | null | undefined,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationMutationResult> {
  if (!UUID_RE.test(registrationId)) return { ok: false, reason: "invalid" };
  if (!Number.isInteger(amountDueCents) || amountDueCents < 0) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(REGISTRATION_COLUMNS)
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.status !== "active") {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(registrations)
      .set({
        amountDueCents,
        notes:
          note?.trim() ||
          before.notes,
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, registrationId))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    const money = await moneyByRegistration(tx, [registrationId]);
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration",
      entityId: registrationId,
      action: "correct-amount",
      before: { amountDueCents: before.amountDueCents },
      after: { amountDueCents, note: note?.trim() || null },
    });
    return {
      ok: true,
      registration: toRegistrationDto(
        row,
        money.get(registrationId) ?? emptyLedgerAggregate(),
      ),
    };
  });
}

// Staff notes — a plain editable annotation on the registration.
export async function updateRegistrationNotes(
  registrationId: string,
  notes: string | null,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationMutationResult> {
  if (!UUID_RE.test(registrationId)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(REGISTRATION_COLUMNS)
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };

    const [row] = await tx
      .update(registrations)
      .set({ notes: notes?.trim() || null, updatedAt: new Date() })
      .where(eq(registrations.id, registrationId))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    const money = await moneyByRegistration(tx, [registrationId]);
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "registration",
      entityId: registrationId,
      action: "update-notes",
      // Notes can contain free text — the audit records that they
      // changed, not the content itself, to keep PII out of the log.
      before: { notesSet: before.notes !== null },
      after: { notesSet: row.notes !== null },
    });
    return {
      ok: true,
      registration: toRegistrationDto(
        row,
        money.get(registrationId) ?? emptyLedgerAggregate(),
      ),
    };
  });
}

// --- Manual payment recording -----------------------------------------------------
// The registration-side seam into the #170 ledger. The write itself is
// recordManualPayment in ./payments — the authoritative ledger service
// owns every money mutation (idempotency, events, locking); this
// wrapper only adapts the result back to the RegistrationRecord shape
// callers already consume.
export {
  MANUAL_PAYMENT_METHODS,
  type ManualPaymentMethod,
} from "../payments";

export type RecordPaymentResult =
  | { ok: true; paymentId: string; registration: RegistrationRecord }
  | { ok: false; reason: "invalid" | "not-found" | "conflict" };

export async function recordRegistrationPayment(
  registrationId: string,
  options: {
    amountCents: number;
    method: ManualPaymentMethod;
    occurredOn?: string;
    reference?: string | null;
    note?: string | null;
    pending?: boolean;
    idempotencyKey?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<RecordPaymentResult> {
  const result = await recordManualPayment(
    registrationId,
    options,
    actorLabel,
    db,
  );
  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.reason === "exceeds-refundable" ? "invalid" : result.reason,
    };
  }
  const [reg] = await db
    .select(REGISTRATION_COLUMNS)
    .from(registrations)
    .where(eq(registrations.id, registrationId));
  if (!reg) return { ok: false, reason: "not-found" };
  const money = await moneyByRegistration(db, [registrationId]);
  return {
    ok: true,
    paymentId: result.paymentId,
    registration: toRegistrationDto(
      reg,
      money.get(registrationId) ?? emptyLedgerAggregate(),
    ),
  };
}

// --- Current-period eligibility --------------------------------------------------
// THE canonical "is this animal registered for the current period"
// source — dashboard, queues, portal, and the #172 reminder evaluator
// all read this instead of re-deriving. Eligibility follows lifecycle:
// 'active' animals are expected to register; 'unknown' is unconfirmed
// rather than exempt, so it shows in the staff queue (humans decide);
// 'deceased'/'moved-off-saba' never appear as ordinary gaps.

// Lifecycle statuses that make an animal a candidate for current-period
// registration. 'unknown' is included: unconfirmed is not exempt.
export const REGISTRATION_ELIGIBLE_LIFECYCLES = [
  "active",
  "unknown",
] as const;

export interface UnregisteredAnimalItem {
  animalId: string;
  name: string;
  registryRef: string;
  species: string;
  sex: string;
  lifecycleStatus: string;
  // Deterministic current-owner label for triage (person preferred).
  ownerLabel: string | null;
}

// Eligible-lifecycle animals with NO active registration row for the
// period — the "still needs registration" queue. A cancelled row does
// not count as registered: its (animal, year) slot stays taken, and the
// animal correctly reappears here for staff to re-register properly.
export async function listUnregisteredAnimals(
  {
    year = currentRegistrationYear(),
    asOf = todayIsoDate(),
    lifecycleStatuses = [...REGISTRATION_ELIGIBLE_LIFECYCLES],
  }: {
    year?: number;
    asOf?: string;
    lifecycleStatuses?: string[];
  } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<UnregisteredAnimalItem[]> {
  if (!isRegistrationYear(year) || !isIsoDateString(asOf)) return [];
  const currentOwner = currentOwnershipSq(db, asOf, "reg_owner");
  const rows = await db
    .select({
      animalId: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      species: animals.species,
      sex: animals.sex,
      lifecycleStatus: animals.lifecycleStatus,
      personName: persons.fullName,
      householdName: households.name,
    })
    .from(animals)
    .leftJoin(currentOwner, eq(currentOwner.animalId, animals.id))
    .leftJoin(persons, eq(currentOwner.personId, persons.id))
    .leftJoin(households, eq(currentOwner.householdId, households.id))
    .where(
      and(
        inArray(animals.lifecycleStatus, lifecycleStatuses),
        sql`NOT EXISTS (
          SELECT 1 FROM registrations r
          WHERE r.animal_id = ${animals.id}
            AND r.year = ${year}
            AND r.status = 'active'
        )`,
      ),
    )
    .orderBy(asc(animals.name), asc(animals.id));
  return rows.map((r) => ({
    animalId: r.animalId,
    name: r.name,
    registryRef: r.registryRef,
    species: r.species,
    sex: r.sex,
    lifecycleStatus: r.lifecycleStatus,
    ownerLabel: r.personName ?? r.householdName ?? null,
  }));
}

// --- Unpaid-balance candidates (#170) -----------------------------------------

export interface UnpaidRegistrationItem {
  registrationId: string;
  animalId: string;
  name: string;
  registryRef: string;
  lifecycleStatus: string;
  year: number;
  amountDueCents: number;
  outstandingCents: number;
  currency: string;
  registeredAt: string | null;
  ownerLabel: string | null;
}

// Active registrations whose canonical ledger balance is still
// outstanding — THE eligibility source for the unpaid-balance reminder
// (#172 activation) and the staff payment-follow-up view. Waived /
// complimentary / no-fee / cancelled rows never appear: resolution is
// filtered in SQL, zero-due is filtered in SQL, and the balance
// projection does the settled/unpaid arithmetic. `registeredBefore`
// (ISO date) applies the reminder's grace window — a registration
// recorded days ago with money possibly in transit is not eligible yet.
export async function listUnpaidRegistrations(
  {
    year = currentRegistrationYear(),
    asOf = todayIsoDate(),
    registeredBefore = null,
    lifecycleStatuses = ["active"],
  }: {
    year?: number;
    asOf?: string;
    registeredBefore?: string | null;
    lifecycleStatuses?: string[];
  } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<UnpaidRegistrationItem[]> {
  if (!isRegistrationYear(year) || !isIsoDateString(asOf)) return [];
  if (registeredBefore !== null && !isIsoDateString(registeredBefore)) {
    return [];
  }
  const currentOwner = currentOwnershipSq(db, asOf, "reg_owner");
  const rows = await db
    .select({
      registrationId: registrations.id,
      animalId: registrations.animalId,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
      year: registrations.year,
      amountDueCents: registrations.amountDueCents,
      currency: registrations.currency,
      resolution: registrations.resolution,
      registeredAt: registrations.registeredAt,
      personName: persons.fullName,
      householdName: households.name,
    })
    .from(registrations)
    .innerJoin(animals, eq(registrations.animalId, animals.id))
    .leftJoin(currentOwner, eq(currentOwner.animalId, animals.id))
    .leftJoin(persons, eq(currentOwner.personId, persons.id))
    .leftJoin(households, eq(currentOwner.householdId, households.id))
    .where(
      and(
        eq(registrations.year, year),
        eq(registrations.status, "active"),
        isNull(registrations.resolution),
        gt(registrations.amountDueCents, 0),
        inArray(animals.lifecycleStatus, lifecycleStatuses),
        registeredBefore !== null
          ? lte(registrations.registeredAt, sql`${registeredBefore}::date`)
          : undefined,
      ),
    )
    .orderBy(asc(animals.name), asc(registrations.id));
  if (rows.length === 0) return [];
  const money = await moneyByRegistration(
    db,
    rows.map((r) => r.registrationId),
  );
  const items: UnpaidRegistrationItem[] = [];
  for (const r of rows) {
    const balance = deriveRegistrationBalance(
      { amountDueCents: r.amountDueCents, resolution: null },
      money.get(r.registrationId) ?? emptyLedgerAggregate(),
    );
    if (balance.outstandingCents <= 0) continue;
    items.push({
      registrationId: r.registrationId,
      animalId: r.animalId,
      name: r.name,
      registryRef: r.registryRef,
      lifecycleStatus: r.lifecycleStatus,
      year: r.year,
      amountDueCents: r.amountDueCents,
      outstandingCents: balance.outstandingCents,
      currency: r.currency,
      registeredAt: r.registeredAt?.toISOString() ?? null,
      ownerLabel: r.personName ?? r.householdName ?? null,
    });
  }
  return items;
}

// --- Staff queues ------------------------------------------------------------

export interface RegistrationQueueItem {
  registrationId: string;
  animalId: string;
  animalName: string;
  registryRef: string;
  species: string;
  lifecycleStatus: string;
  ownerLabel: string | null;
  amountDueCents: number;
  currency: string;
  // Canonical balance projection (#170): paidCents is net settled
  // money, outstandingCents what is still owed. Partial payments and
  // refunds are real arithmetic, never flags.
  paidCents: number;
  outstandingCents: number;
  paymentState: RegistrationPaymentState;
  registeredAt: string | null;
}

export interface RegistrationQueues {
  year: number;
  // Eligible-lifecycle animals with no active current-period row.
  unregistered: UnregisteredAnimalItem[];
  // Intake count — submissions still awaiting staff review.
  pendingSubmissions: number;
  // Active current-period registrations whose derived state still owes
  // money (unpaid/partial) — real payment truth, never fabricated.
  outstanding: RegistrationQueueItem[];
  // Active current-period registrations fully resolved (paid, waived,
  // complimentary, or no fee assessed).
  completed: RegistrationQueueItem[];
}

// One pass over the queue sources — the exception-first staff view.
// All four buckets come from set-based queries; no per-row lookups.
export async function getRegistrationQueues(
  {
    year = currentRegistrationYear(),
    asOf = todayIsoDate(),
  }: { year?: number; asOf?: string } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationQueues> {
  const [unregistered, pendingCountRows, regRows] = await Promise.all([
    listUnregisteredAnimals({ year, asOf }, db),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(registrationSubmissions)
      .where(eq(registrationSubmissions.status, "pending")),
    db
      .select({
        ...REGISTRATION_COLUMNS,
        animalName: animals.name,
        registryRef: animals.registryRef,
        species: animals.species,
        lifecycleStatus: animals.lifecycleStatus,
      })
      .from(registrations)
      .innerJoin(animals, eq(registrations.animalId, animals.id))
      .where(
        and(
          eq(registrations.year, year),
          eq(registrations.status, "active"),
        ),
      )
      .orderBy(asc(animals.name), asc(registrations.id)),
  ]);

  const money = await moneyByRegistration(
    db,
    regRows.map((r) => r.id),
  );
  const items = regRows.map((r) => {
    const balance = deriveRegistrationBalance(
      {
        amountDueCents: r.amountDueCents,
        resolution: isRegistrationResolution(r.resolution)
          ? r.resolution
          : null,
      },
      money.get(r.id) ?? emptyLedgerAggregate(),
    );
    return {
      registrationId: r.id,
      animalId: r.animalId,
      animalName: r.animalName,
      registryRef: r.registryRef,
      species: r.species,
      lifecycleStatus: r.lifecycleStatus,
      ownerLabel: r.ownerLabel,
      amountDueCents: r.amountDueCents,
      currency: r.currency,
      paidCents: balance.settledCents,
      outstandingCents: balance.outstandingCents,
      paymentState: balance.paymentState,
      registeredAt: r.registeredAt?.toISOString() ?? null,
    } satisfies RegistrationQueueItem;
  });

  return {
    year,
    unregistered,
    pendingSubmissions: pendingCountRows[0]?.n ?? 0,
    outstanding: items.filter((i) =>
      (OUTSTANDING_PAYMENT_STATES as readonly string[]).includes(
        i.paymentState,
      ),
    ),
    completed: items.filter(
      (i) =>
        !(OUTSTANDING_PAYMENT_STATES as readonly string[]).includes(
          i.paymentState,
        ),
    ),
  };
}
