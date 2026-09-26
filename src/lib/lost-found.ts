// Canonical lost/found case vocabulary (#176). This module is the
// single authoritative definition of the case model's enums and their
// display labels — the schema CHECK constraints, the domain service,
// the staff UI, and the public page all read from here.
//
// Deliberately separate from the ANIMAL lifecycle (src/lib/
// animal-lifecycle.ts): a lost/found case is a WORKFLOW about a real-
// world event ("Fluffy is missing", "a stray was scanned"), not a
// registry fact about the animal. An animal stays lifecycle 'active'
// while a missing case is open and stays the same permanent record when
// the case resolves. The only intersection: resolving a case with
// outcome 'deceased' drives the canonical lifecycle transition (the
// registry fact) instead of encoding death only in case notes.
//
//   CASE TYPE — which direction the event runs:
//     missing — a REGISTERED animal was reported missing. Always linked
//               to an animal (the DB CHECK requires animal_id).
//     found   — an animal was found/scanned. May be unmatched
//               (animal_id NULL — an unknown chip, an unregistered
//               stray); staff link it to the registry later.
//
//   STATUS — deliberately small workflow state:
//     open      — needs staff attention (the queue)
//     resolved  — the event ended: outcome carries HOW
//     cancelled — the case itself was wrong (duplicate, false report,
//                 entered in error) — no outcome, the note says why
//
//   OUTCOME — the resolution vocabulary, on resolved cases only:
//     reunited      — back with the owner
//     owner-located — owner identified/contacted but the animal did not
//                     (yet) physically return — kept distinct so
//                     "found the owner" is not forced into "reunited"
//     in-care       — taken into SFPCA/rescue care
//     deceased      — the animal was found dead or died in care; for a
//                     linked case the canonical lifecycle transition
//                     also runs
//     other         — anything else; resolution_note carries the detail
//
//   UPDATE KIND — the chronology rows hanging off a case:
//     sighting — somebody saw/reported the animal somewhere
//     scan     — a microchip scan event (the chip-lookup workflow)
//     update   — a staff note/status beat that is none of the above
//     (linkage, publication and resolution also write 'update' rows so
//     the case timeline tells the whole story)

export const LOST_FOUND_CASE_TYPES = ["missing", "found"] as const;
export type LostFoundCaseType = (typeof LOST_FOUND_CASE_TYPES)[number];

export const LOST_FOUND_CASE_STATUSES = [
  "open",
  "resolved",
  "cancelled",
] as const;
export type LostFoundCaseStatus = (typeof LOST_FOUND_CASE_STATUSES)[number];

export const LOST_FOUND_OUTCOMES = [
  "reunited",
  "owner-located",
  "in-care",
  "deceased",
  "other",
] as const;
export type LostFoundOutcome = (typeof LOST_FOUND_OUTCOMES)[number];

export const LOST_FOUND_UPDATE_KINDS = [
  "sighting",
  "scan",
  "update",
] as const;
export type LostFoundUpdateKind = (typeof LOST_FOUND_UPDATE_KINDS)[number];

export const LOST_FOUND_REPORTED_VIA = [
  "staff",
  "owner-portal",
] as const;
export type LostFoundReportedVia = (typeof LOST_FOUND_REPORTED_VIA)[number];

export const LOST_FOUND_CASE_TYPE_LABELS: Record<LostFoundCaseType, string> = {
  missing: "Missing",
  found: "Found",
};

export const LOST_FOUND_STATUS_LABELS: Record<LostFoundCaseStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

export const LOST_FOUND_OUTCOME_LABELS: Record<LostFoundOutcome, string> = {
  reunited: "Reunited with owner",
  "owner-located": "Owner located",
  "in-care": "Taken into care",
  deceased: "Deceased",
  other: "Other",
};

export const LOST_FOUND_UPDATE_KIND_LABELS: Record<
  LostFoundUpdateKind,
  string
> = {
  sighting: "Sighting",
  scan: "Chip scan",
  update: "Update",
};

export function isLostFoundCaseType(
  value: unknown,
): value is LostFoundCaseType {
  return (
    typeof value === "string" &&
    (LOST_FOUND_CASE_TYPES as readonly string[]).includes(value)
  );
}

export function isLostFoundCaseStatus(
  value: unknown,
): value is LostFoundCaseStatus {
  return (
    typeof value === "string" &&
    (LOST_FOUND_CASE_STATUSES as readonly string[]).includes(value)
  );
}

export function isLostFoundOutcome(
  value: unknown,
): value is LostFoundOutcome {
  return (
    typeof value === "string" &&
    (LOST_FOUND_OUTCOMES as readonly string[]).includes(value)
  );
}

export function isLostFoundReportedVia(
  value: unknown,
): value is LostFoundReportedVia {
  return (
    typeof value === "string" &&
    (LOST_FOUND_REPORTED_VIA as readonly string[]).includes(value)
  );
}

export function isLostFoundUpdateKind(
  value: unknown,
): value is LostFoundUpdateKind {
  return (
    typeof value === "string" &&
    (LOST_FOUND_UPDATE_KINDS as readonly string[]).includes(value)
  );
}
