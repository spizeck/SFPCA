// Human-confirmed duplicate-animal merge (#178).
//
// Detection says "these might be the same animal"; this module is where
// a human's decision executes. The workflow is deliberately staged:
//
//   previewAnimalMerge  — server-side analysis of a chosen direction:
//     blockers (incompatible current chips, simultaneous open cases),
//     field conflicts the staff must resolve, same-year registration
//     collisions, and per-domain reparent counts. Nothing mutates. A
//     fingerprint over everything the merge will touch is returned; the
//     execute call re-computes it inside the transaction so a stale
//     preview can never blind-apply.
//
//   executeAnimalMerge  — one transaction:
//     locks BOTH animal rows (deterministic id order, no deadlocks),
//     revalidates existence/mergeability, re-runs the analysis, refuses
//     a fingerprint mismatch, applies field choices, reparents every
//     dependent-history table to the survivor, retires the duplicate
//     (lifecycle 'merged', listing cleared), records the lineage in
//     animal_merges, and writes lifecycle + audit + review evidence.
//
// Nothing is deleted: the retired row persists with its registry_ref and
// merge lineage; same-year registration collisions stay on the retired
// record cancelled as 'correction' so payment history is never orphaned
// or silently re-attributed. 'corrected' microchip rows also stay — a
// corrected chip was never truly this animal's.
//
// Merges never chain: animal_merges.retired_animal_id is unique and a
// 'merged' animal can never be a merge input again, so an alias always
// resolves in exactly one hop.

import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  animalLifecycleEvents,
  animalMerges,
  animals,
  auditEvents,
  clinicExpectations,
  communications,
  dataQualityReviews,
  followUps,
  households,
  lostFoundCases,
  medicalAlerts,
  microchipConflicts,
  microchipRecords,
  ownerRequests,
  ownershipConfirmations,
  ownerships,
  persons,
  registrations,
  vaccinations,
  vetDocuments,
  vetEncounters,
  vetMedications,
  vetProcedures,
  weightRecords,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { todayIsoDate } from "../vaccinations";
import { getAdminAnimal, type AdminAnimal } from "./animals";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Types -----------------------------------------------------------------------

export interface MergeBlocker {
  code:
    | "self-merge"
    | "already-merged"
    | "incompatible-chips"
    | "open-missing-cases"
    | "open-found-cases";
  message: string;
}

export type MergeFieldName =
  | "species"
  | "sex"
  | "birthDate"
  | "sterilizationStatus"
  | "sterilizedOn"
  | "sterilizedBy";

export interface MergeFieldConflict {
  field: MergeFieldName;
  label: string;
  survivorValue: string | null;
  retiredValue: string | null;
}

export interface MergeRegistrationCollision {
  year: number;
  survivorRegistrationId: string;
  retiredRegistrationId: string;
  retiredStatus: string;
}

export interface MergeReparentGroup {
  domain: string;
  label: string;
  count: number;
}

export interface AnimalMergePreview {
  survivor: AdminAnimal;
  retired: AdminAnimal;
  blockers: MergeBlocker[];
  // Identity fields where both sides disagree — staff MUST pick.
  fieldConflicts: MergeFieldConflict[];
  // What the merge combines or keeps automatically, in plain language.
  autoNotes: string[];
  registrationCollisions: MergeRegistrationCollision[];
  reparentCounts: MergeReparentGroup[];
  fingerprint: string;
}

export type AnimalMergeResult =
  | { ok: true; mergeId: string; survivorId: string; survivorRef: string }
  | {
      ok: false;
      reason: "not-found" | "invalid" | "stale" | "blocked";
      blockers?: MergeBlocker[];
      missingFields?: MergeFieldName[];
    };

// --- Pair analysis -------------------------------------------------------------
// Shared by preview and execute — execute re-runs it under row locks so
// the plan staff confirmed is the plan that executes (or it refuses).

interface PairRow {
  id: string;
  name: string;
  species: string;
  sex: string;
  birthDate: string | null;
  birthDateEstimated: boolean;
  description: string | null;
  identifyingNotes: string | null;
  lifecycleStatus: string;
  adoptionStatus: string;
  sterilizationStatus: string;
  sterilizedOn: string | null;
  sterilizedBy: string | null;
  photoUrls: string[] | null;
  registryRef: string;
  legacyId: string | null;
  updatedAt: Date;
}

interface PairAnalysis {
  blockers: MergeBlocker[];
  fieldConflicts: MergeFieldConflict[];
  autoNotes: string[];
  collisions: MergeRegistrationCollision[];
  reparentCounts: MergeReparentGroup[];
  // Open chip conflicts that collapse to self-references once the
  // retired id reparents onto the survivor.
  selfResolvingConflicts: number;
}

