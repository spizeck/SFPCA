// Data-quality vocabulary (#178) — client-safe (no server imports).
//
// The canonical detection service lives in src/lib/registry/data-quality.ts;
// this file carries only the shared enums/labels the admin UI needs.

// --- Severity / actionability ------------------------------------------------
// Deliberately small — every finding must answer "why does a volunteer care?"
//   'blocking' — a hard conflict: the data contradicts itself (an open chip
//                conflict, a malformed chip number). Nothing proceeds safely
//                until a human resolves it.
//   'review'   — needs a human decision: probable duplicates, impossible or
//                contradictory state, money attached to a cancelled record.
//   'advisory' — worth knowing, not urgent: stale confirmations, ownerless
//                animals where the model legitimately allows it.
export const DATA_QUALITY_SEVERITIES = [
  "blocking",
  "review",
  "advisory",
] as const;
export type DataQualitySeverity = (typeof DATA_QUALITY_SEVERITIES)[number];

export const DATA_QUALITY_SEVERITY_LABELS: Record<DataQualitySeverity, string> =
  {
    blocking: "Blocking conflict",
    review: "Needs review",
    advisory: "Advisory",
  };

export function isDataQualitySeverity(
  value: unknown,
): value is DataQualitySeverity {
  return (DATA_QUALITY_SEVERITIES as readonly string[]).includes(
    value as string,
  );
}

// --- Entity types ------------------------------------------------------------
export const DATA_QUALITY_ENTITY_TYPES = [
  "animal",
  "person",
  "household",
  "registration",
  "microchip",
  "ownership",
] as const;
export type DataQualityEntityType =
  (typeof DATA_QUALITY_ENTITY_TYPES)[number];

// --- Detectors ----------------------------------------------------------------
// Stable detector ids — persisted in data_quality_reviews.detector, so
// renaming one strands review history. Add, don't rename.
export type DataQualityDetector =
  // Unresolved #168 chip conflicts, surfaced — not re-detected — here.
  | "microchip-conflict"
  // Probable duplicate identity candidates — never auto-merged.
  | "duplicate-animal"
  | "duplicate-person"
  | "duplicate-household"
  // Active animals with no open ownership where the domain expects one.
  | "animal-no-owner"
  // Open ownership intervals on deceased/moved-off-saba animals.
  | "terminal-open-ownership"
  // Open follow-ups/clinic expectations on deceased/moved-off-saba animals.
  | "terminal-open-work"
  // animals.lifecycle_status diverging from the latest history event.
  | "lifecycle-history-mismatch"
  // birth_date / lifecycle_effective_on in the future.
  | "impossible-dates"
  // Active registration rows on animals whose lifecycle can't hold one.
  | "registration-on-ineligible"
  // Nonzero confirmed money attached to a cancelled registration.
  | "money-on-cancelled-registration"
  // Stored chip numbers violating the canonical normalization shape.
  | "malformed-microchip"
  // photo_urls entries that would fail write-time validation today.
  | "invalid-animal-photo"
  // Open ownership past its annual confirmation window (#166).
  | "confirmation-overdue";

export const DATA_QUALITY_DETECTORS: readonly DataQualityDetector[] = [
  "microchip-conflict",
  "duplicate-animal",
  "duplicate-person",
  "duplicate-household",
  "animal-no-owner",
  "terminal-open-ownership",
  "terminal-open-work",
  "lifecycle-history-mismatch",
  "impossible-dates",
  "registration-on-ineligible",
  "money-on-cancelled-registration",
  "malformed-microchip",
  "invalid-animal-photo",
  "confirmation-overdue",
];

export function isDataQualityDetector(
  value: unknown,
): value is DataQualityDetector {
  return (DATA_QUALITY_DETECTORS as readonly string[]).includes(
    value as string,
  );
}

// --- Categories ---------------------------------------------------------------
// Coarse grouping for the workspace filter — deliberately fewer buckets
// than detectors so the filter list stays volunteer-legible.
export type DataQualityCategory =
  | "duplicates"
  | "identity"
  | "lifecycle"
  | "registrations"
  | "freshness";

export const DATA_QUALITY_CATEGORY_LABELS: Record<
  DataQualityCategory,
  string
> = {
  duplicates: "Possible duplicates",
  identity: "Identifiers & microchips",
  lifecycle: "Registry status problems",
  registrations: "Registration & payment problems",
  freshness: "Stale records",
};

export const DATA_QUALITY_DETECTOR_CATEGORY: Record<
  DataQualityDetector,
  DataQualityCategory
> = {
  "microchip-conflict": "identity",
  "duplicate-animal": "duplicates",
  "duplicate-person": "duplicates",
  "duplicate-household": "duplicates",
  "animal-no-owner": "lifecycle",
  "terminal-open-ownership": "lifecycle",
  "terminal-open-work": "lifecycle",
  "lifecycle-history-mismatch": "lifecycle",
  "impossible-dates": "lifecycle",
  "registration-on-ineligible": "registrations",
  "money-on-cancelled-registration": "registrations",
  "malformed-microchip": "identity",
  "invalid-animal-photo": "identity",
  "confirmation-overdue": "freshness",
};

// --- Review decisions ---------------------------------------------------------
// The persisted human verdict on a finding (data_quality_reviews).
//   'confirmed' — a person verified the problem is real (e.g. "yes, same
//                 animal"). The finding stays visible, flagged confirmed.
//   'dismissed' — reviewed and judged not-a-problem ("different animals
//                 that happen to share a name"). Suppressed while the
//                 evidence fingerprint is unchanged; materially new
//                 evidence resurfaces it.
export const DATA_QUALITY_REVIEW_DECISIONS = ["confirmed", "dismissed"] as const;
export type DataQualityReviewDecision =
  (typeof DATA_QUALITY_REVIEW_DECISIONS)[number];

export function isDataQualityReviewDecision(
  value: unknown,
): value is DataQualityReviewDecision {
  return (DATA_QUALITY_REVIEW_DECISIONS as readonly string[]).includes(
    value as string,
  );
}
