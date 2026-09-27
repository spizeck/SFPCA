// The authoritative registration payment ledger (#170). `payments` is
// the provider-neutral transaction table; `payment_events` is its
// append-only reconciliation history. This module is the ONLY write
// path for ledger money and the ONE shared projection every consumer —
// staff view, queues, portal, reminder evaluator, future provider
// reconciliation (#171) — reads through.
//
// Payment initiation is not payment truth:
//   - 'pending' rows are declared intent (a checkout, a claimed bank
//     transfer) and NEVER settle a balance;
//   - only 'confirmed' rows move money;
//   - 'failed'/'void' are terminal non-events;
//   - a browser return, checkout creation, or "payment started" event
//     must never independently mark a registration paid — only an
//     authoritative server-side path (staff confirmation or the
//     provider reconciliation seam) creates confirmed money.
//
// Money is append-oriented: a confirmed row is never rewritten —
// refunds, corrections, and adjustments are new rows; status
// transitions (pending → confirmed/failed/void) and the reconciliation
// trail land in payment_events inside the same transaction.
//
// Concurrency: every mutation locks the parent row it acts on
// (registration for new money, the payment itself for confirm/void/
// refund) so concurrent staff or provider actions serialize instead of
// producing impossible balances. Idempotency is two-layered: the
// caller-supplied idempotency_key and the (provider, provider_ref)
// pair both resolve retries to the existing row.

import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  paymentEvents,
  payments,
  registrations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  deriveRegistrationBalance,
  emptyLedgerAggregate,
  isManualPaymentMethod,
  type LedgerAggregate,
  type ManualPaymentMethod,
  type PaymentSource,
  type RegistrationBalance,
} from "../payments";
import { isRegistrationResolution } from "../registrations";
import { isIsoDateString } from "../vaccinations";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Queryable/Tx pattern shared across registry services: a
// transaction object satisfies it, so helpers compose inside one tx.
type Queryable = Pick<RegistryDb, "select">;

// --- Balance projection --------------------------------------------------------
// THE canonical money read. One set-based aggregate per batch of
// registrations — never per-row arithmetic scattered across callers.

// Confirmed-ledger aggregates for each registration: received,
// refunded, adjustments, and pending money (which must NOT settle).
// Returns a Map for O(1) lookup; registrations with no ledger rows are
// absent — callers treat that as emptyLedgerAggregate().
export async function moneyByRegistration(
  db: Pick<RegistryDb, "select">,
  registrationIds: string[],
): Promise<Map<string, LedgerAggregate>> {
  const map = new Map<string, LedgerAggregate>();
  if (registrationIds.length === 0) return map;
  const rows = await db
    .select({
      registrationId: payments.registrationId,
      received: sql<number>`coalesce(sum(CASE WHEN ${payments.kind} = 'payment' AND ${payments.status} = 'confirmed' THEN ${payments.amountCents} ELSE 0 END), 0)::int`,
      refunded: sql<number>`coalesce(sum(CASE WHEN ${payments.kind} = 'refund' AND ${payments.status} = 'confirmed' THEN ${payments.amountCents} ELSE 0 END), 0)::int`,
      adjusted: sql<number>`coalesce(sum(CASE WHEN ${payments.kind} = 'adjustment' AND ${payments.status} = 'confirmed' THEN ${payments.amountCents} ELSE 0 END), 0)::int`,
      pending: sql<number>`coalesce(sum(CASE WHEN ${payments.kind} = 'payment' AND ${payments.status} = 'pending' THEN ${payments.amountCents} ELSE 0 END), 0)::int`,
    })
    .from(payments)
    .where(inArray(payments.registrationId, registrationIds))
    .groupBy(payments.registrationId);
  for (const r of rows) {
    if (!r.registrationId) continue;
    map.set(r.registrationId, {
      receivedCents: r.received,
      refundedCents: r.refunded,
      adjustmentCents: r.adjusted,
      pendingCents: r.pending,
    });
  }
  return map;
}

