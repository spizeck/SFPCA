// Retention policy service (#130) — the ONE place automated
// deletion/anonymization decisions live. Route handlers and the cron
// entry point call runRetentionPass; nothing else in the app compares
// retention dates.
//
// Policy mapping (approved on #130, constants in src/lib/retention.ts):
//
//   Verified receipts — payment receipts exist to verify and reconcile
//   the payment, not to be kept forever. Once a submission's receipt is
//   server-verified (approval stamp or first confirmed payment —
//   receipt_verified_at) for longer than VERIFIED_RECEIPT_DAYS, the
//   Storage object is deleted and the row marked (payment_receipt_path
//   → NULL, receipt_purged_at set) so staff see a deliberate removal,
//   not a broken link. Structured ledger/audit facts are untouched.
//
//   Abandoned/unsuccessful submissions — a pending intake never decided
//   (submitted_at older than the window) or a rejected submission
//   (decided_at older than the window) is deleted outright once it has
//   no canonical descendants: a linked registration or payment makes it
//   a completed record instead, handled by the 7-year path. Its receipt
//   object goes with it.
//
//   Completed records — registrations and payments are kept for the
//   registration year + COMPLETED_RECORD_YEARS; past the boundary they
//   are ANONYMIZED, not deleted: the animal/registration/ledger facts
//   stay (canonical history + audit integrity) while intake PII
//   (submission owner name/contacts, free-text notes and references
//   that may embed personal details) is removed. A submission's
//   receipt that somehow survived to this point is purged with the
//   record — the binary must never outlive its retention window.
//
//   Holds — an active retention_holds row shields an entity (and, for
//   registrations, the linked submission/payments family) from every
//   automated path until staff deliberately release it.
//
// Safety rules throughout:
//   - idempotent: every step re-derives eligibility from current state;
//     re-running after partial failure converges, never double-acts;
//   - fail closed: rows lacking trustworthy timestamps are never
//     eligible — ambiguity always means "keep";
//   - bounded: each phase processes at most batchSize rows per run;
//   - no PII in logs: only counts and error codes are emitted — object
//     names are submission uuids and stay out of every log entry.

import "server-only";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  auditEvents,
  payments,
  registrationSubmissions,
  registrations,
  retentionHolds,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  abandonedSubmissionCutoff,
  ANONYMIZED_OWNER_NAME,
  isRetentionHoldEntityType,
  maxCompletedRetentionYear,
  RETENTION_BATCH_LIMIT,
  verifiedReceiptCutoff,
  type RetentionHoldEntityType,
} from "../retention";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETENTION_ACTOR = "retention-cron";

// Stamp the server-side verification timestamp on a submission's
// receipt. First-writer-wins — the earliest trustworthy signal
// (staff approval or the first confirmed payment) anchors the 90-day
// clock; later confirmations never move it. A no-op for submissions
// carrying no receipt. Called inside the caller's transaction so the
// stamp commits with the verifying act it belongs to.
export async function stampReceiptVerified(
  tx: Pick<RegistryDb, "update">,
  submissionId: string,
): Promise<void> {
  await tx
    .update(registrationSubmissions)
    .set({
      receiptVerifiedAt: sql`coalesce(${registrationSubmissions.receiptVerifiedAt}, now())`,
    })
    .where(
      and(
        eq(registrationSubmissions.id, submissionId),
        isNotNull(registrationSubmissions.paymentReceiptPath),
      ),
    );
}

// Minimal storage surface — the GCS Bucket satisfies it; tests fake it.
export interface RetentionBucket {
  file(path: string): { delete(): Promise<unknown> };
}

interface RetentionLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

export interface RetentionHoldRecord {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  createdByLabel: string;
  createdAt: string;
}

export interface RetentionSummary {
  asOf: string;
  dryRun: boolean;
  receipts: {
    eligible: number;
    purged: number;
    heldSkipped: number;
    failed: number;
  };
  abandonedSubmissions: {
    eligible: number;
    deleted: number;
    heldSkipped: number;
    linkedSkipped: number;
    failed: number;
  };
  completedRecords: {
    // Registrations whose year has entered the 7-year window — the
    // unit staff think in ("N completed records are expiring").
    registrationsEligible: number;
    registrationsHeld: number;
    submissionsAnonymized: number;
    registrationsAnonymized: number;
    paymentsAnonymized: number;
    heldSkipped: number;
    failed: number;
  };
}

// --- Holds ------------------------------------------------------------------

export type HoldResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "conflict" | "not-found" };