async function analyzePair(
  survivor: PairRow,
  retired: PairRow,
  db: RegistryDb,
): Promise<PairAnalysis> {
  const blockers: MergeBlocker[] = [];
  const fieldConflicts: MergeFieldConflict[] = [];
  const autoNotes: string[] = [];

  // --- Hard blockers ---
  if (survivor.id === retired.id) {
    blockers.push({
      code: "self-merge",
      message: "An animal cannot be merged into itself.",
    });
  }
  if (retired.lifecycleStatus === "merged") {
    blockers.push({
      code: "already-merged",
      message: `${retired.name} (${retired.registryRef}) is already a merged record.`,
    });
  }
  if (survivor.lifecycleStatus === "merged") {
    blockers.push({
      code: "already-merged",
      message: `${survivor.name} (${survivor.registryRef}) is itself a merged record — merge into a canonical animal.`,
    });
  }

  // Microchip: at most one side may carry a CURRENT chip. Both having
  // open chip rows means two different physical chips — only a human can
  // say which animal wears which chip, so the merge stops here.
  const openChips = await db
    .select({ animalId: microchipRecords.animalId, chip: microchipRecords.chipNumber })
    .from(microchipRecords)
    .where(
      and(
        inArray(microchipRecords.animalId, [survivor.id, retired.id]),
        isNull(microchipRecords.assignedTo),
      ),
    );
  const survivorChip = openChips.find((c) => c.animalId === survivor.id);
  const retiredChip = openChips.find((c) => c.animalId === retired.id);
  if (survivorChip && retiredChip) {
    blockers.push({
      code: "incompatible-chips",
      message: `Both records hold a different CURRENT microchip (${survivorChip.chip} and ${retiredChip.chip}). Correct the wrong chip assignment on one record first — a merge can't decide which chip the animal really wears.`,
    });
  }

  // Lost/found: two simultaneous open cases of the same type can't
  // coexist on one animal — resolve or cancel one first.
  const openCases = await db
    .select({
      animalId: lostFoundCases.animalId,
      caseType: lostFoundCases.caseType,
    })
    .from(lostFoundCases)
    .where(
      and(
        inArray(lostFoundCases.animalId, [survivor.id, retired.id]),
        eq(lostFoundCases.status, "open"),
      ),
    );
  const countOpen = (animalId: string, kind: string) =>
    openCases.filter((c) => c.animalId === animalId && c.caseType === kind)
      .length;
  if (countOpen(survivor.id, "missing") > 0 && countOpen(retired.id, "missing") > 0) {
    blockers.push({
      code: "open-missing-cases",
      message:
        "Both records have an open missing case. Resolve or cancel one first — one animal can't be missing twice.",
    });
  }
  if (countOpen(survivor.id, "found") > 0 && countOpen(retired.id, "found") > 0) {
    blockers.push({
      code: "open-found-cases",
      message:
        "Both records have an open found case. Resolve or cancel one first — one animal can't be found twice.",
    });
  }

  // --- Field conflicts (both sides non-null and disagreeing) ---
  const conflict = (
    field: MergeFieldName,
    label: string,
    a: string | null,
    b: string | null,
  ) => {
    if (a != null && b != null && a !== b) {
      fieldConflicts.push({ field, label, survivorValue: a, retiredValue: b });
      return true;
    }
    return false;
  };

  conflict("species", "Species", survivor.species, retired.species);
  // Sex: 'unknown' yields to a recorded value automatically.
  if (survivor.sex !== retired.sex) {
    if (survivor.sex === "unknown" || retired.sex === "unknown") {
      autoNotes.push(
        `Sex keeps the recorded value (${survivor.sex === "unknown" ? retired.sex : survivor.sex}) — the other side is unknown.`,
      );
    } else {
      fieldConflicts.push({
        field: "sex",
        label: "Sex",
        survivorValue: survivor.sex,
        retiredValue: retired.sex,
      });
    }
  }
  if (
    survivor.birthDate != null &&
    retired.birthDate != null &&
    survivor.birthDate !== retired.birthDate
  ) {
    fieldConflicts.push({
      field: "birthDate",
      label: "Birth date",
      survivorValue: survivor.birthDate,
      retiredValue: retired.birthDate,
    });
  } else if (retired.birthDate && !survivor.birthDate) {
    autoNotes.push(`Birth date filled from ${retired.registryRef}: ${retired.birthDate}.`);
  }
  // Sterilization: a definite status beats 'unknown'; sterilized-vs-intact
  // is a real conflict.
  if (survivor.sterilizationStatus !== retired.sterilizationStatus) {
    if (
      survivor.sterilizationStatus === "unknown" ||
      retired.sterilizationStatus === "unknown"
    ) {
      const kept =
        survivor.sterilizationStatus === "unknown"
          ? retired.sterilizationStatus
          : survivor.sterilizationStatus;
      autoNotes.push(`Sterilization status keeps "${kept}" — the other side is unknown.`);
    } else {
      fieldConflicts.push({
        field: "sterilizationStatus",
        label: "Sterilization status",
        survivorValue: survivor.sterilizationStatus,
        retiredValue: retired.sterilizationStatus,
      });
    }
  }
  conflict("sterilizedOn", "Sterilization date", survivor.sterilizedOn, retired.sterilizedOn);
  conflict("sterilizedBy", "Sterilization provider", survivor.sterilizedBy, retired.sterilizedBy);

  // --- Automatic combinations (shown, not chosen) ---
  if ((retired.photoUrls ?? []).some((u) => !(survivor.photoUrls ?? []).includes(u))) {
    autoNotes.push("Photo lists are combined on the survivor.");
  }
  if (retired.description && !survivor.description) {
    autoNotes.push("Public description is filled from the retired record.");
  }
  if (retired.identifyingNotes && retired.identifyingNotes !== survivor.identifyingNotes) {
    autoNotes.push(
      survivor.identifyingNotes
        ? "Identifying notes from both records are kept, separated."
        : "Identifying notes are filled from the retired record.",
    );
  }
  if (survivor.name !== retired.name) {
    autoNotes.push(`The name stays "${survivor.name}" — "${retired.name}" is preserved in the retired record and audit trail.`);
  }


  // --- Registration collisions ---
  // Unique (animal_id, year): when both hold a row for the same year the
  // retired record's row CANNOT reparent — it stays on the retired
  // record, cancelled as 'correction', with its payments/audit intact.
  const regRows = await db
    .select({
      id: registrations.id,
      animalId: registrations.animalId,
      year: registrations.year,
      status: registrations.status,
    })
    .from(registrations)
    .where(inArray(registrations.animalId, [survivor.id, retired.id]));
  const survivorYears = new Map(
    regRows.filter((r) => r.animalId === survivor.id).map((r) => [r.year, r]),
  );
  const collisions: MergeRegistrationCollision[] = [];
  let reparentedRegistrations = 0;
  for (const r of regRows.filter((r) => r.animalId === retired.id)) {
    const clash = survivorYears.get(r.year);
    if (clash) {
      collisions.push({
        year: r.year,
        survivorRegistrationId: clash.id,
        retiredRegistrationId: r.id,
        retiredStatus: r.status,
      });
    } else {
      reparentedRegistrations += 1;
    }
  }

  // --- Reparent counts ---
  // Explicit per-table counts — this is the "what will move" preview and
  // the execute-time movedCounts record, so it stays readable.
  const countTable = async (
    table: PgTable,
    column: AnyPgColumn,
  ): Promise<number> => {
    const [r] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(column, retired.id));
    return r?.c ?? 0;
  };

  const openConflicts = await db
    .select({
      id: microchipConflicts.id,
      claimed: microchipConflicts.claimedAnimalId,
      existing: microchipConflicts.existingAnimalId,
    })
    .from(microchipConflicts)
    .where(
      and(
        eq(microchipConflicts.status, "open"),
        or(
          eq(microchipConflicts.claimedAnimalId, retired.id),
          eq(microchipConflicts.existingAnimalId, retired.id),
        ),
      ),
    );

  const reparentCounts: MergeReparentGroup[] = [
    { domain: "ownerships", label: "Ownership intervals", count: await countTable(ownerships, ownerships.animalId as never) },
    { domain: "ownership_confirmations", label: "Ownership confirmations", count: await countTable(ownershipConfirmations, ownershipConfirmations.animalId as never) },
    { domain: "registrations", label: `Registrations (${collisions.length} same-year stay on retired, cancelled)`, count: reparentedRegistrations },
    { domain: "microchips", label: "Microchip records", count: await countTable(microchipRecords, microchipRecords.animalId as never) },
    { domain: "chip_conflicts", label: "Open chip conflicts touching this record", count: openConflicts.length },
    { domain: "lost_found", label: "Lost/found cases", count: await countTable(lostFoundCases, lostFoundCases.animalId as never) },
    { domain: "vet_encounters", label: "Vet encounters", count: await countTable(vetEncounters, vetEncounters.animalId as never) },
    { domain: "vet_procedures", label: "Vet procedures", count: await countTable(vetProcedures, vetProcedures.animalId as never) },
    { domain: "vet_medications", label: "Medications", count: await countTable(vetMedications, vetMedications.animalId as never) },
    { domain: "medical_alerts", label: "Medical alerts", count: await countTable(medicalAlerts, medicalAlerts.animalId as never) },
    { domain: "weights", label: "Weight records", count: await countTable(weightRecords, weightRecords.animalId as never) },
    { domain: "documents", label: "Documents", count: await countTable(vetDocuments, vetDocuments.animalId as never) },
    { domain: "vaccinations", label: "Vaccinations", count: await countTable(vaccinations, vaccinations.animalId as never) },
    { domain: "follow_ups", label: "Follow-ups", count: await countTable(followUps, followUps.animalId as never) },
    { domain: "clinic", label: "Clinic expectations", count: await countTable(clinicExpectations, clinicExpectations.animalId as never) },
    { domain: "communications", label: "Communications", count: await countTable(communications, communications.animalId as never) },
    { domain: "owner_requests", label: "Owner requests", count: await countTable(ownerRequests, ownerRequests.animalId as never) },
    { domain: "lifecycle_events", label: "Lifecycle history entries", count: await countTable(animalLifecycleEvents, animalLifecycleEvents.animalId as never) },
  ];

  return {
    blockers,
    fieldConflicts,
    autoNotes,
    collisions,
    reparentCounts,
    selfResolvingConflicts: openConflicts.length,
  };
}

