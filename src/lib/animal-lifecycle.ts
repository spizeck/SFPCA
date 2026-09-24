// Canonical animal registry lifecycle + adoption publication state
// (#167). This module is the single authoritative definition of both
// vocabularies — they are deliberately separate concepts:
//
//   LIFECYCLE — the registry reality: is this animal living on Saba and
//   in SFPCA's care? Stored on animals.lifecycle_status, changed only
//   through transitionAnimalLifecycle (every change is preserved as an
//   animal_lifecycle_events row). NEVER shown publicly.
//
//   ADOPTION — the public catalog state: is this animal listed for
//   adoption? Stored on animals.adoption_status, edited freely by staff
//   like any other listing field.
//
// | Lifecycle       | Meaning                                            |
// |-----------------|----------------------------------------------------|
// | active          | Living on Saba / in registry care (the default)    |
// | deceased        | Confirmed dead — terminal in fact, still correctable|
// | moved-off-saba  | Confirmed to have left Saba                        |
// | unknown         | Registry record exists but living/on-island status |
// |                 | is unconfirmed (lapsed contact, uncertain imports) |
//
// | Adoption      | Meaning                                          | Public? |
// |---------------|--------------------------------------------------|---------|
// | not-listed    | Not in the adoption program (the default)        | no      |
// | available     | Listed: homepage preview + /animal-adoptions     | yes*    |
// | pending       | Adoption in progress or temporarily held         | no      |
// | adopted       | Permanently homed; kept for historical record    | no      |
//
// *Public visibility requires BOTH adoption_status='available' AND
// lifecycle_status='active' — a deceased or off-island animal is never
// publicly listed regardless of catalog state.
//
// Every lifecycle state can transition to every other — no state is
// terminally locked because staff must be able to correct mistakes (a
// wrongly-reported death reverses). Transitions are recorded as history,
// not rewritten. Record existence is separate from public visibility —
// a non-public animal stays in the registry; hard delete exists only for
// genuinely erroneous/test records.

import { isIsoDateString, todayIsoDate } from "./vaccinations";

// --- Registry lifecycle ------------------------------------------------------

export const ANIMAL_LIFECYCLE_STATUSES = [
  "active",
  "deceased",
  "moved-off-saba",
  "unknown",
] as const;

export type AnimalLifecycleStatus =
  (typeof ANIMAL_LIFECYCLE_STATUSES)[number];

export const ANIMAL_LIFECYCLE_LABELS: Record<AnimalLifecycleStatus, string> = {
  active: "Active on Saba",
  deceased: "Deceased",
  "moved-off-saba": "Moved off Saba",
  unknown: "Status unconfirmed",
};

// Lifecycle states after which the animal is no longer in registry care —
// a transition to one of these closes every currently-open ownership
// interval (a deceased or off-island animal has no on-island owner of
// record) and cancels open follow-ups/clinic expectations.
export const OWNERSHIP_ENDING_STATUSES: readonly AnimalLifecycleStatus[] = [
  "deceased",
  "moved-off-saba",
];

export function isAnimalLifecycleStatus(
  value: unknown,
): value is AnimalLifecycleStatus {
  return (
    typeof value === "string" &&
    (ANIMAL_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

export function getAnimalLifecycleLabel(status: unknown): string {
  return isAnimalLifecycleStatus(status)
    ? ANIMAL_LIFECYCLE_LABELS[status]
    : "Unknown";
}

// Transition rule: any known state may move to any other known state, but
// a "transition" to the current state is not one — re-affirming state is
// not history. Transitions to or from unrecognized values are rejected so
// a malformed row can never be written as a lifecycle change.
export function canTransitionAnimalLifecycle(
  from: unknown,
  to: unknown,
): boolean {
  return (
    isAnimalLifecycleStatus(from) &&
    isAnimalLifecycleStatus(to) &&
    from !== to
  );
}

// --- Adoption publication state -------------------------------------------------

export const ANIMAL_ADOPTION_STATUSES = [
  "not-listed",
  "available",
  "pending",
  "adopted",
] as const;

export type AnimalAdoptionStatus = (typeof ANIMAL_ADOPTION_STATUSES)[number];

export const ANIMAL_ADOPTION_LABELS: Record<AnimalAdoptionStatus, string> = {
  "not-listed": "Not listed",
  available: "Available",
  pending: "Pending",
  adopted: "Adopted",
};

export function isAnimalAdoptionStatus(
  value: unknown,
): value is AnimalAdoptionStatus {
  return (
    typeof value === "string" &&
    (ANIMAL_ADOPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function getAnimalAdoptionLabel(status: unknown): string {
  return isAnimalAdoptionStatus(status)
    ? ANIMAL_ADOPTION_LABELS[status]
    : "Unknown";
}

// THE public-visibility predicate — fails closed: anything that is not a
// known 'available' catalog state on a known 'active' animal is not
// public, including unknown/missing values. Public queries and services
// share this one definition.
export function isPubliclyListed(
  lifecycleStatus: unknown,
  adoptionStatus: unknown,
): boolean {
  return lifecycleStatus === "active" && adoptionStatus === "available";
}

// --- Sterilization ---------------------------------------------------------------

// Current registry fact on the animal row — vet_procedures spay/neuter
// rows are the evidence trail behind it (see registry/medical.ts).
//   unknown    — no reliable information (the default)
//   sterilized — known spayed/neutered (asserted or procedure-backed)
//   intact     — known NOT sterilized (e.g. confirmed at exam)
export const ANIMAL_STERILIZATION_STATUSES = [
  "unknown",
  "sterilized",
  "intact",
] as const;

export type AnimalSterilizationStatus =
  (typeof ANIMAL_STERILIZATION_STATUSES)[number];

// Admin-facing hint describing the public consequence of the two states.
// Shown next to the adoption-status control so staff can see when an
// animal disappears from public listings without relying on color alone.
export function getAdoptionVisibilityHint(
  lifecycleStatus: unknown,
  adoptionStatus: unknown,
): string {
  if (!isAnimalAdoptionStatus(adoptionStatus)) {
    return "Unrecognized listing state — this animal is hidden from the public site. Choose one to fix it.";
  }
  if (adoptionStatus !== "available") {
    return "Hidden from the public site; the record is kept in the registry.";
  }
  if (lifecycleStatus !== "active") {
    return `Not public — the animal is ${getAnimalLifecycleLabel(lifecycleStatus).toLowerCase()}, so it cannot be listed.`;
  }
  return "Shown on the public adoptions page.";
}

// --- Birth date / age ------------------------------------------------------------

// Age display derived from birth_date — never stored, so it can never go
// stale. Estimated dates render with a '~' so the approximation is never
// presented as an exact DOB. Returns null when no birth date is known —
// "unknown" is a display concern, not data.
export function formatAnimalAge(
  birthDate: string | null,
  estimated: boolean,
  today: string = todayIsoDate(),
): string | null {
  if (!birthDate || !isIsoDateString(birthDate)) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (months < 0) return null; // a future birth date is bad data — show nothing
  const prefix = estimated ? "~" : "";
  if (months < 12) {
    return `${prefix}${months} month${months === 1 ? "" : "s"}`;
  }
  const years = Math.floor(months / 12);
  return `${prefix}${years} year${years === 1 ? "" : "s"}`;
}
