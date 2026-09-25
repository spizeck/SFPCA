// Admin-side animal registry domain service (#183, extended for #167).
// This is the only application seam through which staff reads/writes
// animal records — route handlers and server actions call these
// functions; Drizzle never appears in UI code.
//
// The animal row is the PERMANENT registry record: it exists
// independently of owner, registration, payment, vet visit, vaccination,
// or portal account, and is never deleted just because no current
// registration exists. Registry lifecycle (animals.lifecycle_status)
// changes ONLY through transitionAnimalLifecycle — every change lands in
// the same transaction as its animal_lifecycle_events history row and
// its audit_events row, so current state, history, and audit can never
// diverge. Adoption publication state (animals.adoption_status) is a
// separate staff-editable listing field.
//
// Callers supply the actor label from the verified session; audit rows
// carry non-sensitive field projections only.

import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  animalLifecycleEvents,
  animals,
  auditEvents,
  clinicExpectations,
  followUps,
  households,
  microchipRecords,
  ownerships,
  persons,
  registrations,
  vetDocuments,
  vetProcedures,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  ANIMAL_STERILIZATION_STATUSES,
  canTransitionAnimalLifecycle,
  isAnimalAdoptionStatus,
  isAnimalLifecycleStatus,
  OWNERSHIP_ENDING_STATUSES,
  type AnimalAdoptionStatus,
  type AnimalLifecycleStatus,
} from "../animal-lifecycle";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import { normalizeChipNumber } from "../microchips";
import {
  listChipConflicts,
  listMicrochipsForAnimal,
  type ChipConflictRecord,
  type MicrochipRecord,
} from "./microchips";
import {
  listCasesForAnimal,
  type LostFoundCaseRecord,
} from "./lost-found";
import {
  listRegistrationsForAnimal,
  type RegistrationRecord,
} from "./registrations";
import {
  listPaymentsForAnimal,
  listPaymentEvents,
  type PaymentEventRecord,
  type PaymentRecord,
} from "./payments";
import type { RegistryDb } from "./public-animals";

// Admin DTO — all animals columns are staff-safe (no owner data lives on
// an animal row), so the projection is the full row plus legacyId.
export interface AdminAnimal {
  id: string;
  legacyId: string | null;
  registryRef: string;
  name: string;
  species: string;
  sex: string;
  birthDate: string | null;
  birthDateEstimated: boolean;
  description: string | null;
  identifyingNotes: string | null;
  lifecycleStatus: string;
  lifecycleEffectiveOn: string | null;
  adoptionStatus: string;
  sterilizationStatus: string;
  sterilizedOn: string | null;
  sterilizedBy: string | null;
  photoUrls: string[];
  createdAt: string;
  updatedAt: string;
}

const ADMIN_COLUMNS = {
  id: animals.id,
  legacyId: animals.legacyId,
  registryRef: animals.registryRef,
  name: animals.name,
  species: animals.species,
  sex: animals.sex,
  birthDate: animals.birthDate,
  birthDateEstimated: animals.birthDateEstimated,
  description: animals.description,
  identifyingNotes: animals.identifyingNotes,
  lifecycleStatus: animals.lifecycleStatus,
  lifecycleEffectiveOn: animals.lifecycleEffectiveOn,
  adoptionStatus: animals.adoptionStatus,
  sterilizationStatus: animals.sterilizationStatus,
  sterilizedOn: animals.sterilizedOn,
  sterilizedBy: animals.sterilizedBy,
  photoUrls: animals.photoUrls,
  createdAt: animals.createdAt,
  updatedAt: animals.updatedAt,
} as const;

type AdminRow = typeof animals.$inferSelect;