function analysisFingerprint(
  survivor: PairRow,
  retired: PairRow,
  a: PairAnalysis,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        s: survivor.id,
        r: retired.id,
        su: survivor.updatedAt.toISOString(),
        ru: retired.updatedAt.toISOString(),
        blockers: a.blockers.map((b) => b.code),
        conflicts: a.fieldConflicts.map(
          (c) => `${c.field}:${c.survivorValue}<>${c.retiredValue}`,
        ),
        collisions: a.collisions.map((c) => `${c.year}:${c.retiredRegistrationId}`),
        counts: a.reparentCounts.map((c) => `${c.domain}:${c.count}`),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

async function loadPairRow(
  id: string,
  db: RegistryDb,
): Promise<PairRow | undefined> {
  const [row] = await db.select().from(animals).where(eq(animals.id, id));
  return row;
}

// --- Pair context ------------------------------------------------------------------
// What the merge page renders before a direction is chosen: both records
// with the identifying context (owners, chips) a volunteer needs to tell
// them apart.
export interface MergePairSide {
  animal: AdminAnimal;
  // Current owner display labels (person full names / household names).
  owners: string[];
  // Chip numbers on record — current first, then closed.
  chips: string[];
}

export async function getMergePair(
  aId: string,
  bId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ a: MergePairSide; b: MergePairSide } | null> {
  if (!UUID_RE.test(aId) || !UUID_RE.test(bId)) return null;
  const [a, b] = await Promise.all([
    getAdminAnimal(aId, db),
    getAdminAnimal(bId, db),
  ]);
  if (!a || !b) return null;

  const ownerRows = await db
    .select({
      animalId: ownerships.animalId,
      personName: persons.fullName,
      householdName: households.name,
    })
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        inArray(ownerships.animalId, [aId, bId]),
        isNull(ownerships.validTo),
      ),
    );
  const chipRows = await db
    .select({
      animalId: microchipRecords.animalId,
      chip: microchipRecords.chipNumber,
      display: microchipRecords.chipDisplay,
      open: isNull(microchipRecords.assignedTo),
    })
    .from(microchipRecords)
    .where(inArray(microchipRecords.animalId, [aId, bId]));

  const side = (animal: AdminAnimal): MergePairSide => ({
    animal,
    owners: [
      ...new Set(
        ownerRows
          .filter((r) => r.animalId === animal.id)
          .map((r) => r.personName ?? r.householdName)
          .filter((v): v is string => v != null),
      ),
    ],
    chips: chipRows
      .filter((r) => r.animalId === animal.id)
      .sort((x, y) => Number(y.open) - Number(x.open))
      .map((r) => `${r.display ?? r.chip}${r.open ? "" : " (closed)"}`),
  });
  return { a: side(a), b: side(b) };
}

