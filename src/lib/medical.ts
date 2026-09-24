// Canonical veterinary-continuity domain rules (#174): controlled
// vocabularies, weight-unit conversion, derived medication state, and
// the medical-timeline item model. Pure functions/constants only — this
// module is imported by the registry service, the admin UI, and tests
// so every layer agrees. It must never import the DB, auth, or
// "server-only".
//
// Scope is deliberately small: this is a continuity record for a
// rotating part-time vet, not an EMR. Vocabularies are CHECK-constrained
// closed sets; everything else is concise free text.

import { isIsoDateString } from "./vaccinations";

// --- Controlled vocabularies (mirror the CHECK constraints in schema.ts) ---

export const ENCOUNTER_KINDS = ["visit", "history", "note"] as const;
export type EncounterKind = (typeof ENCOUNTER_KINDS)[number];
export const ENCOUNTER_KIND_LABELS: Record<EncounterKind, string> = {
  visit: "Visit",
  history: "History",
  note: "Note",
};

export const PROCEDURE_KINDS = [
  "spay",
  "neuter",
  "surgery",
  "dental",
  "wound",
  "other",
] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];
export const PROCEDURE_KIND_LABELS: Record<ProcedureKind, string> = {
  spay: "Spay",
  neuter: "Neuter",
  surgery: "Surgery",
  dental: "Dental",
  wound: "Wound care",
  other: "Other procedure",
};

export const ALERT_KINDS = [
  "allergy",
  "contraindication",
  "condition",
  "other",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  allergy: "Allergy",
  contraindication: "Contraindication",
  condition: "Condition",
  other: "Alert",
};

export const ALERT_SEVERITIES = ["info", "important", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: "Info",
  important: "Important",
  critical: "Critical",
};

// The follow_ups.kind value written when an encounter schedules a
// recheck — the seam #175's work queue reads.
export const RECHECK_FOLLOW_UP_KIND = "recheck";

// --- Weight (authoritative unit is integer grams) ---------------------------

const GRAMS_PER_LB = 453.59237;
export const MAX_WEIGHT_GRAMS = 200_000; // CHECK bound — typo guard

// Parses a staff-entered weight into grams. Returns null when the value
// is missing or out of the plausible range — the service treats null
// as invalid input, never guesses.
export function parseWeightToGrams(
  value: string,
  unit: "kg" | "lb",
): number | null {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return null;
  const grams = Math.round(unit === "kg" ? n * 1000 : n * GRAMS_PER_LB);
  return grams > 0 && grams <= MAX_WEIGHT_GRAMS ? grams : null;
}

// kg with one decimal — the display convention on the record.
export function formatWeightGrams(grams: number): string {
  return `${(grams / 1000).toFixed(1)} kg`;
}

// --- Derived medication state ------------------------------------------------

// "Active" is derived, never stored: a course is current while today is
// inside [startOn, endOn] (endOn null = ongoing/indefinite).
export function isMedicationActive(
  startOn: string,
  endOn: string | null,
  today: string,
): boolean {
  return startOn <= today && (endOn === null || endOn >= today);
}

// --- Timeline ----------------------------------------------------------------

// Every dated clinical record type that composes the per-animal
// medical timeline. `record` is the admin DTO from the domain service;
// `date` is the timeline ordering key (ISO date) — null only for a
// procedure whose performed_on is unknown.
export type MedicalTimelineKind =
  | "encounter"
  | "vaccination"
  | "procedure"
  | "medication"
  | "weight"
  | "alert";

export const TIMELINE_KIND_LABELS: Record<MedicalTimelineKind, string> = {
  encounter: "Visit",
  vaccination: "Vaccination",
  procedure: "Procedure",
  medication: "Medication",
  weight: "Weight",
  alert: "Alert",
};

// Newest first; undated entries (unknown procedure dates) sink to the
// bottom; createdAt breaks same-date ties deterministically.
export function compareTimelineItems<
  T extends { date: string | null; createdAt: string },
>(a: T, b: T): number {
  if (a.date === null && b.date === null) {
    return b.createdAt.localeCompare(a.createdAt);
  }
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  return b.createdAt.localeCompare(a.createdAt);
}

// Validates an ISO date that records a past/current clinical event —
// future dates are rejected because these records describe what
// happened, not schedules (follow_ups own future dates).
export function isPastOrTodayIsoDate(
  value: string,
  today: string,
): boolean {
  return isIsoDateString(value) && value <= today;
}