function toAdminDto(row: AdminRow): AdminAnimal {
  return {
    ...row,
    photoUrls: row.photoUrls ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ANIMAL_SPECIES = ["dog", "cat", "other"] as const;
export const ANIMAL_SEXES = ["male", "female", "unknown"] as const;

// A photo URL must be a site-relative path or an absolute http(s) URL —
// anything else (javascript:, data:, arbitrary schemes) is rejected at
// write time rather than sanitized at every render.
const PHOTO_URL_RE = /^(\/|https:\/\/|http:\/\/)\S+$/;

export interface AnimalWriteInput {
  name: string;
  species: string;
  sex: string;
  birthDate?: string | null;
  birthDateEstimated?: boolean;
  description?: string | null;
  identifyingNotes?: string | null;
  adoptionStatus: string;
  sterilizationStatus?: string;
  sterilizedOn?: string | null;
  sterilizedBy?: string | null;
  photoUrls?: string[];
}

// Structural validation shared by create/update. The DB CHECK
// constraints mirror this, but catching it here turns bad input into a
// clean 400-level failure instead of a constraint-violation error.
export function validateAnimalInput(input: AnimalWriteInput): string | null {
  if (typeof input.name !== "string" || !input.name.trim()) return "name";
  if (!(ANIMAL_SPECIES as readonly string[]).includes(input.species))
    return "species";
  if (!(ANIMAL_SEXES as readonly string[]).includes(input.sex)) return "sex";
  if (!isAnimalAdoptionStatus(input.adoptionStatus)) return "adoptionStatus";
  if (
    input.birthDate != null &&
    input.birthDate !== "" &&
    !isIsoDateString(input.birthDate)
  ) {
    return "birthDate";
  }
  if (input.birthDateEstimated && !input.birthDate) {
    return "birthDateEstimated"; // an estimate needs a date to estimate
  }
  if (
    input.sterilizationStatus != null &&
    !(ANIMAL_STERILIZATION_STATUSES as readonly string[]).includes(
      input.sterilizationStatus,
    )
  ) {
    return "sterilizationStatus";
  }
  if (
    input.sterilizedOn != null &&
    input.sterilizedOn !== "" &&
    !isIsoDateString(input.sterilizedOn)
  ) {
    return "sterilizedOn";
  }
  if (
    (input.photoUrls ?? []).some((u) => typeof u !== "string" || !PHOTO_URL_RE.test(u))
  ) {
    return "photoUrls";
  }
  return null;
}

function writeValues(input: AnimalWriteInput) {
  const sterilizationStatus = input.sterilizationStatus ?? "unknown";
  // Sterilization details are meaningful only for 'sterilized' — storing
  // a spay date against 'intact'/'unknown' would be contradictory data.
  const sterilized = sterilizationStatus === "sterilized";
  return {
    name: input.name.trim(),
    species: input.species,
    sex: input.sex,
    birthDate: input.birthDate?.trim() || null,
    birthDateEstimated: input.birthDateEstimated === true,
    description: input.description?.trim() || null,
    identifyingNotes: input.identifyingNotes?.trim() || null,
    adoptionStatus: input.adoptionStatus as AnimalAdoptionStatus,
    sterilizationStatus,
    sterilizedOn: sterilized ? input.sterilizedOn?.trim() || null : null,
    sterilizedBy: sterilized ? input.sterilizedBy?.trim() || null : null,
    photoUrls: (input.photoUrls ?? []).map((u) => u.trim()).filter(Boolean),
  };
}

export async function listAdminAnimals(
  db: RegistryDb = getRegistryDb(),
): Promise<AdminAnimal[]> {
  const rows = await db
    .select(ADMIN_COLUMNS)
    .from(animals)
    .orderBy(asc(animals.createdAt), asc(animals.id));
  return rows.map(toAdminDto);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-animal lookup for the admin profile/medical-record page.
// A malformed id is a not-found, never a driver error.
export async function getAdminAnimal(
  id: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AdminAnimal | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select(ADMIN_COLUMNS)
    .from(animals)
    .where(eq(animals.id, id));
  return row ? toAdminDto(row) : null;
}

export type AnimalMutationResult =
  | { ok: true; animal: AdminAnimal }
  | { ok: false; reason: "not-found" | "conflict" | "invalid" };

// Creating an animal records its initial registry lifecycle as the first
// animal_lifecycle_events row (from_status NULL = "entered the
// registry"), so every animal's history starts with a documented entry
// rather than an unexplained current value.
export async function createAnimal(
  input: AnimalWriteInput & {
    lifecycleStatus?: string;
    lifecycleEffectiveOn?: string;
    lifecycleReason?: string;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  if (validateAnimalInput(input)) return { ok: false, reason: "invalid" };
  const lifecycleStatus = input.lifecycleStatus ?? "active";
  if (!isAnimalLifecycleStatus(lifecycleStatus)) {
    return { ok: false, reason: "invalid" };
  }
  const effectiveOn = input.lifecycleEffectiveOn ?? todayIsoDate();
  if (!isIsoDateString(effectiveOn)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(animals)
      .values({
        ...writeValues(input),
        lifecycleStatus,
        lifecycleEffectiveOn: effectiveOn,
      })
      .returning();
    await tx.insert(animalLifecycleEvents).values({
      animalId: row.id,
      fromStatus: null,
      toStatus: lifecycleStatus,
      effectiveOn,
      source: "staff",
      reason: input.lifecycleReason?.trim() || "Initial registry entry",
      actorLabel,
    });
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "animal",
      entityId: row.id,
      action: "create",
      after: toAdminDto(row),
    });
    return { ok: true, animal: toAdminDto(row) };
  });
}

// Optimistic concurrency: the caller passes the updatedAt it rendered.
// SELECT ... FOR UPDATE serializes concurrent updaters on the row lock,
// then the ms-epoch comparison rejects a write based on a stale view —
// a lost update surfaces as "conflict" instead of silently overwriting.
// (Comparing the column directly would be wrong: timestamptz stores
// microseconds while JS Date carries milliseconds only.)
export async function updateAnimal(
  id: string,
  input: AnimalWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  if (validateAnimalInput(input)) return { ok: false, reason: "invalid" };
  const expectedMs = new Date(expectedUpdatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(ADMIN_COLUMNS)
      .from(animals)
      .where(eq(animals.id, id))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.updatedAt.getTime() !== expectedMs) {
      return { ok: false as const, reason: "conflict" as const };
    }

    const [row] = await tx
      .update(animals)
      .set({ ...writeValues(input), updatedAt: new Date() })
      .where(eq(animals.id, id))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "animal",
      entityId: id,
      action: "update",
      before: toAdminDto(before),
      after: toAdminDto(row),
    });
    return { ok: true, animal: toAdminDto(row) };
  });
}

