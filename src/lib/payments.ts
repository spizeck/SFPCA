// Canonical payment vocabulary (#170) — the ONE place that defines the
// ledger's closed vocabularies and the pure balance derivation every
// consumer shares. Client-safe (no server-only, no DB): the staff UI,
// DTOs, and tests all read the same definitions.
//
// The invariants this module encodes:
//   - payment initiation is not payment truth: only 'confirmed' rows
//     count toward settled money; 'pending'/'failed'/'void' never do;
//   - a confirmed event is immutable — refunds and adjustments are new
//     rows, never edits;
//   - 'online' is the provider-mediated method (#171 Sentoo is one
//     future provider) — everything manual is staff-sourced.

import {
  derivePaymentState,
  type RegistrationPaymentState,
  type RegistrationResolution,
} from "./registrations";

// --- Transaction kinds -----------------------------------------------------
// 'payment' — money received for the registration.
// 'refund'  — money returned to the payer; always positive, subtracts
//             in the projection. Links to the original payment.
// 'adjustment' — signed bookkeeping correction of CONFIRMED money where
//             no real-world money moved (a mis-keyed amount). Positive
//             adds, negative subtracts. Requires a reason.
export const PAYMENT_KINDS = ["payment", "refund", "adjustment"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  payment: "Payment",
  refund: "Refund",
  adjustment: "Adjustment",
};

export function isPaymentKind(value: unknown): value is PaymentKind {
  return (PAYMENT_KINDS as readonly string[]).includes(value as PaymentKind);
}

// --- Statuses ---------------------------------------------------------------
// pending   — declared intent or in-flight provider transaction; never
//             counts toward a balance.
// confirmed — authoritative: the money event really happened. The only
//             status that moves a balance.
// failed    — attempted money that did not complete (provider-reported).
// void      — the pending record was cancelled or entered in error
//             before it could settle.
// failed/void are terminal; pending → confirmed|failed|void only.
export const PAYMENT_STATUSES = [
  "pending",
  "confirmed",
  "failed",
  "void",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  void: "Void",
};

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(
    value as PaymentStatus,
  );
}

// --- Methods ------------------------------------------------------------------
// How money moved. 'online' is reserved for provider-mediated payments
// and always carries provider identity; the manual methods are what
// staff may record directly.
export const PAYMENT_METHODS = [
  "cash",
  "bank-transfer",
  "other",
  "online",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  "bank-transfer": "Bank transfer",
  other: "Other",
  online: "Online",
};

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(
    value as PaymentMethod,
  );
}

// The methods staff may record by hand — 'online' can only be created
// through the provider reconciliation seam, never by staff entry.
export const MANUAL_PAYMENT_METHODS = [
  "cash",
  "bank-transfer",
  "other",
] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export function isManualPaymentMethod(
  value: unknown,
): value is ManualPaymentMethod {
  return (MANUAL_PAYMENT_METHODS as readonly string[]).includes(
    value as ManualPaymentMethod,
  );
}

// --- Sources --------------------------------------------------------------------
// 'staff' — a volunteer recorded the event (manual money, corrections,
//           deliberate reconciliation).
// 'provider' — an authenticated provider path applied it (#171's
//           webhook/reconciliation worker). Provider rows are only ever
//           method='online'.
export const PAYMENT_SOURCES = ["staff", "provider"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export function isPaymentSource(value: unknown): value is PaymentSource {
  return (PAYMENT_SOURCES as readonly string[]).includes(
    value as PaymentSource,
  );
}

// --- Reconciliation event types -------------------------------------------------
// The bounded vocabulary of payment_events. 'recorded' covers row
// creation at whatever initial status; the rest are the only
// transitions the ledger allows.
export const PAYMENT_EVENT_TYPES = [
  "recorded",
  "confirmed",
  "failed",
  "voided",
  "refunded",
  "adjusted",
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export const PAYMENT_EVENT_LABELS: Record<PaymentEventType, string> = {
  recorded: "Recorded",
  confirmed: "Confirmed",
  failed: "Failed",
  voided: "Voided",
  refunded: "Refunded",
  adjusted: "Adjusted",
};

// --- Balance derivation ----------------------------------------------------------

// Raw confirmed-ledger aggregates for one registration — the output of
// the set-based moneyByRegistration query, kept client-safe so the
// derivation and UI summary share one shape.
export interface LedgerAggregate {
  // Confirmed 'payment' rows only — real money received.
  receivedCents: number;
  // Confirmed 'refund' rows — money returned (positive amount).
  refundedCents: number;
  // Net confirmed 'adjustment' rows — signed corrections.
  adjustmentCents: number;
  // Confirmed money that does NOT yet count: pending 'payment' rows.
  // Surfaced so staff see in-flight money without it touching truth.
  pendingCents: number;
}

export function emptyLedgerAggregate(): LedgerAggregate {
  return {
    receivedCents: 0,
    refundedCents: 0,
    adjustmentCents: 0,
    pendingCents: 0,
  };
}

export interface RegistrationBalance {
  // Confirmed money applied to the obligation:
  //   received - refunded + adjustments  (may exceed the assessment or
  //   go negative only via adjustments — never via pending rows).
  settledCents: number;
  // What is still owed: max(assessed - settled, 0). Zero for
  // waived/complimentary resolutions — the obligation is resolved.
  outstandingCents: number;
  // Money confirmed beyond the assessment — real received money staff
  // must refund or correct, surfaced explicitly rather than hidden.
  overpaidCents: number;
  // In-flight money that must NOT reduce the outstanding figure.
  pendingCents: number;
  paymentState: RegistrationPaymentState;
}

// THE canonical balance formula. Everything — staff ledger view,
// queues, portal, the reminder evaluator, future provider
// reconciliation — derives from this; nothing re-implements the
// arithmetic. `settled` is the only input the ledger contributes.
export function deriveRegistrationBalance(
  {
    amountDueCents,
    resolution,
  }: { amountDueCents: number; resolution: RegistrationResolution | null },
  agg: LedgerAggregate,
): RegistrationBalance {
  const settledCents =
    agg.receivedCents - agg.refundedCents + agg.adjustmentCents;
  const resolved = resolution !== null;
  return {
    settledCents,
    outstandingCents: resolved
      ? 0
      : Math.max(amountDueCents - settledCents, 0),
    overpaidCents: Math.max(settledCents - amountDueCents, 0),
    pendingCents: agg.pendingCents,
    paymentState: derivePaymentState(amountDueCents, settledCents, resolution),
  };
}
