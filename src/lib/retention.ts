// Retention policy constants and date math (#130). Client-safe — shared
// vocabulary for the purge service, the cron route, admin surfaces, and
// tests. This module is the ONE place the approved retention periods
// live: a policy change is a constant edit here, not a hunt through
// route handlers.
//
// The approved policy (issue #130):
//   - completed registration/payment records — retained for
//     COMPLETED_RECORD_YEARS after the END of the applicable
//     registration year;
//   - uploaded payment receipts — deleted VERIFIED_RECEIPT_DAYS after
//     the server-side verification/reconciliation stamp, while the
//     structured ledger/audit facts (amount, date, reference, status)
//     remain;
//   - incomplete / abandoned / unsuccessful submissions — retained no
//     longer than ABANDONED_SUBMISSION_MONTHS, then deleted;
//   - canonical animal and owner/animal history is NOT auto-deleted —
//     expiry removes intake PII and receipt binaries, never animal
//     identity, ownership lineage, ledger facts, or audit integrity;
//   - deliberate holds (retention_holds) exempt individual records for
//     documented legal/dispute/investigation reasons.
//
// All date math is calendar-aware and UTC-based: a "year" is the
// calendar registration year (src/lib/registrations.ts), a "month" is a
// calendar month. Nothing approximates years as N*365 days.

export const COMPLETED_RECORD_YEARS = 7;
export const VERIFIED_RECEIPT_DAYS = 90;
export const ABANDONED_SUBMISSION_MONTHS = 12;

// Per-run work bound. Categories process at most this many rows each so
// a daily cron invocation stays short and never holds long table locks.
export const RETENTION_BATCH_LIMIT = 100;

// Rollout gate: destructive runs require this env var set to "true".
// Unset/anything else → every invocation reports in dry-run mode, so a
// deploy can collect counts before purging is switched on.
export const RETENTION_PURGE_ENABLED_ENV = "RETENTION_PURGE_ENABLED";

export function isRetentionPurgeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[RETENTION_PURGE_ENABLED_ENV] === "true";
}

// Entity types a retention hold can protect. Submission holds cover the
// intake row AND its receipt; registration holds cover the registration
// row AND its linked submission and payment free-text fields.
export const RETENTION_HOLD_ENTITY_TYPES = [
  "registration_submission",
  "registration",
] as const;
export type RetentionHoldEntityType =
  (typeof RETENTION_HOLD_ENTITY_TYPES)[number];

export function isRetentionHoldEntityType(
  value: unknown,
): value is RetentionHoldEntityType {
  return (
    typeof value === "string" &&
    (RETENTION_HOLD_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

// The end of the applicable registration year: Dec 31 UTC. Registrations
// are calendar-year periods, so year-end is fixed, not rolling.
export function registrationYearEnd(year: number): Date {
  return new Date(Date.UTC(year, 11, 31));
}

// The first instant a completed record for `year` leaves its retention
// window: 7 full years after the year ends. A 2018 registration is
// retained through 2025-12-31 and becomes eligible on 2026-01-01 —
// expressed as Jan 1 of (year + YEARS + 1), never `year + 7 * 365d`.
export function completedRetentionBoundary(year: number): Date {
  return new Date(Date.UTC(year + COMPLETED_RECORD_YEARS + 1, 0, 1));
}

// The latest registration year whose records are retention-expired as of
// `now`. Boundary-exact: on Jan 1 the previous year-7 enters the window.
export function maxCompletedRetentionYear(now: Date): number {
  const year = now.getUTCFullYear();
  return completedRetentionBoundary(year - COMPLETED_RECORD_YEARS) <= now
    ? year - COMPLETED_RECORD_YEARS
    : year - COMPLETED_RECORD_YEARS - 1;
}

// Receipts are purge-eligible once the server-side verification stamp is
// older than VERIFIED_RECEIPT_DAYS. Day arithmetic is exact ms — only
// year/month spans need calendar math.
export function verifiedReceiptCutoff(now: Date): Date {
  return new Date(now.getTime() - VERIFIED_RECEIPT_DAYS * 24 * 60 * 60 * 1000);
}

// Submissions are abandoned once their anchor (decided_at for rejected,
// submitted_at for never-decided) is older than ABANDONED_SUBMISSION_MONTHS
// calendar months. Computed by backing the year off, so the day-of-month
// semantics stay calendar-true (e.g. Oct 3 2026 → Oct 3 2025); the
// day-of-month is clamped to the target month's length for Jan-31-type
// edges rather than overflowing into the next month.
export function abandonedSubmissionCutoff(now: Date): Date {
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear() - Math.floor(ABANDONED_SUBMISSION_MONTHS / 12),
      now.getUTCMonth() - (ABANDONED_SUBMISSION_MONTHS % 12),
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
  // Clamp the day: backing off a whole number of years keeps the month,
  // but Feb-only corner cases (leap-day anchors) must not overflow.
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(now.getUTCDate(), daysInMonth));
  return target;
}

// The marker written into submission owner_name when intake PII is
// anonymized past the retention window. Kept short, bracketed, and
// obviously non-name so staff views read "this was erased", never
// "this person is named [removed]".
export const ANONYMIZED_OWNER_NAME = "[removed]";