// Hard delete exists only for genuinely erroneous/test records — the
// permanent registry has no "remove because no longer current" path, and
// ownership/medical/microchip/registration references are restrictive
// FKs, so deleting a referenced animal fails loudly instead of orphaning
// history. The animal's own lifecycle events are part of the record
// being deleted (their content is preserved in the audit before-state);
// every OTHER domain's references still block. Merge-for-duplicates is
// #178, not this path.
export async function deleteAnimal(
  id: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  return db.transaction(async (tx) => {
    await tx
      .delete(animalLifecycleEvents)
      .where(eq(animalLifecycleEvents.animalId, id));
    const [row] = await tx
      .delete(animals)
      .where(eq(animals.id, id))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "animal",
      entityId: id,
      action: "delete",
      before: toAdminDto(row),
    });
    return { ok: true, animal: toAdminDto(row) };
  });
}

// --- Lifecycle --------------------------------------------------------

export type LifecycleEventSource = "staff" | "owner-request" | "import";

export interface LifecycleTransitionInput {
  toStatus: string;
  // Real-world date the new state became effective — defaults to today.
  effectiveOn?: string;
  reason?: string | null;
  source: LifecycleEventSource;
  // For 'owner-request' transitions: the owner_requests.id.
  sourceRef?: string | null;
  actorIdentityId?: string | null;
  actorLabel: string;
}

export interface AnimalLifecycleEventDto {
  id: string;
  animalId: string;
  fromStatus: string | null;
  toStatus: string;
  effectiveOn: string;
  source: string;
  sourceRef: string | null;
  reason: string | null;
  actorLabel: string | null;
  createdAt: string;
}