// --- Preview ---------------------------------------------------------------------

export type AnimalMergePreviewResult =
  | { ok: true; preview: AnimalMergePreview }
  | { ok: false; reason: "not-found" | "invalid"; message: string };

export async function previewAnimalMerge(
  survivorId: string,
  retiredId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMergePreviewResult> {
  if (!UUID_RE.test(survivorId) || !UUID_RE.test(retiredId)) {
    return { ok: false, reason: "invalid", message: "Unknown animal id." };
  }
  if (survivorId === retiredId) {
    return {
      ok: false,
      reason: "invalid",
      message: "An animal cannot be merged into itself.",
    };
  }
  const [survivor, retired] = await Promise.all([
    loadPairRow(survivorId, db),
    loadPairRow(retiredId, db),
  ]);
  if (!survivor || !retired) {
    return { ok: false, reason: "not-found", message: "Animal not found." };
  }
  const analysis = await analyzePair(survivor, retired, db);
  const sDto = await getAdminAnimal(survivorId, db);
  const rDto = await getAdminAnimal(retiredId, db);
  return {
    ok: true,
    preview: {
      survivor: sDto!,
      retired: rDto!,
      blockers: analysis.blockers,
      fieldConflicts: analysis.fieldConflicts,
      autoNotes: analysis.autoNotes,
      registrationCollisions: analysis.collisions,
      reparentCounts: analysis.reparentCounts.filter((c) => c.count > 0),
      fingerprint: analysisFingerprint(survivor, retired, analysis),
    },
  };
}

// --- Execute ------------------------------------------------------------------------

export interface AnimalMergeInput {
  survivorId: string;
  retiredId: string;
  // Field conflict resolutions: field → 'survivor' | 'retired'.
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
  actorLabel: string;
  actorIdentityId?: string | null;
}

// Apply the staff-chosen values plus automatic field combinations to the
// survivor row. Returns the column update set.
function survivorUpdates(
  survivor: PairRow,
  retired: PairRow,
  analysis: PairAnalysis,
  choices: Record<string, "survivor" | "retired">,
): Record<string, unknown> {
  const pick = <T>(field: MergeFieldName, a: T, b: T): T =>
    choices[field] === "retired" ? b : a;

  const updates: Record<string, unknown> = {};
  for (const c of analysis.fieldConflicts) {
    if (c.field === "species") updates.species = pick(c.field, survivor.species, retired.species);
    if (c.field === "sex") updates.sex = pick(c.field, survivor.sex, retired.sex);
    if (c.field === "birthDate") {
      updates.birthDate = pick(c.field, survivor.birthDate, retired.birthDate);
      updates.birthDateEstimated =
        choices.birthDate === "retired"
          ? retired.birthDateEstimated
          : survivor.birthDateEstimated;
    }
    if (c.field === "sterilizationStatus") {
      updates.sterilizationStatus = pick(
        c.field,
        survivor.sterilizationStatus,
        retired.sterilizationStatus,
      );
    }
    if (c.field === "sterilizedOn") {
      updates.sterilizedOn = pick(c.field, survivor.sterilizedOn, retired.sterilizedOn);
    }
    if (c.field === "sterilizedBy") {
      updates.sterilizedBy = pick(c.field, survivor.sterilizedBy, retired.sterilizedBy);
    }
  }
  // Auto-combines.
  if (survivor.sex === "unknown" && retired.sex !== "unknown") {
    updates.sex = retired.sex;
  }
  if (survivor.birthDate == null && retired.birthDate != null) {
    updates.birthDate = retired.birthDate;
    updates.birthDateEstimated = retired.birthDateEstimated;
  }
  if (survivor.sterilizationStatus === "unknown" && retired.sterilizationStatus !== "unknown") {
    updates.sterilizationStatus = retired.sterilizationStatus;
    if (retired.sterilizedOn && !survivor.sterilizedOn) {
      updates.sterilizedOn = retired.sterilizedOn;
    }
    if (retired.sterilizedBy && !survivor.sterilizedBy) {
      updates.sterilizedBy = retired.sterilizedBy;
    }
  }
  const sterilized =
    (updates.sterilizationStatus ?? survivor.sterilizationStatus) === "sterilized";
  if (!sterilized) {
    updates.sterilizedOn = null;
    updates.sterilizedBy = null;
  } else {
    updates.sterilizedOn ??= survivor.sterilizedOn ?? retired.sterilizedOn;
    updates.sterilizedBy ??= survivor.sterilizedBy ?? retired.sterilizedBy;
  }
  if (!survivor.description && retired.description) {
    updates.description = retired.description;
  }
  const notes = [survivor.identifyingNotes, retired.identifyingNotes]
    .filter((v, i, a): v is string => v != null && a.indexOf(v) === i);
  if (notes.length > (survivor.identifyingNotes ? 1 : 0)) {
    updates.identifyingNotes = notes.join(" | ");
  }
  const photos = [...new Set([...(survivor.photoUrls ?? []), ...(retired.photoUrls ?? [])])];
  if (photos.length !== (survivor.photoUrls ?? []).length) {
    updates.photoUrls = photos;
  }
  updates.updatedAt = new Date();
  return updates;
}

export async function executeAnimalMerge(
  input: AnimalMergeInput,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMergeResult> {
  if (!UUID_RE.test(input.survivorId) || !UUID_RE.test(input.retiredId)) {
    return { ok: false, reason: "invalid" };
  }
  if (input.survivorId === input.retiredId) {
    return {
      ok: false,
      reason: "invalid",
      blockers: [{ code: "self-merge", message: "An animal cannot be merged into itself." }],
    };
  }
  const today = todayIsoDate();

  return db.transaction(async (tx) => {
    // Lock both identity rows in deterministic order — a concurrent
    // merge, chip assignment, or lifecycle transition waits, then sees
    // the committed outcome rather than interleaving.
    const [first, second] = [input.survivorId, input.retiredId].sort();
    await tx
      .select({ id: animals.id })
      .from(animals)
      .where(inArray(animals.id, [first, second]))
      .for("update");

    const survivor = await loadPairRow(input.survivorId, tx);
    const retired = await loadPairRow(input.retiredId, tx);
    if (!survivor || !retired) return { ok: false as const, reason: "not-found" as const };

    const analysis = await analyzePair(survivor, retired, tx);
    if (analysis.blockers.length > 0) {
      return { ok: false as const, reason: "blocked" as const, blockers: analysis.blockers };
    }
    const freshFingerprint = analysisFingerprint(survivor, retired, analysis);
    if (freshFingerprint !== input.fingerprint) {
      // Something changed since the preview — staff must look again.
      return { ok: false as const, reason: "stale" as const };
    }

    // Every displayed conflict must have an explicit staff choice.
    const missing = analysis.fieldConflicts
      .filter((c) => input.fieldChoices[c.field] !== "survivor" && input.fieldChoices[c.field] !== "retired")
      .map((c) => c.field);
    if (missing.length > 0) {
      return { ok: false as const, reason: "invalid" as const, missingFields: missing };
    }

    const moved: Record<string, number> = {};

    // --- Ownership -------------------------------------------------------------
    // If the SAME owner already has an open interval on the survivor,
    // the retired record's duplicate open interval closes today instead
    // of reparenting — two open intervals to one owner would be a new
    // ambiguity the merge shouldn't create. Its history row survives.
    const survivorOpenOwners = new Set(
      (
        await tx
          .select({ personId: ownerships.personId, householdId: ownerships.householdId })
          .from(ownerships)
          .where(and(eq(ownerships.animalId, survivor.id), isNull(ownerships.validTo)))
      ).map((o) => o.personId ?? o.householdId),
    );
    const retiredOpen = await tx
      .select()
      .from(ownerships)
      .where(and(eq(ownerships.animalId, retired.id), isNull(ownerships.validTo)));
    // Intervals closed by this merge stay on the retired record — they
    // document a duplicate interval, not a real ownership change on the
    // animal. Everything else reparents to the survivor.
    const closedIds = new Set<string>();
    for (const o of retiredOpen) {
      const ownerKey = o.personId ?? o.householdId;
      if (ownerKey && survivorOpenOwners.has(ownerKey) && o.validFrom < today) {
        await tx
          .update(ownerships)
          .set({
            validTo: today,
            note: [o.note, `Closed by merge into ${survivor.registryRef}`]
              .filter(Boolean)
              .join(" "),
          })
          .where(eq(ownerships.id, o.id));
        closedIds.add(o.id);
      } else {
        await tx
          .update(ownerships)
          .set({ animalId: survivor.id })
          .where(eq(ownerships.id, o.id));
      }
    }
    // Remaining (already-closed) retired ownership intervals move to
    // the survivor — the merged animal's real history belongs there.
    const movedOwnerships = await tx
      .update(ownerships)
      .set({ animalId: survivor.id })
      .where(
        and(
          eq(ownerships.animalId, retired.id),
          closedIds.size
            ? notInArray(ownerships.id, [...closedIds])
            : undefined,
        ),
      )
      .returning();
    moved["ownerships"] = movedOwnerships.length;
    moved["ownerships_closed"] = closedIds.size;

    const reparent = async (
      table: PgTable & { id: AnyPgColumn; animalId: AnyPgColumn },
      domain: string,
    ) => {
      const rows = await tx
        .update(table)
        .set({ animalId: survivor.id })
        .where(eq(table.animalId, retired.id))
        .returning();
      moved[domain] = rows.length;
    };

    await reparent(ownershipConfirmations, "ownership_confirmations");

    // --- Registrations -----------------------------------------------------------
    // Non-colliding years reparent; colliding years STAY on the retired
    // record and are cancelled as 'correction' — their payments and
    // audit trail never move, never disappear.
    const survivorRegYears = new Set(
      (
        await tx
          .select({ year: registrations.year })
          .from(registrations)
          .where(eq(registrations.animalId, survivor.id))
      ).map((r) => r.year),
    );
    const retiredRegs = await tx
      .select({ id: registrations.id, year: registrations.year, status: registrations.status })
      .from(registrations)
      .where(eq(registrations.animalId, retired.id));
    let movedRegs = 0;
    let cancelledRegs = 0;
    for (const r of retiredRegs) {
      if (survivorRegYears.has(r.year)) {
        if (r.status !== "cancelled") {
          await tx
            .update(registrations)
            .set({
              status: "cancelled",
              cancelledAt: new Date(),
              cancellationReason: "correction",
              cancellationNote: `Duplicate registration — animal merged into ${survivor.registryRef}`,
              updatedAt: new Date(),
            })
            .where(eq(registrations.id, r.id));
          cancelledRegs += 1;
        }
      } else {
        await tx
          .update(registrations)
          .set({ animalId: survivor.id, updatedAt: new Date() })
          .where(eq(registrations.id, r.id));
        movedRegs += 1;
      }
    }
    moved["registrations"] = movedRegs;
    moved["registrations_superseded"] = cancelledRegs;

    // --- Microchips ----------------------------------------------------------------
    // Everything except 'corrected' rows reparents — a corrected chip
    // means "was never this animal's chip" and stays as evidence on the
    // retired record.
    const movedChips = await tx
      .update(microchipRecords)
      .set({ animalId: survivor.id, updatedAt: new Date() })
      .where(
        and(
          eq(microchipRecords.animalId, retired.id),
          sql`${microchipRecords.closedReason} IS DISTINCT FROM 'corrected'`,
        ),
      )
      .returning();
    moved["microchips"] = movedChips.length;

    // Chip conflicts referencing the retired id point at the survivor
    // after merge — conflicts that become self-references (the pair
    // conflicted with each other) resolve automatically: they are the
    // merge's own evidence.
    await tx
      .update(microchipConflicts)
      .set({ claimedAnimalId: survivor.id, updatedAt: new Date() })
      .where(eq(microchipConflicts.claimedAnimalId, retired.id));
    await tx
      .update(microchipConflicts)
      .set({ existingAnimalId: survivor.id, updatedAt: new Date() })
      .where(eq(microchipConflicts.existingAnimalId, retired.id));
    const selfResolved = await tx
      .update(microchipConflicts)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: input.actorLabel,
        resolutionNote: `Superseded by animal merge — both records are now ${survivor.registryRef}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(microchipConflicts.status, "open"),
          sql`${microchipConflicts.claimedAnimalId} = ${microchipConflicts.existingAnimalId}`,
        ),
      )
      .returning();
    moved["chip_conflicts_resolved"] = selfResolved.length;

    // --- Everything else reparents wholesale ---------------------------------------
    await reparent(lostFoundCases, "lost_found");
    await reparent(vetEncounters, "vet_encounters");
    await reparent(vetProcedures, "vet_procedures");
    await reparent(vetMedications, "vet_medications");
    await reparent(medicalAlerts, "medical_alerts");
    await reparent(weightRecords, "weights");
    await reparent(vetDocuments, "documents");
    await reparent(vaccinations, "vaccinations");
    await reparent(followUps, "follow_ups");
    await reparent(clinicExpectations, "clinic");
    await reparent(communications, "communications");
    await reparent(ownerRequests, "owner_requests");
    // The retired record's whole lifecycle history becomes the
    // survivor's lineage; the merge event written below is the retired
    // record's own terminal row.
    await reparent(animalLifecycleEvents, "lifecycle_events");

    // --- Identity fields --------------------------------------------------------------
    await tx
      .update(animals)
      .set(survivorUpdates(survivor, retired, analysis, input.fieldChoices))
      .where(eq(animals.id, survivor.id));

    // --- Retire the duplicate -----------------------------------------------------------
    await tx
      .update(animals)
      .set({
        lifecycleStatus: "merged",
        lifecycleEffectiveOn: today,
        adoptionStatus: "not-listed",
        updatedAt: new Date(),
      })
      .where(eq(animals.id, retired.id));

    const [merge] = await tx
      .insert(animalMerges)
      .values({
        retiredAnimalId: retired.id,
        survivorAnimalId: survivor.id,
        retiredRegistryRef: retired.registryRef,
        retiredLegacyId: retired.legacyId,
        fieldChoices: input.fieldChoices,
        movedCounts: moved,
        note: input.note?.trim() || null,
        mergedByLabel: input.actorLabel,
        mergedByIdentityId: input.actorIdentityId ?? null,
      })
      .returning();

    await tx.insert(animalLifecycleEvents).values({
      animalId: retired.id,
      fromStatus: retired.lifecycleStatus,
      toStatus: "merged",
      effectiveOn: today,
      source: "merge",
      sourceRef: merge.id,
      reason: input.note?.trim() || `Merged into ${survivor.registryRef}`,
      actorLabel: input.actorLabel,
      actorIdentityId: input.actorIdentityId ?? null,
    });

    await tx.insert(auditEvents).values([
      {
        actorLabel: input.actorLabel,
        actorIdentityId: input.actorIdentityId ?? null,
        entityType: "animal",
        entityId: retired.id,
        action: "merge-retire",
        after: {
          mergedInto: survivor.id,
          survivorRef: survivor.registryRef,
          fieldChoices: input.fieldChoices,
          moved,
        },
      },
      {
        actorLabel: input.actorLabel,
        actorIdentityId: input.actorIdentityId ?? null,
        entityType: "animal",
        entityId: survivor.id,
        action: "merge-absorb",
        after: {
          retiredId: retired.id,
          retiredRef: retired.registryRef,
          fieldChoices: input.fieldChoices,
          moved,
        },
      },
    ]);

    // A successful merge IS the confirmed review for the duplicate pair.
    const [a, b] = [survivor.id, retired.id].sort();
    await tx
      .insert(dataQualityReviews)
      .values({
        detector: "duplicate-animal",
        entityType: "animal",
        entityA: a,
        entityB: b,
        fingerprint: "merge",
        decision: "confirmed",
        note: `Merged into ${survivor.registryRef} (merge ${merge.id})`,
        decidedByLabel: input.actorLabel,
        decidedByIdentityId: input.actorIdentityId ?? null,
      })
      .onConflictDoNothing();

    return {
      ok: true as const,
      mergeId: merge.id,
      survivorId: survivor.id,
      survivorRef: survivor.registryRef,
    };
  });
}

// --- Retired-identity resolution ------------------------------------------------

export interface AnimalMergeInfo {
  status: "merged" | "canonical";
  // For 'merged': where the record went.
  survivor: { id: string; registryRef: string } | null;
  mergedAt: string | null;
  mergedByLabel: string | null;
  // For 'canonical': retired identities absorbed into this record.
  absorbed: { id: string; registryRef: string; mergedAt: string }[];
}

// Merge lineage for an animal profile — the retired record's "this went
// somewhere" notice and the survivor's absorbed-identity list.
export async function getAnimalMergeInfo(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMergeInfo | null> {
  if (!UUID_RE.test(animalId)) return null;
  const [asRetired] = await db
    .select({
      survivorId: animalMerges.survivorAnimalId,
      survivorRef: animals.registryRef,
      mergedAt: animalMerges.createdAt,
      mergedByLabel: animalMerges.mergedByLabel,
    })
    .from(animalMerges)
    .innerJoin(animals, eq(animalMerges.survivorAnimalId, animals.id))
    .where(eq(animalMerges.retiredAnimalId, animalId));
  if (asRetired) {
    return {
      status: "merged",
      survivor: { id: asRetired.survivorId, registryRef: asRetired.survivorRef },
      mergedAt: asRetired.mergedAt.toISOString(),
      mergedByLabel: asRetired.mergedByLabel,
      absorbed: [],
    };
  }
  const absorbedRows = await db
    .select({
      retiredId: animalMerges.retiredAnimalId,
      retiredRef: animalMerges.retiredRegistryRef,
      mergedAt: animalMerges.createdAt,
    })
    .from(animalMerges)
    .where(eq(animalMerges.survivorAnimalId, animalId))
    .orderBy(asc(animalMerges.createdAt));
  return {
    status: "canonical",
    survivor: null,
    mergedAt: null,
    mergedByLabel: null,
    absorbed: absorbedRows.map((r) => ({
      id: r.retiredId,
      registryRef: r.retiredRef,
      mergedAt: r.mergedAt.toISOString(),
    })),
  };
}

// Where does a possibly-retired animal id resolve? Used by deep links:
// a retired uuid resolves to the canonical survivor so old bookmarks and
// integration references land on the right profile.
export async function resolveAnimalMergeTarget(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ canonicalId: string; wasMerged: boolean } | null> {
  const [row] = await db
    .select({ id: animals.id })
    .from(animals)
    .where(eq(animals.id, animalId));
  if (!row) return null;
  const merge = await getAnimalMergeInfo(animalId, db);
  if (merge?.status === "merged" && merge.survivor) {
    return { canonicalId: merge.survivor.id, wasMerged: true };
  }
  return { canonicalId: animalId, wasMerged: false };
}
