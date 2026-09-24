// Veterinary continuity domain service (#174) — the only seam through
// which encounters, procedures, medications, medical alerts, weight
// records, and clinical document references are read or written.
// Server actions call these functions; Drizzle never appears in UI code.
//
// Same invariants as the vaccination service: every mutation commits
// with its audit_events row in one transaction, updates are guarded by
// an expected updated_at (optimistic concurrency), and deletes of an
// animal with medical history fail loudly (restrictive FKs) rather
// than erasing clinical records.
//
// Provider attribution is free text everywhere (provider,
// prescribed_by, administered_by on vaccinations): rotating/visiting
// vets are not registry persons, and historical attribution must
// survive any staff member's loss of application access.
//
// #175 seam: encounters can schedule a recheck by writing a follow_ups
// row (kind 'recheck', encounter_id link, owner snapshot) inside the
// encounter transaction. follow_ups stays the single due-date queue —
// this module never builds a parallel reminder system.
import "server-only";

import { and, asc, desc, eq, isNull, or, gt, lte } from "drizzle-orm";
import {
  animals,
  auditEvents,
  followUps,
  medicalAlerts,
  ownerships,
  vetEncounters,
  vetMedications,
  vetProcedures,
  weightRecords,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  ENCOUNTER_KINDS,
  MAX_WEIGHT_GRAMS,
  PROCEDURE_KINDS,
  RECHECK_FOLLOW_UP_KIND,
  compareTimelineItems,
  isPastOrTodayIsoDate,
} from "../medical";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import { listVaccinationsForAnimal } from "./vaccinations";
import type { AdminVaccination } from "./vaccinations";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SHORT = 200;
const MAX_TEXT = 2000;

// --- DTOs -------------------------------------------------------------------

