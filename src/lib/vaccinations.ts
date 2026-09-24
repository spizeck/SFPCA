// Canonical vaccination domain rules (#173): date semantics and the
// derived current/due/overdue state. Pure functions only — this module
// is imported by the registry service, the admin UI, and tests so every
// layer agrees. It must never import the DB, auth, or "server-only".
//
// Three distinct dates live on a vaccination row (see schema.ts):
// - administeredOn — when THIS dose was given (historical fact)
// - dueOn — recommended next-dose/revaccination date
// - validUntil — legal/clinical expiry of this dose (e.g. a rabies
//   certificate's expiry), which can differ from dueOn
// Due/overdue is always derived from those stored facts — never a
// mutable status column that could silently go stale.

export const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Strict YYYY-MM-DD validation — rejects real-world impossible dates
// like 2026-02-30 that a bare regex would pass.
export function isIsoDateString(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDaysToIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The "next relevant date" for a vaccination: whichever of the
// recommended next-dose date and this dose's expiry comes first is what
// needs attention. ISO date strings compare lexicographically.
export function effectiveVaccinationDate(
  dueOn: string | null,
  validUntil: string | null,
): string | null {
  if (dueOn && validUntil) return dueOn < validUntil ? dueOn : validUntil;
  return dueOn ?? validUntil;
}

// How far ahead a due vaccination becomes "due soon". The reminder
// cadence itself (when to email vs. wait) is #172's concern — this is
// only the shared definition of the attention window.
export const VACCINATION_DUE_SOON_DAYS = 30;

export type VaccinationDueState =
  | "overdue"
  | "due-soon"
  | "current"
  | "unscheduled";

export function vaccinationDueState(
  effectiveDate: string | null,
  today: string,
  dueSoonDays: number = VACCINATION_DUE_SOON_DAYS,
): VaccinationDueState {
  if (!effectiveDate) return "unscheduled";
  if (effectiveDate < today) return "overdue";
  if (effectiveDate <= addDaysToIsoDate(today, dueSoonDays)) {
    return "due-soon";
  }
  return "current";
}

export const VACCINATION_DUE_STATE_LABELS: Record<
  VaccinationDueState,
  string
> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  current: "Current",
  unscheduled: "No date set",
};
