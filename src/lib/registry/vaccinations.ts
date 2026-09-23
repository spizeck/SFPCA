// Vaccination domain service (#173). Like the other registry services,
// this is the only seam through which vaccination records are read or
// written — server actions call these functions; Drizzle never appears
// in UI code.
//
// Same invariants as the animal service: every mutation commits with
// its audit_events row in one transaction, updates are guarded by an
// expected updated_at (optimistic concurrency), and deletes of an
// animal with vaccination history fail loudly (restrictive FK) rather
// than erasing medical history.
//
// Reminder integration: this module does NOT send anything and cannot
// claim that it did. It exposes the due/overdue query (#172 evaluates
// it on a schedule), a deterministic idempotency-key helper, and
// queueVaccinationReminder(), which registers a reminder as queued or
// skipped — never sent. Only #172's delivery path may transition a
// queued row to sent/failed and stamp sent_at.
// follow_ups is deliberately NOT materialized from vaccination dates —
// due state is derived, so there is no second copy to go stale. Manual
// rechecks from encounters stay on follow_ups (#175).

import "server-only";

import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  communications,
  households,
  ownerships,
  persons,
  vaccinations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  effectiveVaccinationDate,
  isIsoDateString,
  todayIsoDate,
  vaccinationDueState,
  type VaccinationDueState,
} from "../vaccinations";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VET_DOC_PATH_RE = /^vet-docs\/[0-9a-f-]{36}(\.[a-z0-9]+)?$/i;

const MAX_SHORT = 200;
const MAX_NOTES = 2000;

export interface AdminVaccination {
  id: string;
  animalId: string;
  vaccineName: string;
  // DB-generated series identity (normalized vaccine_name). Doses
  // sharing an (animalId, seriesKey) are one vaccine series — the
  // latest dose alone drives due/reminder state.
  seriesKey: string;
  administeredOn: string;
  dueOn: string | null;
  validUntil: string | null;
  productName: string | null;
  manufacturer: string | null;
  lotNumber: string | null;
  administeredBy: string | null;
  notes: string | null;
  documentPath: string | null;
  createdAt: string;
  updatedAt: string;
}

const VACCINATION_COLUMNS = {
  id: vaccinations.id,
  animalId: vaccinations.animalId,
  vaccineName: vaccinations.vaccineName,
  seriesKey: vaccinations.seriesKey,
  administeredOn: vaccinations.administeredOn,
  dueOn: vaccinations.dueOn,
  validUntil: vaccinations.validUntil,
  productName: vaccinations.productName,
  manufacturer: vaccinations.manufacturer,
  lotNumber: vaccinations.lotNumber,
  administeredBy: vaccinations.administeredBy,
  notes: vaccinations.notes,
  documentPath: vaccinations.documentPath,
  createdAt: vaccinations.createdAt,
  updatedAt: vaccinations.updatedAt,
} as const;

type VaccinationRow = typeof vaccinations.$inferSelect;