async function holdTargetExists(
  tx: Pick<RegistryDb, "select">,
  entityType: RetentionHoldEntityType,
  entityId: string,
): Promise<boolean> {
  if (entityType === "registration_submission") {
    const [row] = await tx
      .select({ id: registrationSubmissions.id })
      .from(registrationSubmissions)
      .where(eq(registrationSubmissions.id, entityId))
      .limit(1);
    return !!row;
  }
  const [row] = await tx
    .select({ id: registrations.id })
    .from(registrations)
    .where(eq(registrations.id, entityId))
    .limit(1);
  return !!row;
}

// Apply a documented exemption. Admin-driven via server actions — the
// hold row plus its audit_events entry commit together. A second active
// hold on the same entity is a conflict, never a silent replace.
export async function applyRetentionHold(
  entityType: RetentionHoldEntityType,
  entityId: string,
  reason: string,
  actorLabel: string,
  actorIdentityId?: string | null,
  db: RegistryDb = getRegistryDb(),
): Promise<HoldResult> {
  const trimmed = reason?.trim();
  if (
    !isRetentionHoldEntityType(entityType) ||
    !UUID_RE.test(entityId) ||
    !trimmed ||
    !actorLabel
  ) {
    return { ok: false, reason: "invalid" };
  }

  try {
    return await db.transaction(async (tx) => {
      if (!(await holdTargetExists(tx, entityType, entityId))) {
        return { ok: false as const, reason: "not-found" as const };
      }
      const [hold] = await tx
        .insert(retentionHolds)
        .values({
          entityType,
          entityId,
          reason: trimmed,
          createdByLabel: actorLabel,
          createdByIdentityId: actorIdentityId ?? null,
        })
        .returning();
      if (!hold) return { ok: false as const, reason: "invalid" as const };
      await tx.insert(auditEvents).values({
        actorLabel,
        entityType,
        entityId,
        action: "retention-hold",
        after: { reason: trimmed },
      });
      return { ok: true as const };
    });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const cause = (error as { cause?: { code?: unknown } })?.cause;
    if (code === "23505" || cause?.code === "23505") {
      return { ok: false, reason: "conflict" };
    }
    throw error;
  }
}

// Release the active hold — the row stays as exemption history with
// removed_* stamped, the audit log gets the counterpart entry.
export async function releaseRetentionHold(
  entityType: RetentionHoldEntityType,
  entityId: string,
  actorLabel: string,
  actorIdentityId?: string | null,
  db: RegistryDb = getRegistryDb(),
): Promise<HoldResult> {
  if (
    !isRetentionHoldEntityType(entityType) ||
    !UUID_RE.test(entityId) ||
    !actorLabel
  ) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [hold] = await tx
      .select({ id: retentionHolds.id })
      .from(retentionHolds)
      .where(
        and(
          eq(retentionHolds.entityType, entityType),
          eq(retentionHolds.entityId, entityId),
          isNull(retentionHolds.removedAt),
        ),
      )
      .for("update");
    if (!hold) return { ok: false as const, reason: "not-found" as const };

    await tx
      .update(retentionHolds)
      .set({
        removedAt: new Date(),
        removedByLabel: actorLabel,
        removedByIdentityId: actorIdentityId ?? null,
      })
      .where(eq(retentionHolds.id, hold.id));
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType,
      entityId,
      action: "retention-hold-release",
    });
    return { ok: true as const };
  });
}

// Active holds for a set of entities — the admin "is this record
// exempt?" read. Returns a Map for O(1) panel checks.
export async function listActiveHoldsFor(
  entityType: RetentionHoldEntityType,
  entityIds: string[],
  db: RegistryDb = getRegistryDb(),
): Promise<Map<string, RetentionHoldRecord>> {
  const map = new Map<string, RetentionHoldRecord>();
  const ids = entityIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(retentionHolds)
    .where(
      and(
        eq(retentionHolds.entityType, entityType),
        inArray(retentionHolds.entityId, ids),
        isNull(retentionHolds.removedAt),
      ),
    );
  for (const r of rows) {
    map.set(r.entityId, {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      reason: r.reason,
      createdByLabel: r.createdByLabel,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return map;
}

// --- Purge run ----------------------------------------------------------------

function isStorageNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 404 || code === "404";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  return (error as { name?: string })?.name ?? "unknown";
}

// Delete the object, tolerating "already gone" — the purge is
// idempotent whether the object vanished via an earlier run, the orphan
// sweep, or a manual delete.
async function deleteReceiptObject(
  bucket: RetentionBucket,
  path: string,
): Promise<void> {
  try {
    await bucket.file(path).delete();
  } catch (error) {
    if (!isStorageNotFound(error)) throw error;
  }
}

async function linkedRecordsExist(
  db: Pick<RegistryDb, "select">,
  submissionId: string,
): Promise<boolean> {
  const [reg] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.submissionId, submissionId));
  if ((reg?.n ?? 0) > 0) return true;
  const [pay] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(eq(payments.submissionId, submissionId));
  return (pay?.n ?? 0) > 0;
}