export interface AdminVetEncounter {
  id: string;
  animalId: string;
  kind: string;
  occurredOn: string;
  provider: string | null;
  reason: string | null;
  complaint: string | null;
  findings: string | null;
  assessment: string | null;
  plan: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminVetProcedure {
  id: string;
  animalId: string;
  encounterId: string | null;
  kind: string;
  performedOn: string | null;
  provider: string | null;
  description: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminVetMedication {
  id: string;
  animalId: string;
  encounterId: string | null;
  medication: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  startOn: string;
  endOn: string | null;
  instructions: string | null;
  prescribedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMedicalAlert {
  id: string;
  animalId: string;
  encounterId: string | null;
  kind: string;
  severity: string;
  summary: string;
  details: string | null;
  status: string;
  recordedOn: string;
  resolvedOn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWeightRecord {
  id: string;
  animalId: string;
  encounterId: string | null;
  measuredOn: string;
  weightGrams: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminFollowUp {
  id: string;
  animalId: string | null;
  personId: string | null;
  encounterId: string | null;
  kind: string;
  dueOn: string;
  status: string;
  notes: string | null;
  createdAt: string;
}

type AnyRow = { createdAt: Date; updatedAt: Date };

// A transaction is structurally the query API — helpers accept the
// minimal surface they use so both db and tx satisfy it.
type Queryable = Pick<RegistryDb, "select">;
type Tx = Pick<RegistryDb, "select" | "insert" | "update">;

const iso = (r: AnyRow) => ({
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

function encounterDto(row: typeof vetEncounters.$inferSelect): AdminVetEncounter {
  return { ...row, ...iso(row) };
}
function procedureDto(row: typeof vetProcedures.$inferSelect): AdminVetProcedure {
  return { ...row, ...iso(row) };
}
function medicationDto(
  row: typeof vetMedications.$inferSelect,
): AdminVetMedication {
  return { ...row, ...iso(row) };
}
function alertDto(row: typeof medicalAlerts.$inferSelect): AdminMedicalAlert {
  return { ...row, ...iso(row) };
}
function weightDto(row: typeof weightRecords.$inferSelect): AdminWeightRecord {
  return { ...row, ...iso(row) };
}

// --- Inputs -----------------------------------------------------------------

export interface EncounterWriteInput {
  animalId: string;
  kind: string;
  occurredOn: string;
  provider?: string | null;
  reason?: string | null;
  complaint?: string | null;
  findings?: string | null;
  assessment?: string | null;
  plan?: string | null;
  notes?: string | null;
  // Convenience on create only: weight measured at this visit. Creates
  // a weight_records row linked to the encounter in the same tx.
  weightGrams?: number | null;
  // Convenience on create only: schedule a recheck — writes a
  // follow_ups row (kind 'recheck') linked to the new encounter.
  followUp?: { dueOn: string; reason: string } | null;
}

export interface ProcedureWriteInput {
  animalId: string;
  encounterId?: string | null;
  kind: string;
  performedOn?: string | null;
  provider?: string | null;
  description: string;
  notes?: string | null;
}

export interface MedicationWriteInput {
  animalId: string;
  encounterId?: string | null;
  medication: string;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  startOn: string;
  endOn?: string | null;
  instructions?: string | null;
  prescribedBy?: string | null;
  notes?: string | null;
}

export interface AlertWriteInput {
  animalId: string;
  encounterId?: string | null;
  kind: string;
  severity: string;
  summary: string;
  details?: string | null;
  recordedOn: string;
  status: string;
  resolvedOn?: string | null;
}

export interface WeightWriteInput {
  animalId: string;
  encounterId?: string | null;
  measuredOn: string;
  weightGrams: number;
  notes?: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;
const shortOk = (v: string | null | undefined) =>
  v == null || v.length <= MAX_SHORT;
const textOk = (v: string | null | undefined) =>
  v == null || v.length <= MAX_TEXT;

// --- Validation ---------------------------------------------------------------

export function validateEncounterInput(
  input: EncounterWriteInput,
  today: string = todayIsoDate(),
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (!(ENCOUNTER_KINDS as readonly string[]).includes(input.kind)) {
    return "kind";
  }
  if (!isPastOrTodayIsoDate(input.occurredOn, today)) return "occurredOn";
  // A visit with no recorded reason is useless for continuity.
  if (input.kind === "visit" && !clean(input.reason)) return "reason";
  for (const [field, value] of [
    ["provider", input.provider],
    ["reason", input.reason],
  ] as const) {
    if (!shortOk(value)) return field;
  }
  for (const [field, value] of [
    ["complaint", input.complaint],
    ["findings", input.findings],
    ["assessment", input.assessment],
    ["plan", input.plan],
    ["notes", input.notes],
  ] as const) {
    if (!textOk(value)) return field;
  }
  if (input.weightGrams != null) {
    if (
      !Number.isInteger(input.weightGrams) ||
      input.weightGrams <= 0 ||
      input.weightGrams > MAX_WEIGHT_GRAMS
    ) {
      return "weightGrams";
    }
  }
  if (input.followUp != null) {
    if (!isIsoDateString(input.followUp.dueOn)) return "followUpDueOn";
    if (!clean(input.followUp.reason) || input.followUp.reason.length > 500) {
      return "followUpReason";
    }
  }
  return null;
}

export function validateProcedureInput(
  input: ProcedureWriteInput,
  today: string = todayIsoDate(),
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (input.encounterId != null && !UUID_RE.test(input.encounterId)) {
    return "encounterId";
  }
  if (!(PROCEDURE_KINDS as readonly string[]).includes(input.kind)) {
    return "kind";
  }
  const performedOn = clean(input.performedOn);
  if (performedOn !== null && !isPastOrTodayIsoDate(performedOn, today)) {
    return "performedOn";
  }
  if (!clean(input.description)) return "description";
  if (!textOk(input.description)) return "description";
  if (!shortOk(input.provider)) return "provider";
  if (!textOk(input.notes)) return "notes";
  return null;
}

export function validateMedicationInput(
  input: MedicationWriteInput,
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (input.encounterId != null && !UUID_RE.test(input.encounterId)) {
    return "encounterId";
  }
  if (!clean(input.medication) || input.medication.length > MAX_SHORT) {
    return "medication";
  }
  // A future start date is legal — a vet may prescribe a course that
  // begins tomorrow.
  if (!isIsoDateString(input.startOn)) return "startOn";
  const endOn = clean(input.endOn);
  if (endOn !== null) {
    if (!isIsoDateString(endOn) || endOn < input.startOn) return "endOn";
  }
  for (const [field, value] of [
    ["dose", input.dose],
    ["route", input.route],
    ["frequency", input.frequency],
    ["prescribedBy", input.prescribedBy],
  ] as const) {
    if (!shortOk(value)) return field;
  }
  if (!textOk(input.instructions)) return "instructions";
  if (!textOk(input.notes)) return "notes";
  return null;
}

export function validateAlertInput(
  input: AlertWriteInput,
  today: string = todayIsoDate(),
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (input.encounterId != null && !UUID_RE.test(input.encounterId)) {
    return "encounterId";
  }
  if (!(ALERT_KINDS as readonly string[]).includes(input.kind)) return "kind";
  if (!(ALERT_SEVERITIES as readonly string[]).includes(input.severity)) {
    return "severity";
  }
  if (!clean(input.summary) || input.summary.length > MAX_SHORT) {
    return "summary";
  }
  if (!textOk(input.details)) return "details";
  if (!isPastOrTodayIsoDate(input.recordedOn, today)) return "recordedOn";
  if (input.status !== "active" && input.status !== "resolved") {
    return "status";
  }
  const resolvedOn = clean(input.resolvedOn);
  // Mirror the DB consistency CHECK: resolved_on set exactly when
  // status is 'resolved'.
  if (input.status === "resolved") {
    if (resolvedOn === null) return "resolvedOn";
    if (!isIsoDateString(resolvedOn) || resolvedOn < input.recordedOn) {
      return "resolvedOn";
    }
  } else if (resolvedOn !== null) {
    return "resolvedOn";
  }
  return null;
}

export function validateWeightInput(
  input: WeightWriteInput,
  today: string = todayIsoDate(),
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (input.encounterId != null && !UUID_RE.test(input.encounterId)) {
    return "encounterId";
  }
  if (!isPastOrTodayIsoDate(input.measuredOn, today)) return "measuredOn";
  if (
    !Number.isInteger(input.weightGrams) ||
    input.weightGrams <= 0 ||
    input.weightGrams > MAX_WEIGHT_GRAMS
  ) {
    return "weightGrams";
  }
  if (!textOk(input.notes)) return "notes";
  return null;
}

// --- Shared mutation plumbing --------------------------------------------------

export type MedicalMutationResult<T> =
  | { ok: true; record: T }
  | { ok: false; reason: "not-found" | "conflict" | "invalid"; field?: string };

async function animalExists(
  tx: Queryable,
  animalId: string,
): Promise<boolean> {
  const [animal] = await tx
    .select({ id: animals.id })
    .from(animals)
    .where(eq(animals.id, animalId));
  return !!animal;
}

// An encounter link is only valid if the encounter exists AND belongs
// to the same animal — cross-animal links would corrupt the record.
async function encounterBelongsTo(
  tx: Queryable,
  encounterId: string,
  animalId: string,
): Promise<boolean> {
  const [enc] = await tx
    .select({ animalId: vetEncounters.animalId })
    .from(vetEncounters)
    .where(eq(vetEncounters.id, encounterId));
  return !!enc && enc.animalId === animalId;
}

// The current owner's person id — snapshot for follow_ups so the queue
// knows who to reach without re-deriving ownership at send time.
async function currentOwnerPersonId(
  tx: Queryable,
  animalId: string,
  today: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ personId: ownerships.personId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.animalId, animalId),
        lte(ownerships.validFrom, today),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, today)),
      ),
    )
    .orderBy(asc(ownerships.validFrom), asc(ownerships.id))
    .limit(1);
  return row?.personId ?? null;
}

// Generic guarded update: row lock + expected updated_at + audit row,
// identical semantics to updateVaccination.
async function guardedUpdate<T extends { id: string } & AnyRow, R>(
  tx: Tx,
  opts: {
    id: string;
    expectedUpdatedAt: string;
    selectFrom: () => Promise<T | undefined>;
    applyUpdate: () => Promise<T | undefined>;
    entityType: string;
    toDto: (row: T) => R;
    actorLabel: string;
  },
): Promise<MedicalMutationResult<R>> {
  const expectedMs = new Date(opts.expectedUpdatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };

  const before = await opts.selectFrom();
  if (!before) return { ok: false, reason: "not-found" };
  if (before.updatedAt.getTime() !== expectedMs) {
    return { ok: false, reason: "conflict" };
  }
  const after = await opts.applyUpdate();
  if (!after) return { ok: false, reason: "not-found" };
  await tx.insert(auditEvents).values({
    actorLabel: opts.actorLabel,
    entityType: opts.entityType,
    entityId: opts.id,
    action: "update",
    before: opts.toDto(before),
    after: opts.toDto(after),
  });
  return { ok: true, record: opts.toDto(after) };
}

// --- Encounters ---------------------------------------------------------------

export async function createEncounter(
  input: EncounterWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetEncounter>> {
  const invalidField = validateEncounterInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    if (!(await animalExists(tx, input.animalId))) {
      return { ok: false as const, reason: "not-found" as const };
    }
    const [row] = await tx
      .insert(vetEncounters)
      .values({
        animalId: input.animalId,
        kind: input.kind,
        occurredOn: input.occurredOn,
        provider: clean(input.provider),
        reason: clean(input.reason),
        complaint: clean(input.complaint),
        findings: clean(input.findings),
        assessment: clean(input.assessment),
        plan: clean(input.plan),
        notes: clean(input.notes),
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "vet_encounter",
      entityId: row.id,
      action: "create",
      after: encounterDto(row),
    });

    // Optional same-visit weight — one audit row per record.
    if (input.weightGrams != null) {
      const [w] = await tx
        .insert(weightRecords)
        .values({
          animalId: input.animalId,
          encounterId: row.id,
          measuredOn: input.occurredOn,
          weightGrams: input.weightGrams,
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorLabel,
        entityType: "weight_record",
        entityId: w.id,
        action: "create",
        after: weightDto(w),
      });
    }

    // Optional recheck — the #175 seam. personId snapshots the owner
    // valid today so the queue doesn't re-derive ownership later.
    if (input.followUp != null) {
      const personId = await currentOwnerPersonId(
        tx,
        input.animalId,
        todayIsoDate(),
      );
      const [fu] = await tx
        .insert(followUps)
        .values({
          animalId: input.animalId,
          personId,
          encounterId: row.id,
          kind: RECHECK_FOLLOW_UP_KIND,
          dueOn: input.followUp.dueOn,
          notes: clean(input.followUp.reason),
        })
        .returning();
      await tx.insert(auditEvents).values({
        actorLabel,
        entityType: "follow_up",
        entityId: fu.id,
        action: "create",
        after: {
          ...fu,
          resolvedAt: fu.resolvedAt?.toISOString() ?? null,
          createdAt: fu.createdAt.toISOString(),
        },
      });
    }

    return { ok: true, record: encounterDto(row) };
  });
}

export async function updateEncounter(
  id: string,
  input: EncounterWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetEncounter>> {
  // weightGrams/followUp are create-only conveniences — editing those
  // records happens on the weight/follow-up row itself.
  const invalidField = validateEncounterInput({
    ...input,
    weightGrams: null,
    followUp: null,
  });
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction((tx) =>
    guardedUpdate(tx, {
      id,
      expectedUpdatedAt,
      actorLabel,
      entityType: "vet_encounter",
      toDto: encounterDto,
      selectFrom: async () =>
        (
          await tx
            .select()
            .from(vetEncounters)
            .where(eq(vetEncounters.id, id))
            .for("update")
        )[0],
      applyUpdate: async () =>
        (
          await tx
            .update(vetEncounters)
            .set({
              kind: input.kind,
              occurredOn: input.occurredOn,
              provider: clean(input.provider),
              reason: clean(input.reason),
              complaint: clean(input.complaint),
              findings: clean(input.findings),
              assessment: clean(input.assessment),
              plan: clean(input.plan),
              notes: clean(input.notes),
              updatedAt: new Date(),
            })
            .where(eq(vetEncounters.id, id))
            .returning()
        )[0],
    }),
  );
}

export async function listEncountersForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminVetEncounter[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select()
    .from(vetEncounters)
    .where(eq(vetEncounters.animalId, animalId))
    .orderBy(desc(vetEncounters.occurredOn), desc(vetEncounters.createdAt));
  return rows.map(encounterDto);
}

// --- Procedures -----------------------------------------------------------------

export async function createProcedure(
  input: ProcedureWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetProcedure>> {
  const invalidField = validateProcedureInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    if (!(await animalExists(tx, input.animalId))) {
      return { ok: false as const, reason: "not-found" as const };
    }
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    const [row] = await tx
      .insert(vetProcedures)
      .values({
        animalId: input.animalId,
        encounterId,
        kind: input.kind,
        performedOn: clean(input.performedOn),
        provider: clean(input.provider),
        description: clean(input.description)!,
        notes: clean(input.notes),
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "vet_procedure",
      entityId: row.id,
      action: "create",
      after: procedureDto(row),
    });
    return { ok: true, record: procedureDto(row) };
  });
}

export async function updateProcedure(
  id: string,
  input: ProcedureWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetProcedure>> {
  const invalidField = validateProcedureInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction(async (tx) => {
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    return guardedUpdate(tx, {
      id,
      expectedUpdatedAt,
      actorLabel,
      entityType: "vet_procedure",
      toDto: procedureDto,
      selectFrom: async () =>
        (
          await tx
            .select()
            .from(vetProcedures)
            .where(eq(vetProcedures.id, id))
            .for("update")
        )[0],
      applyUpdate: async () =>
        (
          await tx
            .update(vetProcedures)
            .set({
              encounterId,
              kind: input.kind,
              performedOn: clean(input.performedOn),
              provider: clean(input.provider),
              description: clean(input.description)!,
              notes: clean(input.notes),
              updatedAt: new Date(),
            })
            .where(eq(vetProcedures.id, id))
            .returning()
        )[0],
    });
  });
}

// --- Medications ----------------------------------------------------------------

export async function createMedication(
  input: MedicationWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetMedication>> {
  const invalidField = validateMedicationInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    if (!(await animalExists(tx, input.animalId))) {
      return { ok: false as const, reason: "not-found" as const };
    }
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    const [row] = await tx
      .insert(vetMedications)
      .values({
        animalId: input.animalId,
        encounterId,
        medication: clean(input.medication)!,
        dose: clean(input.dose),
        route: clean(input.route),
        frequency: clean(input.frequency),
        startOn: input.startOn,
        endOn: clean(input.endOn),
        instructions: clean(input.instructions),
        prescribedBy: clean(input.prescribedBy),
        notes: clean(input.notes),
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "vet_medication",
      entityId: row.id,
      action: "create",
      after: medicationDto(row),
    });
    return { ok: true, record: medicationDto(row) };
  });
}

export async function updateMedication(
  id: string,
  input: MedicationWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminVetMedication>> {
  const invalidField = validateMedicationInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction(async (tx) => {
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    return guardedUpdate(tx, {
      id,
      expectedUpdatedAt,
      actorLabel,
      entityType: "vet_medication",
      toDto: medicationDto,
      selectFrom: async () =>
        (
          await tx
            .select()
            .from(vetMedications)
            .where(eq(vetMedications.id, id))
            .for("update")
        )[0],
      applyUpdate: async () =>
        (
          await tx
            .update(vetMedications)
            .set({
              encounterId,
              medication: clean(input.medication)!,
              dose: clean(input.dose),
              route: clean(input.route),
              frequency: clean(input.frequency),
              startOn: input.startOn,
              endOn: clean(input.endOn),
              instructions: clean(input.instructions),
              prescribedBy: clean(input.prescribedBy),
              notes: clean(input.notes),
              updatedAt: new Date(),
            })
            .where(eq(vetMedications.id, id))
            .returning()
        )[0],
    });
  });
}

// --- Medical alerts ---------------------------------------------------------------

export async function createAlert(
  input: AlertWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminMedicalAlert>> {
  const invalidField = validateAlertInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    if (!(await animalExists(tx, input.animalId))) {
      return { ok: false as const, reason: "not-found" as const };
    }
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    const [row] = await tx
      .insert(medicalAlerts)
      .values({
        animalId: input.animalId,
        encounterId,
        kind: input.kind,
        severity: input.severity,
        summary: clean(input.summary)!,
        details: clean(input.details),
        status: input.status,
        recordedOn: input.recordedOn,
        resolvedOn: input.status === "resolved" ? clean(input.resolvedOn) : null,
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "medical_alert",
      entityId: row.id,
      action: "create",
      after: alertDto(row),
    });
    return { ok: true, record: alertDto(row) };
  });
}

export async function updateAlert(
  id: string,
  input: AlertWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminMedicalAlert>> {
  const invalidField = validateAlertInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction(async (tx) => {
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    return guardedUpdate(tx, {
      id,
      expectedUpdatedAt,
      actorLabel,
      entityType: "medical_alert",
      toDto: alertDto,
      selectFrom: async () =>
        (
          await tx
            .select()
            .from(medicalAlerts)
            .where(eq(medicalAlerts.id, id))
            .for("update")
        )[0],
      applyUpdate: async () =>
        (
          await tx
            .update(medicalAlerts)
            .set({
              encounterId,
              kind: input.kind,
              severity: input.severity,
              summary: clean(input.summary)!,
              details: clean(input.details),
              status: input.status,
              recordedOn: input.recordedOn,
              resolvedOn:
                input.status === "resolved" ? clean(input.resolvedOn) : null,
              updatedAt: new Date(),
            })
            .where(eq(medicalAlerts.id, id))
            .returning()
        )[0],
    });
  });
}

// --- Weight records ---------------------------------------------------------------

export async function createWeightRecord(
  input: WeightWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminWeightRecord>> {
  const invalidField = validateWeightInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    if (!(await animalExists(tx, input.animalId))) {
      return { ok: false as const, reason: "not-found" as const };
    }
    const encounterId = clean(input.encounterId);
    if (
      encounterId !== null &&
      !(await encounterBelongsTo(tx, encounterId, input.animalId))
    ) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        field: "encounterId",
      };
    }
    const [row] = await tx
      .insert(weightRecords)
      .values({
        animalId: input.animalId,
        encounterId,
        measuredOn: input.measuredOn,
        weightGrams: input.weightGrams,
        notes: clean(input.notes),
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "weight_record",
      entityId: row.id,
      action: "create",
      after: weightDto(row),
    });
    return { ok: true, record: weightDto(row) };
  });
}