// The ONE write path for animals.lifecycle_status. Everything a
// transition implies lands in this transaction:
//   - current state + effective date on the animal row;
//   - the lifecycle-history event (immutable domain history);
//   - for ownership-ending states (deceased, moved-off-saba): every
//     currently-open ownership interval closes at the effective date —
//     a deceased or off-island animal has no on-island owner of record.
//     Co-ownership is not an exception: the staff-approved whole-animal
//     fact applies to the animal, and each closed interval is preserved
//     as history, not deleted;
//   - open follow-ups and expected-clinic rows cancel (dead/off-island
//     animals have no pending clinical work);
//   - the audit_events row.
// Same-state "transitions" and unknown values are rejected.
export async function transitionAnimalLifecycle(
  animalId: string,
  input: LifecycleTransitionInput,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  if (!UUID_RE.test(animalId)) return { ok: false, reason: "not-found" };
  if (!isAnimalLifecycleStatus(input.toStatus)) {
    return { ok: false, reason: "invalid" };
  }
  const effectiveOn = input.effectiveOn ?? todayIsoDate();
  if (!isIsoDateString(effectiveOn)) return { ok: false, reason: "invalid" };
  const toStatus = input.toStatus;

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(ADMIN_COLUMNS)
      .from(animals)
      .where(eq(animals.id, animalId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (!canTransitionAnimalLifecycle(before.lifecycleStatus, toStatus)) {
      return { ok: false as const, reason: "invalid" as const };
    }

    const [row] = await tx
      .update(animals)
      .set({
        lifecycleStatus: toStatus,
        lifecycleEffectiveOn: effectiveOn,
        updatedAt: new Date(),
      })
      .where(eq(animals.id, animalId))
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };

    if (OWNERSHIP_ENDING_STATUSES.includes(toStatus)) {
      // Close every open interval at the effective date. An interval
      // recorded as starting after the effective date is bad data —
      // GREATEST keeps the range CHECK satisfied while still closing it.
      await tx
        .update(ownerships)
        .set({
          validTo: sql`GREATEST(${effectiveOn}::date, ${ownerships.validFrom} + 1)`,
        })
        .where(
          and(eq(ownerships.animalId, animalId), isNull(ownerships.validTo)),
        );
      await tx
        .update(followUps)
        .set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(followUps.animalId, animalId), eq(followUps.status, "open")),
        );
      await tx
        .update(clinicExpectations)
        .set({
          status: "cancelled",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clinicExpectations.animalId, animalId),
            eq(clinicExpectations.status, "expected"),
          ),
        );
    }

    await tx.insert(animalLifecycleEvents).values({
      animalId,
      fromStatus: before.lifecycleStatus,
      toStatus,
      effectiveOn,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      reason: input.reason?.trim() || null,
      actorIdentityId: input.actorIdentityId ?? null,
      actorLabel: input.actorLabel,
    });
    await tx.insert(auditEvents).values({
      actorLabel: input.actorLabel,
      entityType: "animal",
      entityId: animalId,
      action: "lifecycle-transition",
      before: { lifecycleStatus: before.lifecycleStatus },
      after: {
        lifecycleStatus: toStatus,
        lifecycleEffectiveOn: effectiveOn,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
      },
    });
    return { ok: true, animal: toAdminDto(row) };
  });
}

