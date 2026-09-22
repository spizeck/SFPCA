// Canonical animal lifecycle. This module is the single authoritative
// definition of which animal states exist, what they mean, and which are
// publicly visible. Firestore rules mirror the public-visibility decision
// here (`firestore.rules`: only PUBLIC_ANIMAL_STATUS documents are
// readable without admin authorization), so the two must never drift.
//
// Lifecycle contract:
//
// | Status      | Meaning                                         | Public? |
// |-------------|-------------------------------------------------|---------|
// | available   | Ready for adoption; homepage preview +             | yes     |
// |             | /animal-adoptions listing                          |         |
// | pending     | Not currently adoptable (e.g. an adoption is in | no      |
// |             | progress or the animal is temporarily held)     |         |
// | adopted     | Permanently homed; kept for historical record   | no      |
// | <unknown>   | Missing or unrecognized status value            | never   |
//
// Every supported state can transition to every other supported state:
// no state is terminal because staff must be able to correct mistakes
// (e.g. an animal marked adopted in error can return to available).
// Record existence is separate from public visibility — a non-public
// animal stays in Firestore; hard delete exists only for genuinely
// erroneous/test records.

export const ANIMAL_STATUSES = ["available", "pending", "adopted"] as const;

export type AnimalStatus = (typeof ANIMAL_STATUSES)[number];

export const ANIMAL_STATUS_LABELS: Record<AnimalStatus, string> = {
  available: "Available",
  pending: "Pending",
  adopted: "Adopted",
};

// The only status visible to unauthenticated visitors. Kept as a named
// constant so queries and rules share one spelling of the public boundary.
export const PUBLIC_ANIMAL_STATUS: AnimalStatus = "available";

// Runtime guard. Firestore data is untyped: a malformed or legacy document
// must never be treated as a known lifecycle state.
export function isAnimalStatus(value: unknown): value is AnimalStatus {
  return (
    typeof value === "string" &&
    (ANIMAL_STATUSES as readonly string[]).includes(value)
  );
}

// Public-visibility predicate. Fails closed: anything that is not a known
// public status is not public, including unknown/missing values.
export function isPublicAnimalStatus(status: unknown): boolean {
  return status === PUBLIC_ANIMAL_STATUS;
}

// Human-readable label for admin display. Unknown values are surfaced as
// unknown rather than silently coerced into a real state.
export function getAnimalStatusLabel(status: unknown): string {
  return isAnimalStatus(status) ? ANIMAL_STATUS_LABELS[status] : "Unknown";
}

// Admin-facing hint describing the public consequence of a status. Shown
// next to status controls so staff can see when an animal disappears from
// public listings without relying on color alone.
export function getAnimalStatusVisibilityHint(status: unknown): string {
  if (!isAnimalStatus(status)) {
    return "Unrecognized status — this animal is hidden from the public site. Choose a status to fix it.";
  }
  return isPublicAnimalStatus(status)
    ? "Shown on the public adoptions page."
    : "Hidden from the public site; the record is kept for admin reference.";
}

// Transition rule. Any supported status may move to any other supported
// status — the lifecycle is intentionally simple and no state is terminal.
// Transitions to or from unrecognized values are rejected so a malformed
// document can never be written as a lifecycle change.
export function canTransitionAnimalStatus(
  from: unknown,
  to: unknown,
): boolean {
  return isAnimalStatus(from) && isAnimalStatus(to);
}