// Net confirmed cents applied to each registration — the projection the
// #169 DTOs consume. Payments and positive adjustments add, refunds
// subtract; pending/failed/void never count.
export async function confirmedPaidByRegistration(
  db: Pick<RegistryDb, "select">,
  registrationIds: string[],
): Promise<Map<string, number>> {
  const aggregates = await moneyByRegistration(db, registrationIds);
  const map = new Map<string, number>();
  for (const [id, agg] of aggregates) {
    map.set(
      id,
      agg.receivedCents - agg.refundedCents + agg.adjustmentCents,
    );
  }
  return map;
}

// The canonical balance for one registration row — derived, never
// stored. `reg` needs only the obligation fields.
export async function registrationBalance(
  reg: { id: string; amountDueCents: number; resolution: string | null },
  db: Pick<RegistryDb, "select">,
): Promise<RegistrationBalance> {
  const aggregates = await moneyByRegistration(db, [reg.id]);
  return deriveRegistrationBalance(
    {
      amountDueCents: reg.amountDueCents,
      resolution: isRegistrationResolution(reg.resolution)
        ? reg.resolution
        : null,
    },
    aggregates.get(reg.id) ?? emptyLedgerAggregate(),
  );
}

// --- Ledger reads ----------------------------------------------------------------

export interface PaymentRecord {
  id: string;
  registrationId: string | null;
  submissionId: string | null;
  personId: string | null;
  amountCents: number;
  currency: string;
  kind: string;
  status: string;
  method: string;
  source: string;
  provider: string | null;
  providerRef: string | null;
  reference: string | null;
  relatedPaymentId: string | null;
  recordedBy: string | null;
  note: string | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

const PAYMENT_COLUMNS = {
  id: payments.id,
  registrationId: payments.registrationId,
  submissionId: payments.submissionId,
  personId: payments.personId,
  amountCents: payments.amountCents,
  currency: payments.currency,
  kind: payments.kind,
  status: payments.status,
  method: payments.method,
  source: payments.source,
  provider: payments.provider,
  providerRef: payments.providerRef,
  reference: payments.reference,
  relatedPaymentId: payments.relatedPaymentId,
  idempotencyKey: payments.idempotencyKey,
  recordedBy: payments.recordedBy,
  note: payments.note,
  occurredAt: payments.occurredAt,
  createdAt: payments.createdAt,
  updatedAt: payments.updatedAt,
} as const;

type PaymentRow = Pick<
  typeof payments.$inferSelect,
  keyof typeof PAYMENT_COLUMNS
>;

function toPaymentDto(row: PaymentRow): PaymentRecord {
  const { idempotencyKey: _key, ...rest } = row;
  return {
    ...rest,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Every ledger row for one registration — the staff ledger view. Newest
// money first; statuses are shown as-is (pending/failed/void stay
// visible — they are part of the truth).
export async function listPaymentsForRegistration(
  registrationId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentRecord[]> {
  if (!UUID_RE.test(registrationId)) return [];
  const rows = await db
    .select(PAYMENT_COLUMNS)
    .from(payments)
    .where(eq(payments.registrationId, registrationId))
    .orderBy(desc(payments.occurredAt), desc(payments.createdAt));
  return rows.map(toPaymentDto);
}

// Ledger rows for every registration of one animal — the animal
// profile's payment section. Payments reach the animal only through a
// registration; there is deliberately no payments.animal_id.
export async function listPaymentsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(PAYMENT_COLUMNS)
    .from(payments)
    .innerJoin(registrations, eq(payments.registrationId, registrations.id))
    .where(eq(registrations.animalId, animalId))
    .orderBy(desc(payments.occurredAt), desc(payments.createdAt));
  return rows.map(toPaymentDto);
}

// --- Reconciliation queue (#177) ---------------------------------------------------
// Pending rows are declared intent that never settles a balance — a
// claimed bank transfer or in-flight provider checkout sits here until
// staff confirm it arrived or void it. This is THE canonical "payments
// requiring reconciliation" read: the registrations page's
// awaiting-confirmation section and the #177 dashboard compose it.
// Newest first; bounded — a reconciliation backlog should never be
// huge, but a runaway provider loop shouldn't page the whole ledger.
export interface PendingPaymentItem {
  paymentId: string;
  registrationId: string | null;
  animalId: string | null;
  animalName: string | null;
  registryRef: string | null;
  amountCents: number;
  currency: string;
  method: string;
  reference: string | null;
  recordedBy: string | null;
  occurredAt: string;
}

export async function listPendingPayments(
  { limit = 100 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<PendingPaymentItem[]> {
  const rows = await db
    .select({
      paymentId: payments.id,
      registrationId: payments.registrationId,
      animalId: registrations.animalId,
      animalName: animals.name,
      registryRef: animals.registryRef,
      amountCents: payments.amountCents,
      currency: payments.currency,
      method: payments.method,
      reference: payments.reference,
      recordedBy: payments.recordedBy,
      occurredAt: payments.occurredAt,
    })
    .from(payments)
    .leftJoin(registrations, eq(payments.registrationId, registrations.id))
    .leftJoin(animals, eq(registrations.animalId, animals.id))
    .where(and(eq(payments.status, "pending"), eq(payments.kind, "payment")))
    .orderBy(asc(payments.occurredAt), asc(payments.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    ...r,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

export interface PaymentEventRecord {
  id: string;
  paymentId: string;
  event: string;
  actorLabel: string | null;
  source: string;
  detail: unknown;
  createdAt: string;
}

// Reconciliation history for a batch of payments — who/what changed
// each transaction and when, oldest first per payment.
export async function listPaymentEvents(
  paymentIds: string[],
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentEventRecord[]> {
  const ids = paymentIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(paymentEvents)
    .where(inArray(paymentEvents.paymentId, ids))
    .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
}

// --- Shared write helpers --------------------------------------------------------

// Every ledger mutation's audit pair: the append-only payment_events
// row (domain reconciliation history) and — for staff-driven actions —
// an audit_events row (the privileged-mutation trail). Provider-source
// events skip the audit row: their trail IS the event history.
async function recordPaymentEvent(
  tx: Pick<RegistryDb, "insert">,
  input: {
    paymentId: string;
    event:
      | "recorded"
      | "confirmed"
      | "failed"
      | "voided"
      | "refunded"
      | "adjusted";
    actorLabel: string | null;
    source: PaymentSource;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(paymentEvents).values({
    paymentId: input.paymentId,
    event: input.event,
    actorLabel: input.actorLabel,
    source: input.source,
    detail: input.detail ?? null,
  });
}

async function auditPaymentMutation(
  tx: Pick<RegistryDb, "insert">,
  input: {
    action: string;
    paymentId: string;
    actorLabel: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    actorLabel: input.actorLabel,
    entityType: "payment",
    entityId: input.paymentId,
    action: input.action,
    before: input.before ?? null,
    after: input.after ?? null,
  });
}

const LOCKED_REGISTRATION_COLUMNS = {
  id: registrations.id,
  submissionId: registrations.submissionId,
  personId: registrations.personId,
  status: registrations.status,
  amountDueCents: registrations.amountDueCents,
  currency: registrations.currency,
  resolution: registrations.resolution,
} as const;

// Lock and fetch the registration a ledger write acts on. All money
// writes serialize on this row so concurrent actions can never produce
// an impossible balance.
async function lockRegistration(
  tx: Queryable,
  registrationId: string,
) {
  const [reg] = await tx
    .select(LOCKED_REGISTRATION_COLUMNS)
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .for("update");
  return reg ?? null;
}

async function lockPayment(tx: Queryable, paymentId: string) {
  const [row] = await tx
    .select(PAYMENT_COLUMNS)
    .from(payments)
    .where(eq(payments.id, paymentId))
    .for("update");
  return row ?? null;
}

export type PaymentMutationResult =
  | {
      ok: true;
      paymentId: string;
      balance: RegistrationBalance;
      // False when an idempotent replay resolved to an existing row.
      created: boolean;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "not-found"
        | "conflict"
        | "exceeds-refundable";
    };

async function balanceForReg(
  tx: Pick<RegistryDb, "select">,
  reg: {
    id: string;
    amountDueCents: number;
    resolution: string | null;
  },
): Promise<RegistrationBalance> {
  return registrationBalance(reg, tx);
}

// Map a unique-violation (SQLSTATE 23505) from either the postgres.js
// driver (error.code) or PGlite/drizzle wrapping (error.cause.code).
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return code === "23505" || cause?.code === "23505";
}

// --- Manual payments (staff) -----------------------------------------------------

// Record money that actually arrived — or, for a bank transfer that is
// claimed but not yet visible, a 'pending' record staff confirm later.
// A pending record NEVER settles the balance; only the explicit
// confirmPayment reconciliation turns it into money truth.
export async function recordManualPayment(
  registrationId: string,
  options: {
    amountCents: number;
    method: ManualPaymentMethod;
    occurredOn?: string;
    // Staff-visible external reference (bank confirmation, receipt
    // book) — optional so volunteer entry stays painless.
    reference?: string | null;
    note?: string | null;
    // A pending record is only honest for a transfer that needs
    // confirmation — cash/'other' in hand are either received or not.
    pending?: boolean;
    // Client-generated dedupe handle: a form retry resolves to the
    // row it already created instead of double-counting money.
    idempotencyKey?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentMutationResult> {
  const status = options.pending ? "pending" : "confirmed";
  if (
    !UUID_RE.test(registrationId) ||
    !Number.isInteger(options.amountCents) ||
    options.amountCents <= 0 ||
    !isManualPaymentMethod(options.method) ||
    (options.pending && options.method !== "bank-transfer") ||
    (options.occurredOn !== undefined &&
      !isIsoDateString(options.occurredOn)) ||
    (options.idempotencyKey != null &&
      !UUID_RE.test(options.idempotencyKey))
  ) {
    return { ok: false, reason: "invalid" };
  }

  try {
    return await db.transaction(async (tx) => {
      const reg = await lockRegistration(tx, registrationId);
      if (!reg) return { ok: false as const, reason: "not-found" as const };
      if (reg.status !== "active") {
        return { ok: false as const, reason: "conflict" as const };
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          registrationId,
          submissionId: reg.submissionId,
          personId: reg.personId,
          amountCents: options.amountCents,
          currency: reg.currency,
          kind: "payment",
          status,
          method: options.method,
          source: "staff",
          reference: options.reference?.trim() || null,
          note: options.note?.trim() || null,
          idempotencyKey: options.idempotencyKey ?? null,
          recordedBy: actorLabel,
          occurredAt: options.occurredOn
            ? new Date(`${options.occurredOn}T00:00:00Z`)
            : new Date(),
        })
        .returning();
      if (!payment) return { ok: false as const, reason: "invalid" as const };

      await recordPaymentEvent(tx, {
        paymentId: payment.id,
        event: "recorded",
        actorLabel,
        source: "staff",
        detail: { status, amountCents: options.amountCents },
      });
      await auditPaymentMutation(tx, {
        action: "record-payment",
        paymentId: payment.id,
        actorLabel,
        after: {
          registrationId,
          amountCents: options.amountCents,
          method: options.method,
          status,
        },
      });
      return {
        ok: true as const,
        paymentId: payment.id,
        created: true,
        balance: await balanceForReg(tx, reg),
      };
    });
  } catch (error) {
    // Idempotent replay: the insert landed before a lost response —
    // resolve to the row the key already created.
    if (isUniqueViolation(error) && options.idempotencyKey) {
      const [existing] = await db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.idempotencyKey, options.idempotencyKey))
        .limit(1);
      if (existing) {
        const reg = await db
          .select(LOCKED_REGISTRATION_COLUMNS)
          .from(registrations)
          .where(eq(registrations.id, registrationId))
          .limit(1);
        return {
          ok: true,
          paymentId: existing.id,
          created: false,
          balance: reg[0]
            ? await registrationBalance(reg[0], db)
            : deriveRegistrationBalance(
                { amountDueCents: 0, resolution: null },
                emptyLedgerAggregate(),
              ),
        };
      }
    }
    throw error;
  }
}

// --- Pending-transaction reconciliation ------------------------------------------
// The deliberate human/server action that turns a declared intent into
// money truth — or marks it dead. Only 'pending' rows may transition,
// enforced by both the row lock and the guarded UPDATE.

// Confirm a pending transaction (a bank transfer that arrived, a
// provider checkout the authoritative path verified). An optional
// reference can be attached at confirmation time — the reconciliation
// evidence.
export async function confirmPayment(
  paymentId: string,
  options: { note?: string | null; reference?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentMutationResult> {
  if (!UUID_RE.test(paymentId)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) return { ok: false as const, reason: "not-found" as const };
    if (payment.kind !== "payment" || payment.status !== "pending") {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(payments)
      .set({
        status: "confirmed",
        reference: options.reference?.trim() || payment.reference,
        note: options.note?.trim() || payment.note,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
      .returning();
    if (!row) return { ok: false as const, reason: "conflict" as const };

    await recordPaymentEvent(tx, {
      paymentId,
      event: "confirmed",
      actorLabel,
      source: "staff",
      detail: {
        from: "pending",
        to: "confirmed",
        referenceAttached: options.reference?.trim() ? true : undefined,
      },
    });
    await auditPaymentMutation(tx, {
      action: "confirm-payment",
      paymentId,
      actorLabel,
      before: { status: "pending" },
      after: { status: "confirmed" },
    });

    const reg = row.registrationId
      ? await lockRegistration(tx, row.registrationId)
      : null;
    return {
      ok: true as const,
      paymentId,
      created: false,
      balance: reg
        ? await balanceForReg(tx, reg)
        : deriveRegistrationBalance(
            { amountDueCents: 0, resolution: null },
            emptyLedgerAggregate(),
          ),
    };
  });
}

// Void a pending transaction — it was cancelled or entered in error and
// never settled. Confirmed money cannot be voided: real money leaves
// only through refund/adjustment rows so the trail survives.
export async function voidPayment(
  paymentId: string,
  options: { reason?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentMutationResult> {
  if (!UUID_RE.test(paymentId)) return { ok: false, reason: "invalid" };
  // A void must say why — silent erasure of an intent record is the
  // failure mode reconciliation history exists to prevent.
  const reason = options.reason?.trim();
  if (!reason) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) return { ok: false as const, reason: "not-found" as const };
    if (payment.status !== "pending") {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(payments)
      .set({ status: "void", note: reason, updatedAt: new Date() })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "pending")))
      .returning();
    if (!row) return { ok: false as const, reason: "conflict" as const };

    await recordPaymentEvent(tx, {
      paymentId,
      event: "voided",
      actorLabel,
      source: "staff",
      detail: { from: "pending", to: "void", reason },
    });
    await auditPaymentMutation(tx, {
      action: "void-payment",
      paymentId,
      actorLabel,
      before: { status: "pending" },
      after: { status: "void", reason },
    });

    const reg = row.registrationId
      ? await lockRegistration(tx, row.registrationId)
      : null;
    return {
      ok: true as const,
      paymentId,
      created: false,
      balance: reg
        ? await balanceForReg(tx, reg)
        : deriveRegistrationBalance(
            { amountDueCents: 0, resolution: null },
            emptyLedgerAggregate(),
          ),
    };
  });
}

// --- Refunds -----------------------------------------------------------------------

// Confirmed money returned to the payer — a NEW ledger row linked to
// the original payment, never a deletion or edit of it. Supports
// partial refunds: the per-payment refundable cap (confirmed refunds
// already applied against this payment) is validated under the parent
// row lock, so concurrent refunds serialize and cannot overdraw.
export async function refundPayment(
  paymentId: string,
  options: {
    amountCents: number;
    // Why money went back — required: a refund without a reason is
    // unauditable money.
    reason: string;
    occurredOn?: string;
    reference?: string | null;
    note?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentMutationResult> {
  if (
    !UUID_RE.test(paymentId) ||
    !Number.isInteger(options.amountCents) ||
    options.amountCents <= 0 ||
    !options.reason?.trim() ||
    (options.occurredOn !== undefined &&
      !isIsoDateString(options.occurredOn))
  ) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) return { ok: false as const, reason: "not-found" as const };
    if (payment.kind !== "payment" || payment.status !== "confirmed") {
      return { ok: false as const, reason: "conflict" as const };
    }

    // Refundable = original amount minus confirmed refunds already
    // applied. The parent row lock makes this read-modify-write atomic
    // across concurrent refunds.
    const [agg] = await tx
      .select({
        refunded: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.relatedPaymentId, paymentId),
          eq(payments.kind, "refund"),
          eq(payments.status, "confirmed"),
        ),
      );
    const refundable = payment.amountCents - (agg?.refunded ?? 0);
    if (options.amountCents > refundable) {
      return { ok: false as const, reason: "exceeds-refundable" as const };
    }

    const [refund] = await tx
      .insert(payments)
      .values({
        registrationId: payment.registrationId,
        submissionId: payment.submissionId,
        personId: payment.personId,
        amountCents: options.amountCents,
        currency: payment.currency,
        kind: "refund",
        status: "confirmed",
        method: payment.method,
        source: "staff",
        provider: payment.provider,
        providerRef: null, // provider refund refs arrive via #171
        reference: options.reference?.trim() || null,
        relatedPaymentId: paymentId,
        recordedBy: actorLabel,
        note: options.note?.trim() || options.reason.trim(),
        occurredAt: options.occurredOn
          ? new Date(`${options.occurredOn}T00:00:00Z`)
          : new Date(),
      })
      .returning();
    if (!refund) return { ok: false as const, reason: "invalid" as const };

    await recordPaymentEvent(tx, {
      paymentId: refund.id,
      event: "recorded",
      actorLabel,
      source: "staff",
      detail: { kind: "refund", amountCents: options.amountCents },
    });
    // The parent's reconciliation trail gets the refund event — the
    // answer to "what happened to this payment".
    await recordPaymentEvent(tx, {
      paymentId,
      event: "refunded",
      actorLabel,
      source: "staff",
      detail: {
        refundPaymentId: refund.id,
        amountCents: options.amountCents,
        reason: options.reason.trim(),
      },
    });
    await auditPaymentMutation(tx, {
      action: "refund-payment",
      paymentId,
      actorLabel,
      after: {
        refundPaymentId: refund.id,
        amountCents: options.amountCents,
        reason: options.reason.trim(),
      },
    });

    const reg = payment.registrationId
      ? await lockRegistration(tx, payment.registrationId)
      : null;
    return {
      ok: true as const,
      paymentId: refund.id,
      created: true,
      balance: reg
        ? await balanceForReg(tx, reg)
        : deriveRegistrationBalance(
            { amountDueCents: 0, resolution: null },
            emptyLedgerAggregate(),
          ),
    };
  });
}

// --- Adjustments --------------------------------------------------------------------

// A signed bookkeeping correction to CONFIRMED money where no
// real-world money moved — e.g. a mis-keyed amount. Positive adds to
// settled money, negative subtracts; a reason is mandatory. Adjustments
// are the boundary between "the record was wrong" (this) and "money
// went back" (refund) / "the intent never settled" (void).
export async function recordAdjustment(
  registrationId: string,
  options: {
    // Signed: positive adds settled money, negative removes it.
    amountCents: number;
    reason: string;
    // Optionally bound to the payment being corrected.
    relatedPaymentId?: string | null;
    occurredOn?: string;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PaymentMutationResult> {
  if (
    !UUID_RE.test(registrationId) ||
    !Number.isInteger(options.amountCents) ||
    options.amountCents === 0 ||
    !options.reason?.trim() ||
    (options.relatedPaymentId != null &&
      !UUID_RE.test(options.relatedPaymentId)) ||
    (options.occurredOn !== undefined &&
      !isIsoDateString(options.occurredOn))
  ) {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const reg = await lockRegistration(tx, registrationId);
    if (!reg) return { ok: false as const, reason: "not-found" as const };
    if (reg.status !== "active") {
      return { ok: false as const, reason: "conflict" as const };
    }

    if (options.relatedPaymentId) {
      const [parent] = await tx
        .select({ id: payments.id, registrationId: payments.registrationId })
        .from(payments)
        .where(eq(payments.id, options.relatedPaymentId));
      if (!parent || parent.registrationId !== registrationId) {
        return { ok: false as const, reason: "not-found" as const };
      }
    }

    const [adjustment] = await tx
      .insert(payments)
      .values({
        registrationId,
        submissionId: reg.submissionId,
        personId: reg.personId,
        amountCents: options.amountCents,
        currency: reg.currency,
        kind: "adjustment",
        status: "confirmed",
        method: "other",
        source: "staff",
        relatedPaymentId: options.relatedPaymentId ?? null,
        recordedBy: actorLabel,
        note: options.reason.trim(),
        occurredAt: options.occurredOn
          ? new Date(`${options.occurredOn}T00:00:00Z`)
          : new Date(),
      })
      .returning();
    if (!adjustment) {
      return { ok: false as const, reason: "invalid" as const };
    }

    await recordPaymentEvent(tx, {
      paymentId: adjustment.id,
      event: "recorded",
      actorLabel,
      source: "staff",
      detail: { kind: "adjustment", amountCents: options.amountCents },
    });
    if (options.relatedPaymentId) {
      await recordPaymentEvent(tx, {
        paymentId: options.relatedPaymentId,
        event: "adjusted",
        actorLabel,
        source: "staff",
        detail: {
          adjustmentPaymentId: adjustment.id,
          amountCents: options.amountCents,
          reason: options.reason.trim(),
        },
      });
    }
    await auditPaymentMutation(tx, {
      action: "record-adjustment",
      paymentId: adjustment.id,
      actorLabel,
      after: {
        registrationId,
        amountCents: options.amountCents,
        relatedPaymentId: options.relatedPaymentId ?? null,
        reason: options.reason.trim(),
      },
    });

    return {
      ok: true as const,
      paymentId: adjustment.id,
      created: true,
      balance: await balanceForReg(tx, reg),
    };
  });
}

// --- Provider seam (#171) ---------------------------------------------------------
// The provider-neutral reconciliation interface a future Sentoo
// integration lands on. It exists so a webhook/reconciliation worker
// NEVER reimplements balance logic:
//
//   initiateProviderPayment  — a checkout/payment intent was created:
//                              persists the provider identity and a
//                              'pending' row. Initiation is NOT truth.
//   reconcileProviderOutcome — an authoritative provider result
//                              (authenticated webhook/reconciliation)
//                              transitions the pending row to
//                              confirmed/failed, idempotently.
//
// External identity is scoped as (provider, provider_ref) — the unique
// index makes a repeated authoritative event resolve to the existing
// transaction instead of duplicating money. Browser returns carry no
// authority and have no seam here at all.

export type ProviderInitiateResult =
  | { ok: true; paymentId: string; created: boolean }
  | { ok: false; reason: "invalid" | "not-found" | "conflict" };

export async function initiateProviderPayment(
  input: {
    provider: string;
    providerRef: string;
    registrationId: string;
    amountCents: number;
    occurredAt?: Date;
    recordedBy?: string;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<ProviderInitiateResult> {
  const provider = input.provider?.trim();
  const providerRef = input.providerRef?.trim();
  if (
    !provider ||
    !providerRef ||
    !UUID_RE.test(input.registrationId) ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
    return { ok: false, reason: "invalid" };
  }

  try {
    return await db.transaction(async (tx) => {
      const reg = await lockRegistration(tx, input.registrationId);
      if (!reg) return { ok: false as const, reason: "not-found" as const };
      if (reg.status !== "active") {
        return { ok: false as const, reason: "conflict" as const };
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          registrationId: input.registrationId,
          submissionId: reg.submissionId,
          personId: reg.personId,
          amountCents: input.amountCents,
          currency: reg.currency,
          kind: "payment",
          status: "pending",
          method: "online",
          source: "provider",
          provider,
          providerRef,
          recordedBy: input.recordedBy ?? `${provider}-checkout`,
          occurredAt: input.occurredAt ?? new Date(),
        })
        .returning();
      if (!payment) return { ok: false as const, reason: "invalid" as const };

      await recordPaymentEvent(tx, {
        paymentId: payment.id,
        event: "recorded",
        actorLabel: input.recordedBy ?? `${provider}-checkout`,
        source: "provider",
        detail: { status: "pending", provider },
      });
      return { ok: true as const, paymentId: payment.id, created: true };
    });
  } catch (error) {
    // The same external transaction initiated twice — resolve to the
    // existing row rather than a second pending intent.
    if (isUniqueViolation(error)) {
      const [existing] = await db
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.provider, provider),
            eq(payments.providerRef, providerRef),
          ),
        )
        .limit(1);
      if (existing) {
        return { ok: true, paymentId: existing.id, created: false };
      }
    }
    throw error;
  }
}

export type ProviderReconcileResult =
  | {
      ok: true;
      paymentId: string;
      // 'transitioned' — a pending row moved to the outcome;
      // 'existing' — the row was already terminal (idempotent replay).
      applied: "transitioned" | "existing";
      balance: RegistrationBalance | null;
    }
  | { ok: false; reason: "invalid" | "not-found" | "conflict" };

// Apply an authoritative provider outcome to a known transaction.
// pending → outcome; an already-terminal row resolves to itself —
// duplicate webhook deliveries and retries are no-ops. A terminal row
// whose stored outcome disagrees with the authoritative replay is a
// 'conflict', never a silent overwrite of confirmed money.
export async function reconcileProviderOutcome(
  input: {
    provider: string;
    providerRef: string;
    outcome: "confirmed" | "failed";
    occurredAt?: Date;
    actorLabel?: string;
    detail?: Record<string, unknown>;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<ProviderReconcileResult> {
  const provider = input.provider?.trim();
  const providerRef = input.providerRef?.trim();
  if (
    !provider ||
    !providerRef ||
    !["confirmed", "failed"].includes(input.outcome)
  ) {
    return { ok: false, reason: "invalid" };
  }
  const actor = input.actorLabel ?? `${provider}-reconcile`;

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select(PAYMENT_COLUMNS)
      .from(payments)
      .where(
        and(
          eq(payments.provider, provider),
          eq(payments.providerRef, providerRef),
        ),
      )
      .for("update");
    if (!payment) return { ok: false as const, reason: "not-found" as const };

    const reg = payment.registrationId
      ? await lockRegistration(tx, payment.registrationId)
      : null;
    const balance = reg ? await balanceForReg(tx, reg) : null;

    if (payment.status === input.outcome) {
      // Authoritative replay of an already-applied outcome.
      return {
        ok: true as const,
        paymentId: payment.id,
        applied: "existing" as const,
        balance,
      };
    }
    if (payment.status !== "pending") {
      // confirmed ↔ failed disagreement: the stored row is the truth
      // until a deliberate correction — never overwrite it silently.
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(payments)
      .set({
        status: input.outcome,
        occurredAt: input.occurredAt ?? payment.occurredAt,
        updatedAt: new Date(),
      })
      .where(
        and(eq(payments.id, payment.id), eq(payments.status, "pending")),
      )
      .returning();
    if (!row) return { ok: false as const, reason: "conflict" as const };

    await recordPaymentEvent(tx, {
      paymentId: payment.id,
      event: input.outcome === "confirmed" ? "confirmed" : "failed",
      actorLabel: actor,
      source: "provider",
      detail: { from: "pending", to: input.outcome, ...input.detail },
    });
    return {
      ok: true as const,
      paymentId: payment.id,
      applied: "transitioned" as const,
      balance: reg ? await balanceForReg(tx, reg) : null,
    };
  });
}