function toVaccinationDto(row: VaccinationRow): AdminVaccination {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface VaccinationWriteInput {
  // Write-once: a vaccination belongs to the animal it was recorded
  // for. Updates never move a record between animals — correcting a
  // misfiled record means fixing it, not reassigning history.
  animalId: string;
  vaccineName: string;
  administeredOn: string;
  dueOn?: string | null;
  validUntil?: string | null;
  productName?: string | null;
  manufacturer?: string | null;
  lotNumber?: string | null;
  administeredBy?: string | null;
  notes?: string | null;
  documentPath?: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

// Structural validation shared by create/update. Returns the offending
// field name so the caller can surface a clean 400-level failure instead
// of a constraint-violation error — the DB CHECKs mirror the date rules.
export function validateVaccinationInput(
  input: VaccinationWriteInput,
  today: string = todayIsoDate(),
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  if (
    typeof input.vaccineName !== "string" ||
    !input.vaccineName.trim() ||
    input.vaccineName.length > MAX_SHORT
  ) {
    return "vaccineName";
  }
  // The generated series_key strips non-alphanumerics — a name with
  // none would collapse every such row into one empty-key series.
  if (!/[a-z0-9]/i.test(input.vaccineName)) return "vaccineName";
  if (!isIsoDateString(input.administeredOn)) return "administeredOn";
  // A dose dated in the future is almost certainly a typo (wrong year);
  // vaccinations record what WAS administered, not schedules.
  if (input.administeredOn > today) return "administeredOn";

  const dueOn = clean(input.dueOn);
  if (dueOn !== null) {
    if (!isIsoDateString(dueOn) || dueOn < input.administeredOn) {
      return "dueOn";
    }
  }
  const validUntil = clean(input.validUntil);
  if (validUntil !== null) {
    if (!isIsoDateString(validUntil) || validUntil < input.administeredOn) {
      return "validUntil";
    }
  }

  for (const [field, value] of [
    ["productName", input.productName],
    ["manufacturer", input.manufacturer],
    ["lotNumber", input.lotNumber],
    ["administeredBy", input.administeredBy],
  ] as const) {
    if (value != null && value.length > MAX_SHORT) return field;
  }
  if (input.notes != null && input.notes.length > MAX_NOTES) return "notes";

  const documentPath = clean(input.documentPath);
  if (documentPath !== null && !VET_DOC_PATH_RE.test(documentPath)) {
    return "documentPath";
  }
  return null;
}

function writeValues(input: VaccinationWriteInput) {
  return {
    animalId: input.animalId,
    vaccineName: input.vaccineName.trim(),
    administeredOn: input.administeredOn,
    dueOn: clean(input.dueOn),
    validUntil: clean(input.validUntil),
    productName: clean(input.productName),
    manufacturer: clean(input.manufacturer),
    lotNumber: clean(input.lotNumber),
    administeredBy: clean(input.administeredBy),
    notes: clean(input.notes),
    documentPath: clean(input.documentPath),
  };
}

// Vaccination history for one animal, most recent first — a vet opening
// the record sees the current state of each vaccine series immediately.
export async function listVaccinationsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminVaccination[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(VACCINATION_COLUMNS)
    .from(vaccinations)
    .where(eq(vaccinations.animalId, animalId))
    .orderBy(desc(vaccinations.administeredOn), desc(vaccinations.createdAt));
  return rows.map(toVaccinationDto);
}

export type VaccinationMutationResult =
  | { ok: true; vaccination: AdminVaccination }
  // `field` names the offending input so callers can show field-level
  // errors instead of a generic failure.
  | {
      ok: false;
      reason: "not-found" | "conflict" | "invalid";
      field?: string;
    };

export async function createVaccination(
  input: VaccinationWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<VaccinationMutationResult> {
  const invalidField = validateVaccinationInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }

  return db.transaction(async (tx) => {
    // A clean not-found beats an FK violation for a typo'd/deleted
    // animal — the FK is still the backstop for races.
    const [animal] = await tx
      .select({ id: animals.id })
      .from(animals)
      .where(eq(animals.id, input.animalId));
    if (!animal) return { ok: false as const, reason: "not-found" as const };

    const [row] = await tx
      .insert(vaccinations)
      .values(writeValues(input))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "vaccination",
      entityId: row.id,
      action: "create",
      after: toVaccinationDto(row),
    });
    return { ok: true, vaccination: toVaccinationDto(row) };
  });
}

// Optimistic concurrency identical to updateAnimal: the caller passes
// the updatedAt it rendered, and a stale write surfaces as "conflict".
export async function updateVaccination(
  id: string,
  input: VaccinationWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<VaccinationMutationResult> {
  const invalidField = validateVaccinationInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  const expectedMs = new Date(expectedUpdatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(VACCINATION_COLUMNS)
      .from(vaccinations)
      .where(eq(vaccinations.id, id))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.updatedAt.getTime() !== expectedMs) {
      return { ok: false as const, reason: "conflict" as const };
    }

    // animalId is write-once — spread excludes it from the update set.
    const { animalId: _ignored, ...fields } = writeValues(input);
    const [row] = await tx
      .update(vaccinations)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(vaccinations.id, id))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "vaccination",
      entityId: id,
      action: "update",
      before: toVaccinationDto(before),
      after: toVaccinationDto(row),
    });
    return { ok: true, vaccination: toVaccinationDto(row) };
  });
}

// --- Due/overdue query + reminder foundation (#172 consumes these) ----------