export async function runRetentionPass({
  db = getRegistryDb(),
  bucket,
  now = new Date(),
  dryRun = true,
  batchSize = RETENTION_BATCH_LIMIT,
  log = console,
  runId,
}: {
  db?: RegistryDb;
  bucket: RetentionBucket;
  now?: Date;
  dryRun?: boolean;
  batchSize?: number;
  log?: RetentionLogger;
  runId?: string;
}): Promise<RetentionSummary> {
  const base = { subsystem: "retention", operation: "purge", runId };
  const limit = Math.min(Math.max(batchSize, 1), 500);

  const summary: RetentionSummary = {
    asOf: now.toISOString(),
    dryRun,
    receipts: { eligible: 0, purged: 0, heldSkipped: 0, failed: 0 },
    abandonedSubmissions: {
      eligible: 0,
      deleted: 0,
      heldSkipped: 0,
      linkedSkipped: 0,
      failed: 0,
    },
    completedRecords: {
      registrationsEligible: 0,
      registrationsHeld: 0,
      submissionsAnonymized: 0,
      registrationsAnonymized: 0,
      paymentsAnonymized: 0,
      heldSkipped: 0,
      failed: 0,
    },
  };

  // Active holds up front — one read, then every phase filters in
  // memory. Bounded by design (holds are a deliberate, rare action).
  const holdRows = await db
    .select({
      entityType: retentionHolds.entityType,
      entityId: retentionHolds.entityId,
    })
    .from(retentionHolds)
    .where(isNull(retentionHolds.removedAt));
  const heldSubmissions = new Set(
    holdRows
      .filter((h) => h.entityType === "registration_submission")
      .map((h) => h.entityId),
  );
  const heldRegistrations = new Set(
    holdRows
      .filter((h) => h.entityType === "registration")
      .map((h) => h.entityId),
  );

  // --- Phase 1: verified receipts older than 90 days ---------------------
  const receiptRows = await db
    .select({
      id: registrationSubmissions.id,
      paymentReceiptPath: registrationSubmissions.paymentReceiptPath,
    })
    .from(registrationSubmissions)
    .where(
      and(
        isNotNull(registrationSubmissions.paymentReceiptPath),
        isNull(registrationSubmissions.receiptPurgedAt),
        isNotNull(registrationSubmissions.receiptVerifiedAt),
        lte(
          registrationSubmissions.receiptVerifiedAt,
          verifiedReceiptCutoff(now),
        ),
      ),
    )
    .orderBy(asc(registrationSubmissions.receiptVerifiedAt))
    .limit(limit);

  for (const row of receiptRows) {
    if (heldSubmissions.has(row.id)) {
      summary.receipts.heldSkipped++;
      continue;
    }
    const path = row.paymentReceiptPath;
    if (!path) continue; // impossible per WHERE — belt
    summary.receipts.eligible++;
    if (dryRun) continue;
    try {
      await deleteReceiptObject(bucket, path);
      const purgedAt = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(auditEvents).values({
          actorLabel: RETENTION_ACTOR,
          entityType: "registration_submission",
          entityId: row.id,
          action: "receipt-retention-purge",
          before: { receiptPresent: true },
          after: { receiptPresent: false },
        });
        await tx
          .update(registrationSubmissions)
          .set({
            paymentReceiptPath: null,
            receiptPurgedAt: purgedAt,
            updatedAt: purgedAt,
          })
          .where(
            and(
              eq(registrationSubmissions.id, row.id),
              eq(registrationSubmissions.paymentReceiptPath, path),
            ),
          );
      });
      summary.receipts.purged++;
    } catch (error) {
      summary.receipts.failed++;
      log.warn({
        ...base,
        phase: "receipts",
        outcome: "row-failed",
        errorCode: errorCode(error),
      });
    }
  }

  // --- Phase 2: abandoned / unsuccessful submissions ----------------------
  const abandonedCutoff = abandonedSubmissionCutoff(now);
  const abandonedRows = await db
    .select({
      id: registrationSubmissions.id,
      status: registrationSubmissions.status,
      paymentReceiptPath: registrationSubmissions.paymentReceiptPath,
    })
    .from(registrationSubmissions)
    .where(
      or(
        and(
          eq(registrationSubmissions.status, "pending"),
          lte(registrationSubmissions.submittedAt, abandonedCutoff),
        ),
        and(
          eq(registrationSubmissions.status, "rejected"),
          isNotNull(registrationSubmissions.decidedAt),
          lte(registrationSubmissions.decidedAt, abandonedCutoff),
        ),
      ),
    )
    .orderBy(asc(registrationSubmissions.submittedAt))
    .limit(limit);

  for (const row of abandonedRows) {
    if (heldSubmissions.has(row.id)) {
      summary.abandonedSubmissions.heldSkipped++;
      continue;
    }
    try {
      // A submission that produced canonical descendants is a completed
      // record, not an abandoned one — the 7-year path owns it.
      if (await linkedRecordsExist(db, row.id)) {
        summary.abandonedSubmissions.linkedSkipped++;
        continue;
      }
      summary.abandonedSubmissions.eligible++;
      if (dryRun) continue;
      if (row.paymentReceiptPath) {
        await deleteReceiptObject(bucket, row.paymentReceiptPath);
      }
      await db.transaction(async (tx) => {
        // The audit row is written first and survives the delete —
        // entity_id is text precisely so history can outlive the row.
        await tx.insert(auditEvents).values({
          actorLabel: RETENTION_ACTOR,
          entityType: "registration_submission",
          entityId: row.id,
          action: "retention-delete",
          before: { status: row.status },
          after: null,
        });
        await tx
          .delete(registrationSubmissions)
          .where(eq(registrationSubmissions.id, row.id));
      });
      summary.abandonedSubmissions.deleted++;
    } catch (error) {
      summary.abandonedSubmissions.failed++;
      log.warn({
        ...base,
        phase: "abandoned",
        outcome: "row-failed",
        errorCode: errorCode(error),
      });
    }
  }

  // --- Phase 3: completed records past the 7-year window ------------------
  const maxYear = maxCompletedRetentionYear(now);
  // The submission-year equivalent: submitted_at earlier than the first
  // day AFTER the last eligible year.
  const submittedBefore = new Date(Date.UTC(maxYear + 1, 0, 1));

  const [eligibleRegs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(lte(registrations.year, maxYear));
  summary.completedRecords.registrationsEligible = eligibleRegs?.n ?? 0;
  summary.completedRecords.registrationsHeld = heldRegistrations.size
    ? (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(registrations)
          .where(
            and(
              lte(registrations.year, maxYear),
              inArray(registrations.id, [...heldRegistrations]),
            ),
          )
      )[0]?.n ?? 0
    : 0;

  // 3a — submission PII anonymization. Eligible when the submission's
  // own year is inside the window AND no linked registration still
  // retains a newer year (a 2018 intake backfilled into a 2019
  // registration follows 2019's window). Already-anonymized rows are
  // excluded by the PII-present predicate — reruns are no-ops.
  const expiredSubmissions = await db
    .select({
      id: registrationSubmissions.id,
      status: registrationSubmissions.status,
      paymentReceiptPath: registrationSubmissions.paymentReceiptPath,
    })
    .from(registrationSubmissions)
    .where(
      and(
        lt(registrationSubmissions.submittedAt, submittedBefore),
        or(
          isNotNull(registrationSubmissions.ownerAddress),
          isNotNull(registrationSubmissions.ownerPhone),
          isNotNull(registrationSubmissions.ownerEmail),
          sql`${registrationSubmissions.ownerName} <> ${ANONYMIZED_OWNER_NAME}`,
          isNotNull(registrationSubmissions.paymentReceiptPath),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM ${registrations} r
          WHERE r.submission_id = ${registrationSubmissions.id}
            AND r.year > ${maxYear}
        )`,
      ),
    )
    .orderBy(asc(registrationSubmissions.submittedAt))
    .limit(limit);

  for (const row of expiredSubmissions) {
    if (heldSubmissions.has(row.id)) {
      summary.completedRecords.heldSkipped++;
      continue;
    }
    try {
      // A hold on any linked registration protects the submission's PII
      // too — the intake record is evidence for that registration.
      const linkedHeld = heldRegistrations.size
        ? (
            await db
              .select({ n: sql<number>`count(*)::int` })
              .from(registrations)
              .where(
                and(
                  eq(registrations.submissionId, row.id),
                  inArray(registrations.id, [...heldRegistrations]),
                ),
              )
          )[0]?.n ?? 0
        : 0;

      if (linkedHeld > 0) {
        summary.completedRecords.heldSkipped++;
        continue;
      }
      if (dryRun) {
        summary.completedRecords.submissionsAnonymized++;
        continue;
      }
      if (row.paymentReceiptPath) {
        await deleteReceiptObject(bucket, row.paymentReceiptPath);
      }
      const purgedAt = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(auditEvents).values({
          actorLabel: RETENTION_ACTOR,
          entityType: "registration_submission",
          entityId: row.id,
          action: "retention-anonymize",
          before: { ownerPii: "present" },
          after: { ownerPii: "removed" },
        });
        await tx
          .update(registrationSubmissions)
          .set({
            ownerName: ANONYMIZED_OWNER_NAME,
            ownerAddress: null,
            ownerPhone: null,
            ownerEmail: null,
            paymentReceiptPath: null,
            ...(row.paymentReceiptPath
              ? { receiptPurgedAt: purgedAt }
              : {}),
            updatedAt: purgedAt,
          })
          .where(eq(registrationSubmissions.id, row.id));
      });
      summary.completedRecords.submissionsAnonymized++;
    } catch (error) {
      summary.completedRecords.failed++;
      log.warn({
        ...base,
        phase: "completed-submissions",
        outcome: "row-failed",
        errorCode: errorCode(error),
      });
    }
  }

  // 3b — registration free-text fields. The row itself is canonical
  // animal history and stays; notes are the only place stray PII can
  // hide. Held registrations are excluded from the update entirely.
  const registrationWhere = and(
    lte(registrations.year, maxYear),
    or(
      isNotNull(registrations.notes),
      isNotNull(registrations.resolutionNote),
      isNotNull(registrations.cancellationNote),
    ),
    heldRegistrations.size
      ? notInArray(registrations.id, [...heldRegistrations])
      : undefined,
  );
  if (dryRun) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(registrations)
      .where(registrationWhere);
    summary.completedRecords.registrationsAnonymized = r?.n ?? 0;
  } else {
    try {
      const updated = await db
        .update(registrations)
        .set({
          notes: null,
          resolutionNote: null,
          cancellationNote: null,
          updatedAt: new Date(),
        })
        .where(registrationWhere)
        .returning();
      summary.completedRecords.registrationsAnonymized = updated.length;
    } catch (error) {
      summary.completedRecords.failed++;
      log.warn({
        ...base,
        phase: "completed-registrations",
        outcome: "batch-failed",
        errorCode: errorCode(error),
      });
    }
  }

  // 3c — payment reference/note fields on expired registrations plus
  // orphan payments aged by their own occurrence year. Ledger facts
  // (amount, status, method, linkage, occurred_at) are preserved.
  const paymentWhere = and(
    or(isNotNull(payments.reference), isNotNull(payments.note)),
    or(
      and(
        isNotNull(payments.registrationId),
        sql`${payments.registrationId} IN (
          SELECT id FROM ${registrations} r WHERE r.year <= ${maxYear}
        )`,
      ),
      and(
        isNull(payments.registrationId),
        lt(payments.occurredAt, submittedBefore),
      ),
    ),
    heldRegistrations.size
      ? or(
          isNull(payments.registrationId),
          notInArray(payments.registrationId, [...heldRegistrations]),
        )
      : undefined,
  );
  if (dryRun) {
    const [p] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(paymentWhere);
    summary.completedRecords.paymentsAnonymized = p?.n ?? 0;
  } else {
    try {
      const updated = await db
        .update(payments)
        .set({ reference: null, note: null, updatedAt: new Date() })
        .where(paymentWhere)
        .returning();
      summary.completedRecords.paymentsAnonymized = updated.length;
    } catch (error) {
      summary.completedRecords.failed++;
      log.warn({
        ...base,
        phase: "completed-payments",
        outcome: "batch-failed",
        errorCode: errorCode(error),
      });
    }
  }

  const failed =
    summary.receipts.failed +
    summary.abandonedSubmissions.failed +
    summary.completedRecords.failed;
  const out = { ...base, ...summary, failed };
  if (failed > 0) {
    log.error({ ...out, outcome: "partial-failure" });
  } else {
    log.info({ ...out, outcome: dryRun ? "dry-run" : "ok" });
  }
  return summary;
}
