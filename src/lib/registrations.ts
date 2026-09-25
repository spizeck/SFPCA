// Canonical registration vocabulary (#169) — the ONE place that defines
// what an authoritative registration IS: the per-animal, per-period
// registry record the registration queues, owner portal, reminder
// eligibility, and profile all read. This module is client-safe (no
// server-only, no DB) so forms, labels, and tests share it.
//
// Separation of concerns the whole model depends on:
//   - animal existence/lifecycle lives on `animals` (#167) — a lapsed
//     or missing registration NEVER changes it;
//   - a public form submission is INTAKE (`registration_submissions`),
//     not registry truth — staff review turns claims into records;
//   - `registrations` is the authoritative historical record: one row
//     per animal per period, preserved across years;
//   - money owed is the registration's own `amountDueCents` snapshot;
//     money PAID is derived from the `payments` ledger (#170) — never
//     encoded by abusing registration status.

// --- Registration period -----------------------------------------------------
// SFPCA registration is calendar-year based: the period IS the year.
// Everything that needs "the current period" goes through
// currentRegistrationYear so a policy change (e.g. a staggered season)
// has exactly one place to land. Tests pass an explicit asOf so nothing
// breaks when the calendar rolls over.

export const REGISTRATION_YEAR_MIN = 2000;
export const REGISTRATION_YEAR_MAX = 2200;

export function isRegistrationYear(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= REGISTRATION_YEAR_MIN &&
    value <= REGISTRATION_YEAR_MAX
  );
}

// The registration period containing `asOf` (YYYY-MM-DD or Date;
// default: today). Calendar-year registration → the year number.
export function currentRegistrationYear(asOf?: string | Date): number {
  const d =
    asOf instanceof Date
      ? asOf
      : typeof asOf === "string"
        ? new Date(`${asOf.slice(0, 10)}T00:00:00Z`)
        : new Date();
  const year = d.getUTCFullYear();
  return isRegistrationYear(year) ? year : REGISTRATION_YEAR_MIN;
}

export function registrationPeriodLabel(year: number): string {
  return `${year} registration`;
}

// --- Authoritative registration status ---------------------------------------
// Deliberately small: a registration is either in effect for its period
// or it was cancelled. "Registered but unpaid" is NOT a status — it is
// status 'active' + payment state 'unpaid'.
//
// | status    | Meaning                                              |
// |-----------|------------------------------------------------------|
// | active    | The animal is registered for this period             |
// | cancelled | The record was rescinded — correction or withdrawal; |
// |           | preserved for history, never deleted                 |

export const REGISTRATION_RECORD_STATUSES = ["active", "cancelled"] as const;
export type RegistrationRecordStatus =
  (typeof REGISTRATION_RECORD_STATUSES)[number];

export const REGISTRATION_RECORD_STATUS_LABELS: Record<
  RegistrationRecordStatus,
  string
> = {
  active: "Registered",
  cancelled: "Cancelled",
};

export function isRegistrationRecordStatus(
  value: unknown,
): value is RegistrationRecordStatus {
  return (REGISTRATION_RECORD_STATUSES as readonly string[]).includes(
    value as RegistrationRecordStatus,
  );
}

// Why a registration was cancelled. 'correction' means the record was
// wrong (wrong animal, wrong year, duplicate) — the fix for a mistaken
// row. 'withdrawn' means the registration genuinely ended (policy
// decision, owner request). Both preserve the row.
export const REGISTRATION_CANCELLATION_REASONS = [
  "correction",
  "withdrawn",
] as const;
export type RegistrationCancellationReason =
  (typeof REGISTRATION_CANCELLATION_REASONS)[number];

// --- Non-payment resolution ---------------------------------------------------
// Legitimate ways an amount due is resolved WITHOUT a payment row —
// never a fake $0 payment: the resolution lives on the registration
// itself, audited. 'waived' is a staff decision to forgive the fee;
// 'complimentary' means policy says no fee applies (e.g. sponsored
// animal).
export const REGISTRATION_RESOLUTIONS = ["waived", "complimentary"] as const;
export type RegistrationResolution = (typeof REGISTRATION_RESOLUTIONS)[number];

export const REGISTRATION_RESOLUTION_LABELS: Record<
  RegistrationResolution,
  string
> = {
  waived: "Fee waived",
  complimentary: "Complimentary",
};

export function isRegistrationResolution(
  value: unknown,
): value is RegistrationResolution {
  return (REGISTRATION_RESOLUTIONS as readonly string[]).includes(
    value as RegistrationResolution,
  );
}

// --- Derived payment state ------------------------------------------------------
// Computed from the payments ledger + the registration's own resolution
// — never stored, so it can never disagree with the ledger. 'no-fee'
// means nothing was assessed; there is nothing to collect.
export const REGISTRATION_PAYMENT_STATES = [
  "no-fee",
  "unpaid",
  "partial",
  "paid",
  "waived",
  "complimentary",
] as const;
export type RegistrationPaymentState =
  (typeof REGISTRATION_PAYMENT_STATES)[number];

export const REGISTRATION_PAYMENT_STATE_LABELS: Record<
  RegistrationPaymentState,
  string
> = {
  "no-fee": "No fee",
  unpaid: "Unpaid",
  partial: "Partially paid",
  paid: "Paid",
  waived: "Waived",
  complimentary: "Complimentary",
};

// The states that still owe money — the unpaid queue and (for #170)
// the unpaid-balance reminder eligibility set.
export const OUTSTANDING_PAYMENT_STATES: readonly RegistrationPaymentState[] =
  ["unpaid", "partial"];

export function derivePaymentState(
  amountDueCents: number,
  confirmedPaidCents: number,
  resolution: RegistrationResolution | null,
): RegistrationPaymentState {
  if (resolution) return resolution;
  if (amountDueCents <= 0) return "no-fee";
  if (confirmedPaidCents <= 0) return "unpaid";
  return confirmedPaidCents >= amountDueCents ? "paid" : "partial";
}