export interface DueVaccinationRow {
  // The CURRENT dose of a vaccine series — the latest administered_on
  // per (animal, series_key). Superseded historical doses never appear
  // here; they remain in listVaccinationsForAnimal() history.
  vaccination: AdminVaccination;
  // Earliest of due_on/valid_until — the date that needs attention.
  effectiveDate: string;
  state: VaccinationDueState;
  animal: {
    id: string;
    name: string;
    species: string;
    lifecycleStatus: string;
  };
  // The ownership valid at `asOf` — context for whoever consumes the
  // queue, NOT a chosen reminder recipient. A person row carries the
  // contact details a sender would need; a household row carries only
  // its name (no rule defines a household contact). Recipient
  // selection, opt-outs, and channel choice are #172's job.
  currentOwner: {
    id: string;
    kind: "person" | "household";
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  // How many 'vaccination-reminder' communications reached status
  // 'sent' for this vaccination — i.e. the count of GENUINE deliveries
  // recorded by #172's send path, not queued rows. This module never
  // produces a 'sent' row itself.
  remindersSent: number;
}

// "Which animals have vaccinations due soon or overdue?" — the query
// #172's scheduler and #175's work queue build on. Two projections
// keep it honest:
//  - latest dose per (animal, series): historical doses are superseded
//    for reminder purposes but stay in the medical record;
//  - one owner per animal at asOf: inconsistent data with multiple
//    simultaneously-valid ownerships yields ONE deterministic pick
//    (person over household, then earliest valid_from), never a
//    duplicate queue row. True multi-owner semantics are #178.
// Rows with no due/expiry date can never be due and are excluded.
export async function listDueVaccinations(
  {
    asOf = todayIsoDate(),
    withinDays = 30,
  }: { asOf?: string; withinDays?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<DueVaccinationRow[]> {
  // A malformed asOf is a caller bug — fail loudly rather than silently
  // reporting "nothing due" to a scheduler.
  if (!isIsoDateString(asOf)) {
    throw new Error("listDueVaccinations: asOf must be YYYY-MM-DD");
  }
  const horizon = new Date(`${asOf}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + withinDays);
  const horizonIso = horizon.toISOString().slice(0, 10);

  // Latest dose per vaccine series: DISTINCT ON picks the first row of
  // each (animal_id, series_key) group under this ordering — the most
  // recently administered dose wins.
  const latestDoses = db
    .selectDistinctOn(
      [vaccinations.animalId, vaccinations.seriesKey],
      { ...VACCINATION_COLUMNS },
    )
    .from(vaccinations)
    .orderBy(
      vaccinations.animalId,
      vaccinations.seriesKey,
      desc(vaccinations.administeredOn),
      desc(vaccinations.createdAt),
      desc(vaccinations.id),
    )
    .as("latest_doses");

  // Ownership valid at asOf: [valid_from, valid_to) — an open-ended
  // valid_to is "still current". DISTINCT ON guarantees at most one
  // owner per animal even if bad data leaves two rows valid at once.
  const currentOwnership = db
    .selectDistinctOn([ownerships.animalId], {
      animalId: ownerships.animalId,
      personId: ownerships.personId,
      householdId: ownerships.householdId,
    })
    .from(ownerships)
    .where(
      and(
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .orderBy(
      ownerships.animalId,
      // Deterministic pick under inconsistent data: a person beats a
      // household (person rows carry contact details), then earliest
      // valid_from, then id as a stable tiebreak.
      asc(sql`(${ownerships.personId} IS NULL)`),
      asc(ownerships.validFrom),
      asc(ownerships.id),
    )
    .as("current_ownership");

  const sent = db
    .select({
      relatedId: communications.relatedId,
      count: sql<number>`count(*)::int`.as("sent_count"),
    })
    .from(communications)
    .where(
      and(
        eq(communications.relatedType, "vaccination"),
        eq(communications.kind, "vaccination-reminder"),
        eq(communications.status, "sent"),
      ),
    )
    .groupBy(communications.relatedId)
    .as("vax_reminders_sent");

  // Postgres LEAST ignores NULL arguments — the earliest non-null of
  // the two dates, NULL only when both are unset.
  const effective = sql<string>`LEAST(${latestDoses.dueOn}, ${latestDoses.validUntil})`;

  const rows = await db
    .select({
      id: latestDoses.id,
      animalId: latestDoses.animalId,
      vaccineName: latestDoses.vaccineName,
      seriesKey: latestDoses.seriesKey,
      administeredOn: latestDoses.administeredOn,
      dueOn: latestDoses.dueOn,
      validUntil: latestDoses.validUntil,
      productName: latestDoses.productName,
      manufacturer: latestDoses.manufacturer,
      lotNumber: latestDoses.lotNumber,
      administeredBy: latestDoses.administeredBy,
      notes: latestDoses.notes,
      documentPath: latestDoses.documentPath,
      createdAt: latestDoses.createdAt,
      updatedAt: latestDoses.updatedAt,
      animalName: animals.name,
      animalSpecies: animals.species,
      animalLifecycleStatus: animals.lifecycleStatus,
      ownerPersonId: persons.id,
      ownerPersonName: persons.fullName,
      ownerEmail: persons.email,
      ownerPhone: persons.phone,
      ownerHouseholdId: households.id,
      ownerHouseholdName: households.name,
      remindersSent: sent.count,
      effectiveDate: effective,
    })
    .from(latestDoses)
    .innerJoin(animals, eq(latestDoses.animalId, animals.id))
    .leftJoin(
      currentOwnership,
      eq(currentOwnership.animalId, latestDoses.animalId),
    )
    .leftJoin(persons, eq(currentOwnership.personId, persons.id))
    .leftJoin(households, eq(currentOwnership.householdId, households.id))
    // communications.related_id is text (a loose cross-entity ref) —
    // cast the uuid for the comparison.
    .leftJoin(sent, sql`${sent.relatedId} = ${latestDoses.id}::text`)
    .where(sql`${effective} <= ${horizonIso}`)
    .orderBy(effective, latestDoses.id);

  return rows.map((row) => {
    const {
      animalName,
      animalSpecies,
      animalLifecycleStatus,
      ownerPersonId,
      ownerPersonName,
      ownerEmail,
      ownerPhone,
      ownerHouseholdId,
      ownerHouseholdName,
      remindersSent,
      effectiveDate,
      ...vax
    } = row;
    return {
      vaccination: toVaccinationDto(vax as VaccinationRow),
      effectiveDate,
      state: vaccinationDueState(effectiveDate, asOf),
      animal: {
        id: vax.animalId,
        name: animalName,
        species: animalSpecies,
        lifecycleStatus: animalLifecycleStatus,
      },
      currentOwner: ownerPersonId
        ? {
            id: ownerPersonId,
            kind: "person" as const,
            name: ownerPersonName!,
            email: ownerEmail,
            phone: ownerPhone,
          }
        : ownerHouseholdId
          ? {
              id: ownerHouseholdId,
              kind: "household" as const,
              name: ownerHouseholdName!,
              email: null,
              phone: null,
            }
          : null,
      remindersSent: Number(remindersSent ?? 0),
    };
  });
}

export const VACCINATION_REMINDER_KIND = "vaccination-reminder";

// Deterministic idempotency key: one reminder per (vaccination,
// effective due date, touch). #172 chooses the touch vocabulary
// ("due-30d", "due-7d", "overdue", ...) — this foundation only needs
// uniqueness to be deterministic so a retry can never write two rows.
export function vaccinationReminderKey(
  vaccinationId: string,
  effectiveDate: string,
  touch: string,
): string {
  return `vax-reminder:${vaccinationId}:${effectiveDate}:${touch}`;
}

export type QueueReminderResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: "invalid" | "not-found" };

// Registers a vaccination reminder in the communications ledger as
// 'queued' (awaiting #172's delivery) or 'skipped' (decided not to
// send — opt-out, suppressed, etc.). It CANNOT write 'sent'/'failed'
// or stamp sent_at: nothing in #173 delivers mail, so a row that
// claimed delivery would make communication history — and the
// idempotency state it feeds — lie. #172's delivery path owns the
// queued → sent/failed transition and sent_at.
//
// Idempotent by construction: the deterministic key means a repeat
// call for the same (vaccination, due date, touch) is a no-op
// returning duplicate:true, never a second row — so #172's scheduler
// can re-evaluate the due query freely without leaking duplicates.
export async function queueVaccinationReminder(
  input: {
    vaccinationId: string;
    personId: string;
    channel: "email" | "sms" | "whatsapp" | "phone";
    touch: string;
    status?: "queued" | "skipped";
  },
  db: RegistryDb = getRegistryDb(),
): Promise<QueueReminderResult> {
  if (!UUID_RE.test(input.vaccinationId) || !UUID_RE.test(input.personId)) {
    return { ok: false, reason: "invalid" };
  }
  const touch = input.touch?.trim();
  if (!touch || touch.length > 40) return { ok: false, reason: "invalid" };
  if (
    !["email", "sms", "whatsapp", "phone"].includes(input.channel) ||
    (input.status !== undefined &&
      !["queued", "skipped"].includes(input.status))
  ) {
    return { ok: false, reason: "invalid" };
  }

  const [vax] = await db
    .select({ dueOn: vaccinations.dueOn, validUntil: vaccinations.validUntil })
    .from(vaccinations)
    .where(eq(vaccinations.id, input.vaccinationId));
  if (!vax) return { ok: false, reason: "not-found" };

  const effective = effectiveVaccinationDate(vax.dueOn, vax.validUntil);
  if (!effective) return { ok: false, reason: "invalid" };

  try {
    const inserted = await db
      .insert(communications)
      .values({
        personId: input.personId,
        channel: input.channel,
        kind: VACCINATION_REMINDER_KIND,
        status: input.status ?? "queued",
        idempotencyKey: vaccinationReminderKey(
          input.vaccinationId,
          effective,
          touch,
        ),
        relatedType: "vaccination",
        relatedId: input.vaccinationId,
        // No sent_at: registration is not delivery. #172 stamps it
        // when a provider confirms the message actually went out.
        sentAt: null,
      })
      .onConflictDoNothing({ target: communications.idempotencyKey })
      .returning();
    return { ok: true, duplicate: inserted.length === 0 };
  } catch (error) {
    // FK violation on person_id → the recipient is gone.
    const code =
      (error as { code?: unknown })?.code ??
      (error as { cause?: { code?: unknown } })?.cause?.code;
    if (code === "23503") return { ok: false, reason: "not-found" };
    throw error;
  }
}