// Lifecycle history for the profile — newest first. Domain history, not
// audit prose: structured from/to/effective/source per row.
export async function listLifecycleHistory(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalLifecycleEventDto[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select()
    .from(animalLifecycleEvents)
    .where(eq(animalLifecycleEvents.animalId, animalId))
    .orderBy(
      desc(animalLifecycleEvents.effectiveOn),
      desc(animalLifecycleEvents.createdAt),
    );
  return rows.map((r) => ({
    id: r.id,
    animalId: r.animalId,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    effectiveOn: r.effectiveOn,
    source: r.source,
    sourceRef: r.sourceRef,
    reason: r.reason,
    actorLabel: r.actorLabel,
    createdAt: r.createdAt.toISOString(),
  }));
}

// --- Sterilization projection -------------------------------------------

// vet_procedures spay/neuter rows are the authoritative EVIDENCE for the
// sterilization fact carried on animals.sterilization_status (asserted by
// staff for historical animals, or derived when a procedure is recorded
// — see recordProcedureSterilization in registry/medical.ts). The
// projection exposes both so the profile shows the fact and its evidence
// without treating either as the other's duplicate.
export interface AnimalSterilization {
  status: string;
  sterilizedOn: string | null;
  sterilizedBy: string | null;
  evidence: {
    id: string;
    kind: string;
    performedOn: string | null;
    provider: string | null;
    description: string;
  }[];
}

export async function getAnimalSterilization(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalSterilization | null> {
  const animal = await getAdminAnimal(animalId, db);
  if (!animal) return null;
  const evidence = await db
    .select({
      id: vetProcedures.id,
      kind: vetProcedures.kind,
      performedOn: vetProcedures.performedOn,
      provider: vetProcedures.provider,
      description: vetProcedures.description,
    })
    .from(vetProcedures)
    .where(
      and(
        eq(vetProcedures.animalId, animalId),
        inArray(vetProcedures.kind, ["spay", "neuter"]),
      ),
    )
    .orderBy(desc(vetProcedures.performedOn));
  return {
    status: animal.sterilizationStatus,
    sterilizedOn: animal.sterilizedOn,
    sterilizedBy: animal.sterilizedBy,
    evidence,
  };
}

// --- Staff search -----------------------------------------------------

export interface AnimalSearchFilters {
  lifecycleStatus?: string;
  adoptionStatus?: string;
}

export interface AnimalSearchHit {
  animal: AdminAnimal;
  // Current owner display labels (person full names / household names).
  owners: string[];
  // Active microchip numbers.
  microchips: string[];
}

const SEARCH_LIMIT = 50;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Registry-oriented staff search: one text box that matches name,
// registry ref, exact uuid, legacy id, identifying notes, any
// current-or-past owner/household name, and normalized microchip
// number — plus lifecycle/adoption filters. Bounded at SEARCH_LIMIT;
// results carry current-owner labels and active chips so staff can pick
// the right record without opening each profile.
export async function searchAnimals(
  query: string,
  filters: AnimalSearchFilters = {},
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalSearchHit[]> {
  const conditions: SQL[] = [];
  if (
    filters.lifecycleStatus &&
    isAnimalLifecycleStatus(filters.lifecycleStatus)
  ) {
    conditions.push(eq(animals.lifecycleStatus, filters.lifecycleStatus));
  }
  if (
    filters.adoptionStatus &&
    isAnimalAdoptionStatus(filters.adoptionStatus)
  ) {
    conditions.push(eq(animals.adoptionStatus, filters.adoptionStatus));
  }

  const q = query.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const clauses: SQL[] = [
      sql`${animals.name} ILIKE ${like}`,
      sql`${animals.registryRef} ILIKE ${like}`,
      sql`${animals.identifyingNotes} ILIKE ${like}`,
      sql`${animals.legacyId} = ${q}`,
      sql`EXISTS (
        SELECT 1 FROM ownerships o
        JOIN persons p ON p.id = o.person_id
        WHERE o.animal_id = ${animals.id} AND p.full_name ILIKE ${like}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ownerships o
        JOIN households h ON h.id = o.household_id
        WHERE o.animal_id = ${animals.id} AND h.name ILIKE ${like}
      )`,
    ];
    if (UUID_RE.test(q)) {
      clauses.push(sql`${animals.id} = ${q}::uuid`);
    }
    // Microchip numbers are stored normalized — the canonical
    // normalizeChipNumber keeps search and the dedicated chip lookup on
    // exactly the same matching semantics. Matching is EXACT or
    // left-anchored prefix (staff type a chip left to right): the
    // prefix LIKE stays btree-index compatible on mc.chip_number where
    // a leading-wildcard ILIKE could not use any index. Normalized
    // values are A-Z0-9 only, so no LIKE metacharacter escaping is
    // needed.
    const chipQuery = normalizeChipNumber(q);
    if (chipQuery.length >= 4) {
      clauses.push(sql`EXISTS (
        SELECT 1 FROM microchip_records mc
        WHERE mc.animal_id = ${animals.id}
          AND mc.chip_number LIKE ${`${chipQuery}%`}
      )`);
    }
    conditions.push(or(...clauses) as SQL);
  }

  const rows = await db
    .select(ADMIN_COLUMNS)
    .from(animals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(animals.name), asc(animals.id))
    .limit(SEARCH_LIMIT);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const ownerRows = await db
    .select({
      animalId: ownerships.animalId,
      personName: persons.fullName,
      householdName: households.name,
    })
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(and(inArray(ownerships.animalId, ids), isNull(ownerships.validTo)));
  const chipRows = await db
    .select({
      animalId: microchipRecords.animalId,
      chipNumber: microchipRecords.chipNumber,
      chipDisplay: microchipRecords.chipDisplay,
    })
    .from(microchipRecords)
    .where(
      and(
        inArray(microchipRecords.animalId, ids),
        isNull(microchipRecords.assignedTo),
      ),
    );

  const ownersByAnimal = new Map<string, string[]>();
  for (const r of ownerRows) {
    const label = r.personName ?? r.householdName;
    if (!label) continue;
    const list = ownersByAnimal.get(r.animalId) ?? [];
    if (!list.includes(label)) list.push(label);
    ownersByAnimal.set(r.animalId, list);
  }
  const chipsByAnimal = new Map<string, string[]>();
  for (const r of chipRows) {
    const list = chipsByAnimal.get(r.animalId) ?? [];
    list.push(r.chipDisplay ?? r.chipNumber);
    chipsByAnimal.set(r.animalId, list);
  }

  return rows.map((row) => ({
    animal: toAdminDto(row),
    owners: ownersByAnimal.get(row.id) ?? [],
    microchips: chipsByAnimal.get(row.id) ?? [],
  }));
}

// --- Registry profile context ------------------------------------------------

// The cross-domain bundle the canonical profile renders alongside the
// medical record. These are READ-ONLY projections of other domains'
// tables — #168 owns microchip writes, #169/#170 own registration and
// payment workflows, vet documents are references only. The profile
// links and summarizes; it never reimplements their state machines.
export interface AnimalRegistryContext {
  // Full chip history (#168) — current and closed rows with display
  // numbers, provenance, and closure reasons.
  microchips: MicrochipRecord[];
  // Open chip-identity conflicts this animal is a party to (#168).
  chipConflicts: ChipConflictRecord[];
  // Lost/found case history for this animal (#176) — open cases first;
  // resolved/cancelled cases are retained history, never deleted. This
  // evolved from #168's found_reports scan log.
  lostFoundCases: LostFoundCaseRecord[];
  // Full registration history (#169) — every period's authoritative
  // record with owner snapshot, assessed amount, derived payment state,
  // and resolution/cancellation lineage.
  registrations: RegistrationRecord[];
  // Full ledger rows for this animal's registrations (#170) — every
  // payment/refund/adjustment with method, status, source, reference,
  // and linkage. Pending/failed/void rows stay visible: they are part
  // of the truth staff reconcile.
  payments: PaymentRecord[];
  // Append-only reconciliation history for those rows (#170) — who/
  // what transitioned each transaction and when.
  paymentEvents: PaymentEventRecord[];
  documents: {
    id: string;
    label: string;
    notes: string | null;
    createdAt: string;
  }[];
  // Recent audit rows for THIS animal — actor/action/time only; the
  // lifecycle-events table is the domain history, this is the
  // who-changed-what trail.
  auditTrail: {
    id: string;
    action: string;
    actorLabel: string | null;
    createdAt: string;
  }[];
}

export async function getAnimalRegistryContext(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalRegistryContext | null> {
  if (!UUID_RE.test(animalId)) return null;

  const [
    chipRows,
    chipConflictRows,
    lostFoundRows,
    registrationRows,
    paymentRows,
    documentRows,
    auditRows,
  ] = await Promise.all([
    listMicrochipsForAnimal(animalId, db),
    listChipConflicts({ animalId }, db),
    listCasesForAnimal(animalId, db),
    listRegistrationsForAnimal(animalId, db),
      // Payments reach the animal only through a registration — there is
      // deliberately no payments.animal_id.
      listPaymentsForAnimal(animalId, db),
      db
        .select({
          id: vetDocuments.id,
          label: vetDocuments.label,
          notes: vetDocuments.notes,
          createdAt: vetDocuments.createdAt,
        })
        .from(vetDocuments)
        .where(eq(vetDocuments.animalId, animalId))
        .orderBy(desc(vetDocuments.createdAt)),
      db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          actorLabel: auditEvents.actorLabel,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityType, "animal"),
            eq(auditEvents.entityId, animalId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(25),
    ]);

  const paymentEvents = await listPaymentEvents(
    paymentRows.map((p) => p.id),
    db,
  );

  return {
    microchips: chipRows,
    chipConflicts: chipConflictRows,
    lostFoundCases: lostFoundRows,
    registrations: registrationRows,
    payments: paymentRows,
    paymentEvents,
    documents: documentRows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    auditTrail: auditRows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