export async function updateWeightRecord(
  id: string,
  input: WeightWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalMutationResult<AdminWeightRecord>> {
  const invalidField = validateWeightInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction((tx) =>
    guardedUpdate(tx, {
      id,
      expectedUpdatedAt,
      actorLabel,
      entityType: "weight_record",
      toDto: weightDto,
      selectFrom: async () =>
        (
          await tx
            .select()
            .from(weightRecords)
            .where(eq(weightRecords.id, id))
            .for("update")
        )[0],
      applyUpdate: async () =>
        (
          await tx
            .update(weightRecords)
            .set({
              measuredOn: input.measuredOn,
              weightGrams: input.weightGrams,
              notes: clean(input.notes),
              updatedAt: new Date(),
            })
            .where(eq(weightRecords.id, id))
            .returning()
        )[0],
    }),
  );
}

// --- Timeline + follow-ups ---------------------------------------------------------

// One timeline entry per clinical record. `date` is the ordering key —
// null only for procedures with an unknown performed_on (they sort
// last). The full DTO travels inside so the page can edit in place.
export type MedicalTimelineItem =
  | { kind: "encounter"; date: string; createdAt: string; record: AdminVetEncounter }
  | { kind: "vaccination"; date: string; createdAt: string; record: AdminVaccination }
  | { kind: "procedure"; date: string | null; createdAt: string; record: AdminVetProcedure }
  | { kind: "medication"; date: string; createdAt: string; record: AdminVetMedication }
  | { kind: "weight"; date: string; createdAt: string; record: AdminWeightRecord }
  | { kind: "alert"; date: string; createdAt: string; record: AdminMedicalAlert };

// The animal's full clinical timeline, newest first: encounters,
// vaccinations, procedures, medications, weights, and alert recordings
// in one chronological feed — the vet opens one screen and sees the
// medically important recent history.
export async function listMedicalTimeline(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MedicalTimelineItem[]> {
  if (!UUID_RE.test(animalId)) return [];

  const [encounters, vax, procedures, medications, alerts, weights] =
    await Promise.all([
      listEncountersForAnimal(animalId, db),
      listVaccinationsForAnimal(animalId, db),
      db
        .select()
        .from(vetProcedures)
        .where(eq(vetProcedures.animalId, animalId)),
      db
        .select()
        .from(vetMedications)
        .where(eq(vetMedications.animalId, animalId)),
      db
        .select()
        .from(medicalAlerts)
        .where(eq(medicalAlerts.animalId, animalId)),
      db
        .select()
        .from(weightRecords)
        .where(eq(weightRecords.animalId, animalId)),
    ]);

  const items: MedicalTimelineItem[] = [
    ...encounters.map(
      (r): MedicalTimelineItem => ({
        kind: "encounter",
        date: r.occurredOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
    ...vax.map(
      (r): MedicalTimelineItem => ({
        kind: "vaccination",
        date: r.administeredOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
    ...procedures.map(procedureDto).map(
      (r): MedicalTimelineItem => ({
        kind: "procedure",
        date: r.performedOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
    ...medications.map(medicationDto).map(
      (r): MedicalTimelineItem => ({
        kind: "medication",
        date: r.startOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
    ...alerts.map(alertDto).map(
      (r): MedicalTimelineItem => ({
        kind: "alert",
        date: r.recordedOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
    ...weights.map(weightDto).map(
      (r): MedicalTimelineItem => ({
        kind: "weight",
        date: r.measuredOn,
        createdAt: r.createdAt,
        record: r,
      }),
    ),
  ];

  items.sort(compareTimelineItems);
  return items;
}

// Open follow-ups for one animal, soonest due first — shown on the
// medical record so a recommended recheck can't hide inside a visit's
// plan text.
export async function listOpenFollowUps(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminFollowUp[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.animalId, animalId), eq(followUps.status, "open")))
    .orderBy(asc(followUps.dueOn), asc(followUps.id));
  return rows.map((r) => ({
    id: r.id,
    animalId: r.animalId,
    personId: r.personId,
    encounterId: r.encounterId,
    kind: r.kind,
    dueOn: r.dueOn,
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }));
}
