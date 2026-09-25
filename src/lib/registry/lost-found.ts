// Lost/found case service (#176) — THE write/read seam for missing and
// found animal cases. Route handlers and server actions call these
// functions; Drizzle never appears in UI code.
//
// Model (src/lib/db/schema.ts + src/lib/lost-found.ts vocabulary):
//   - A CASE is a workflow record about a real-world event, deliberately
//     separate from the animal's permanent lifecycle: a 'missing' case
//     opens and resolves while the animal stays lifecycle 'active', and
//     resolution never rewrites identity, ownership, or registration.
//     The one deliberate intersection is outcome 'deceased' on a linked
//     case, which drives the canonical transitionAnimalLifecycle — the
//     registry fact lands through the one write path, not case notes.
//   - case_type 'missing' is always linked to a registered animal (DB
//     CHECK). case_type 'found' may be unmatched (animal_id NULL): an
//     unknown chip or unregistered stray is a real case with
//     description/found details, never a fabricated animal. linked_at/
//     linked_by preserve that the case BEGAN unmatched when staff later
//     attach it.
//   - Partial unique indexes carry the invariants: at most one open
//     missing case and one open found case per animal (they may
//     coexist), and at most one open unmatched case per chip number —
//     a re-scan re-flags the same case instead of stacking duplicates.
//     Resolving one of an animal's open cases resolves the other in the
//     same transaction — "the missing animal was found" is one event.
//   - found_reports (#168) EVOLVED into this model: the migration
//     rewrote those rows as 'found' cases and dropped the old table, so
//     there is exactly one representation of a found-animal event.
//   - lost_found_updates is the append-only chronology (sightings,
//     scans, notes) — linkage, publication and resolution also write
//     rows so the timeline is the case's whole story.
//   - published_at is the explicit staff opt-in to the public lost-pets
//     page. listPublishedLostAnimals is the ONLY public read and its
//     DTO is an allowlist: no owner/reporter contact, no staff notes,
//     no chip data.
//
// Every mutation commits its audit_events row in the same transaction,
// same as the other registry services.

import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  lostFoundCases,
  lostFoundUpdates,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { chipDisplayValue, chipNumberProblem, normalizeChipNumber } from "../microchips";
import { formatAnimalAge } from "../animal-lifecycle";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import {
  LOST_FOUND_OUTCOME_LABELS,
  isLostFoundOutcome,
  isLostFoundReportedVia,
  isLostFoundUpdateKind,
} from "../lost-found";
import type {
  LostFoundCaseStatus,
  LostFoundCaseType,
  LostFoundOutcome,
  LostFoundReportedVia,
  LostFoundUpdateKind,
} from "../lost-found";
import {
  getOwnedOwnership,
  resolveAnimalOwner,
  resolveAnimalOwnerContacts,
} from "./ownership";
import type { AnimalOwnerContacts } from "./ownership";
import { insertCommunication } from "./communications";
import { absoluteUrl, getSiteUrl } from "../seo";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_FIELD = 200;
const MAX_NOTE = 2000;

// --- DTOs ---------------------------------------------------------------------

export interface LostFoundCaseRecord {
  id: string;
  caseType: LostFoundCaseType;
  status: LostFoundCaseStatus;
  animalId: string | null;
  // Resolved display fields for the linked animal (staff surfaces only —
  // never part of the public DTO).
  animalName: string | null;
  animalRegistryRef: string | null;
  animalSpecies: string | null;
  animalSex: string | null;
  animalLifecycleStatus: string | null;
  animalPhotoUrl: string | null;
  reportedAt: string;
  reportedVia: LostFoundReportedVia;
  reporterName: string | null;
  reporterContact: string | null;
  lastSeenOn: string | null;
  lastSeenLocation: string | null;
  foundOn: string | null;
  foundLocation: string | null;
  description: string | null;
  photoUrls: string[];
  chipNumber: string | null;
  chipDisplay: string | null;
  microchipRecordId: string | null;
  linkedAt: string | null;
  linkedBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  publicNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  outcome: string | null;
  resolutionNote: string | null;
  notes: string | null;
  actorLabel: string | null;
  createdAt: string;
}

export interface LostFoundUpdateRecord {
  id: string;
  caseId: string;
  kind: LostFoundUpdateKind;
  occurredAt: string;
  location: string | null;
  note: string | null;
  reporterName: string | null;
  reporterContact: string | null;
  source: string;
  actorLabel: string | null;
  createdAt: string;
}

export interface LostFoundCaseDetail {
  case: LostFoundCaseRecord;
  updates: LostFoundUpdateRecord[];
  owners: AnimalOwnerContacts[];
  ownershipAmbiguous: boolean;
}

// The PUBLIC allowlist for the lost-pets page — built by
// listPublishedLostAnimals only. Nothing else about a case (reporter,
// staff notes, chip numbers, owner identity) may reach a public DTO.
export interface PublicLostAnimal {
  caseId: string;
  registryRef: string;
  name: string;
  species: string;
  sex: string;
  approxAge: string | null;
  photoUrl: string | null;
  publicNote: string | null;
  missingSince: string | null;
  lastSeenLocation: string | null;
}

export type LostFoundResult =
  | {
      ok: true;
      case: LostFoundCaseRecord;
      // True when the request folded into an already-open case (dedupe) —
      // the caller reports "already on file" instead of "created".
      existing?: boolean;
      // Set when a found scan attached to the animal's OPEN MISSING case
      // instead of creating a found case.
      matchedMissing?: boolean;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "invalid"
        | "conflict"
        | "not-open"
        | "not-unmatched"
        | "has-open-case";
      field?: string;
    };

// --- Row → DTO ---------------------------------------------------------------

const CASE_COLUMNS = {
  id: lostFoundCases.id,
  caseType: lostFoundCases.caseType,
  status: lostFoundCases.status,
  animalId: lostFoundCases.animalId,
  reportedAt: lostFoundCases.reportedAt,
  reportedVia: lostFoundCases.reportedVia,
  reporterName: lostFoundCases.reporterName,
  reporterContact: lostFoundCases.reporterContact,
  lastSeenOn: lostFoundCases.lastSeenOn,
  lastSeenLocation: lostFoundCases.lastSeenLocation,
  foundOn: lostFoundCases.foundOn,
  foundLocation: lostFoundCases.foundLocation,
  description: lostFoundCases.description,
  photoUrls: lostFoundCases.photoUrls,
  chipNumber: lostFoundCases.chipNumber,
  chipDisplay: lostFoundCases.chipDisplay,
  microchipRecordId: lostFoundCases.microchipRecordId,
  linkedAt: lostFoundCases.linkedAt,
  linkedBy: lostFoundCases.linkedBy,
  publishedAt: lostFoundCases.publishedAt,
  publishedBy: lostFoundCases.publishedBy,
  publicNote: lostFoundCases.publicNote,
  resolvedAt: lostFoundCases.resolvedAt,
  resolvedBy: lostFoundCases.resolvedBy,
  outcome: lostFoundCases.outcome,
  resolutionNote: lostFoundCases.resolutionNote,
  notes: lostFoundCases.notes,
  actorIdentityId: lostFoundCases.actorIdentityId,
  actorLabel: lostFoundCases.actorLabel,
  createdAt: lostFoundCases.createdAt,
  updatedAt: lostFoundCases.updatedAt,
  animalName: animals.name,
  animalRegistryRef: animals.registryRef,
  animalSpecies: animals.species,
  animalSex: animals.sex,
  animalLifecycleStatus: animals.lifecycleStatus,
  animalPhotoUrls: animals.photoUrls,
} as const;

type CaseRow = typeof lostFoundCases.$inferSelect & {
  animalName?: string | null;
  animalRegistryRef?: string | null;
  animalSpecies?: string | null;
  animalSex?: string | null;
  animalLifecycleStatus?: string | null;
  animalPhotoUrls?: string[] | null;
};

function toCaseDto(row: CaseRow): LostFoundCaseRecord {
  return {
    id: row.id,
    caseType: row.caseType as LostFoundCaseType,
    status: row.status as LostFoundCaseStatus,
    animalId: row.animalId,
    animalName: row.animalName ?? null,
    animalRegistryRef: row.animalRegistryRef ?? null,
    animalSpecies: row.animalSpecies ?? null,
    animalSex: row.animalSex ?? null,
    animalLifecycleStatus: row.animalLifecycleStatus ?? null,
    animalPhotoUrl: row.animalPhotoUrls?.[0] ?? null,
    reportedAt: row.reportedAt.toISOString(),
    reportedVia: row.reportedVia as LostFoundReportedVia,
    reporterName: row.reporterName,
    reporterContact: row.reporterContact,
    lastSeenOn: row.lastSeenOn,
    lastSeenLocation: row.lastSeenLocation,
    foundOn: row.foundOn,
    foundLocation: row.foundLocation,
    description: row.description,
    photoUrls: row.photoUrls ?? [],
    chipNumber: row.chipNumber,
    chipDisplay: row.chipDisplay,
    microchipRecordId: row.microchipRecordId,
    linkedAt: row.linkedAt?.toISOString() ?? null,
    linkedBy: row.linkedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    publicNote: row.publicNote,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    outcome: row.outcome,
    resolutionNote: row.resolutionNote,
    notes: row.notes,
    actorLabel: row.actorLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

type UpdateRow = typeof lostFoundUpdates.$inferSelect;

function toUpdateDto(row: UpdateRow): LostFoundUpdateRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind as LostFoundUpdateKind,
    occurredAt: row.occurredAt.toISOString(),
    location: row.location,
    note: row.note,
    reporterName: row.reporterName,
    reporterContact: row.reporterContact,
    source: row.source,
    actorLabel: row.actorLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

// Re-read a case through the joined projection so every returned DTO
// carries the animal display fields — insert/update .returning() rows
// lack them, and callers (workspace rows, chip-lookup banners) render
// animalName/registryRef without a second query.
async function fetchCaseDto(
  db: Pick<RegistryDb, "select">,
  caseId: string,
): Promise<LostFoundCaseRecord | null> {
  const [row] = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(eq(lostFoundCases.id, caseId))
    .limit(1);
  return row ? toCaseDto(row) : null;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  return code === "23505" || cause?.code === "23505";
}

function trimField(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, MAX_FIELD);
  return trimmed || null;
}

function trimNote(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, MAX_NOTE);
  return trimmed || null;
}

async function audit(
  tx: Pick<RegistryDb, "insert">,
  entry: {
    entityId: string;
    action: string;
    actorIdentityId?: string | null;
    actorLabel?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.insert(auditEvents).values({
    entityType: "lost_found_case",
    entityId: entry.entityId,
    action: entry.action,
    actorIdentityId: entry.actorIdentityId ?? null,
    actorLabel: entry.actorLabel ?? null,
    before: entry.before === undefined ? null : JSON.stringify(entry.before),
    after: entry.after === undefined ? null : JSON.stringify(entry.after),
  });
}

// --- Reads -------------------------------------------------------------------

// Open cases for the staff queue, oldest first — the hot read backed by
// lost_found_cases_open_idx. Pass caseType to scope to one queue.
export async function listOpenCases(
  options: { caseType?: LostFoundCaseType } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundCaseRecord[]> {
  const rows = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(
      and(
        eq(lostFoundCases.status, "open"),
        options.caseType
          ? eq(lostFoundCases.caseType, options.caseType)
          : undefined,
      ),
    )
    .orderBy(asc(lostFoundCases.reportedAt));
  return rows.map(toCaseDto);
}

// Recently closed (resolved/cancelled) cases, newest first — the
// workspace's history strip, bounded so it never swallows the queue.
export async function listClosedCases(
  options: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundCaseRecord[]> {
  const rows = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(inArray(lostFoundCases.status, ["resolved", "cancelled"]))
    .orderBy(desc(lostFoundCases.resolvedAt))
    .limit(options.limit ?? 20);
  return rows.map(toCaseDto);
}

// Dashboard/queue counters — one indexed aggregate read.
export async function getOpenCaseCounts(
  db: RegistryDb = getRegistryDb(),
): Promise<{ missing: number; foundUnmatched: number; foundMatched: number }> {
  const [row] = await db
    .select({
      missing:
        sql<number>`count(*) filter (where ${lostFoundCases.caseType} = 'missing')::int`,
      foundUnmatched:
        sql<number>`count(*) filter (where ${lostFoundCases.caseType} = 'found' and ${lostFoundCases.animalId} is null)::int`,
      foundMatched:
        sql<number>`count(*) filter (where ${lostFoundCases.caseType} = 'found' and ${lostFoundCases.animalId} is not null)::int`,
    })
    .from(lostFoundCases)
    .where(eq(lostFoundCases.status, "open"));
  return {
    missing: row?.missing ?? 0,
    foundUnmatched: row?.foundUnmatched ?? 0,
    foundMatched: row?.foundMatched ?? 0,
  };
}

// All cases for one animal — profile panel. Open first, then newest.
export async function listCasesForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundCaseRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(eq(lostFoundCases.animalId, animalId))
    .orderBy(
      sql`(${lostFoundCases.status} = 'open') desc`,
      desc(lostFoundCases.reportedAt),
    );
  return rows.map(toCaseDto);
}

// Open cases relevant to a chip scan: any open case on the matched
// animal PLUS any open unmatched case already filed for this chip
// number (flagged earlier by a previous scan).
export async function listOpenCasesForChipOrAnimal(
  options: { animalId?: string | null; chipNumber?: string | null },
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundCaseRecord[]> {
  const clauses = [];
  if (options.animalId && UUID_RE.test(options.animalId)) {
    clauses.push(eq(lostFoundCases.animalId, options.animalId));
  }
  if (options.chipNumber) {
    clauses.push(
      and(
        isNull(lostFoundCases.animalId),
        eq(lostFoundCases.chipNumber, options.chipNumber),
      ),
    );
  }
  if (clauses.length === 0) return [];
  const rows = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(
      and(
        eq(lostFoundCases.status, "open"),
        clauses.length === 1 ? clauses[0] : sql`(${clauses[0]} OR ${clauses[1]})`,
      ),
    )
    .orderBy(asc(lostFoundCases.reportedAt));
  return rows.map(toCaseDto);
}

async function getCaseRow(
  caseId: string,
  db: Pick<RegistryDb, "select">,
): Promise<typeof lostFoundCases.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(lostFoundCases)
    .where(eq(lostFoundCases.id, caseId))
    .limit(1);
  return row;
}

// Staff case detail: the case, its full chronology, and the linked
// animal's CURRENT owner contacts (the canonical owner-contact
// projection — same one chip-lookup uses).
export async function getCaseDetail(
  caseId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundCaseDetail | null> {
  if (!UUID_RE.test(caseId)) return null;
  const [row] = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(eq(lostFoundCases.id, caseId))
    .limit(1);
  if (!row) return null;
  const updateRows = await db
    .select()
    .from(lostFoundUpdates)
    .where(eq(lostFoundUpdates.caseId, caseId))
    .orderBy(asc(lostFoundUpdates.occurredAt), asc(lostFoundUpdates.createdAt));
  const ownerInfo = row.animalId
    ? await resolveAnimalOwnerContacts(row.animalId, db)
    : { owners: [], ambiguous: false };
  return {
    case: toCaseDto(row),
    updates: updateRows.map(toUpdateDto),
    owners: ownerInfo.owners,
    ownershipAmbiguous: ownerInfo.ambiguous,
  };
}

export async function listUpdatesForCase(
  caseId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundUpdateRecord[]> {
  if (!UUID_RE.test(caseId)) return [];
  const rows = await db
    .select()
    .from(lostFoundUpdates)
    .where(eq(lostFoundUpdates.caseId, caseId))
    .orderBy(asc(lostFoundUpdates.occurredAt), asc(lostFoundUpdates.createdAt));
  return rows.map(toUpdateDto);
}

// THE public read — published open missing cases only, allowlisted
// fields only. Never returns reporter/owner contact, staff notes, or
// chip data. Resolving or unpublishing a case removes it here
// automatically; nothing else is needed for de-listing.
export async function listPublishedLostAnimals(
  db: RegistryDb = getRegistryDb(),
): Promise<PublicLostAnimal[]> {
  const rows = await db
    .select({
      caseId: lostFoundCases.id,
      registryRef: animals.registryRef,
      name: animals.name,
      species: animals.species,
      sex: animals.sex,
      birthDate: animals.birthDate,
      birthDateEstimated: animals.birthDateEstimated,
      photoUrls: animals.photoUrls,
      casePhotoUrls: lostFoundCases.photoUrls,
      publicNote: lostFoundCases.publicNote,
      lastSeenOn: lostFoundCases.lastSeenOn,
      reportedAt: lostFoundCases.reportedAt,
      lastSeenLocation: lostFoundCases.lastSeenLocation,
    })
    .from(lostFoundCases)
    .innerJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(
      and(
        eq(lostFoundCases.status, "open"),
        eq(lostFoundCases.caseType, "missing"),
        sql`${lostFoundCases.publishedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(lostFoundCases.reportedAt));
  return rows.map((r) => ({
    caseId: r.caseId,
    registryRef: r.registryRef,
    name: r.name,
    species: r.species,
    sex: r.sex,
    approxAge: formatAnimalAge(r.birthDate, r.birthDateEstimated),
    photoUrl: r.casePhotoUrls?.[0] ?? r.photoUrls?.[0] ?? null,
    publicNote: r.publicNote,
    missingSince: r.lastSeenOn ?? r.reportedAt.toISOString().slice(0, 10),
    lastSeenLocation: r.lastSeenLocation,
  }));
}

// The public sighting form's gate: the case must be exactly what the
// public page would show (open, published, missing, linked) — anything
// else is answered identically to "no such case" so the endpoint can
// never confirm a private case exists.
export async function isPubliclyListable(
  caseId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<boolean> {
  if (!UUID_RE.test(caseId)) return false;
  const [row] = await db
    .select({ id: lostFoundCases.id })
    .from(lostFoundCases)
    .where(
      and(
        eq(lostFoundCases.id, caseId),
        eq(lostFoundCases.status, "open"),
        eq(lostFoundCases.caseType, "missing"),
        sql`${lostFoundCases.publishedAt} IS NOT NULL`,
        sql`${lostFoundCases.animalId} IS NOT NULL`,
      ),
    )
    .limit(1);
  return !!row;
}

// --- Writes ------------------------------------------------------------------

// Open a missing case on a REGISTERED animal. Idempotent per animal:
// an already-open missing case returns existing instead of stacking —
// double-clicks, retried owner submissions and duplicate staff entry all
// converge on the one work item the unique index already guarantees.
export async function openMissingCase(
  input: {
    animalId: string;
    lastSeenOn?: string | null;
    lastSeenLocation?: string | null;
    description?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
    notes?: string | null;
    reportedVia?: LostFoundReportedVia;
    actorIdentityId?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(input.animalId)) {
    return { ok: false, reason: "not-found" };
  }
  const reportedVia = input.reportedVia ?? "staff";
  if (!isLostFoundReportedVia(reportedVia)) {
    return { ok: false, reason: "invalid", field: "reportedVia" };
  }
  if (input.lastSeenOn && !isIsoDateString(input.lastSeenOn)) {
    return { ok: false, reason: "invalid", field: "lastSeenOn" };
  }

  const [animal] = await db
    .select({ id: animals.id })
    .from(animals)
    .where(eq(animals.id, input.animalId))
    .limit(1);
  if (!animal) return { ok: false, reason: "not-found" };

  const [existing] = await db
    .select(CASE_COLUMNS)
    .from(lostFoundCases)
    .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
    .where(
      and(
        eq(lostFoundCases.animalId, input.animalId),
        eq(lostFoundCases.caseType, "missing"),
        eq(lostFoundCases.status, "open"),
      ),
    )
    .limit(1);
  if (existing) return { ok: true, case: toCaseDto(existing), existing: true };

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(lostFoundCases)
        .values({
          caseType: "missing",
          animalId: input.animalId,
          lastSeenOn: input.lastSeenOn ?? null,
          lastSeenLocation: trimField(input.lastSeenLocation),
          description: trimNote(input.description),
          reporterName: trimField(input.reporterName),
          reporterContact: trimField(input.reporterContact),
          notes: trimNote(input.notes),
          reportedVia,
          actorIdentityId: input.actorIdentityId ?? null,
          actorLabel,
        })
        .returning();
      if (!row) return { ok: false as const, reason: "invalid" as const };
      await audit(tx, {
        entityId: row.id,
        action: "create",
        actorIdentityId: input.actorIdentityId,
        actorLabel,
        after: {
          caseType: "missing",
          animalId: input.animalId,
          reportedVia,
          lastSeenOn: row.lastSeenOn,
        },
      });
      return {
        ok: true as const,
        case: (await fetchCaseDto(tx, row.id)) ?? toCaseDto(row),
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the race against a concurrent open — the unique index made
    // one winner; re-read it and report dedupe, not a crash.
    const [winner] = await db
      .select(CASE_COLUMNS)
      .from(lostFoundCases)
      .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
      .where(
        and(
          eq(lostFoundCases.animalId, input.animalId),
          eq(lostFoundCases.caseType, "missing"),
          eq(lostFoundCases.status, "open"),
        ),
      )
      .limit(1);
    if (winner) return { ok: true, case: toCaseDto(winner), existing: true };
    throw error;
  }
}

// Record a found-animal event — the chip-scan write path AND the staff
// "report a found animal" intake in one. Deterministic routing:
//   - matched animal WITH an open missing case → the scan lands as a
//     'scan' chronology row on THAT case (no duplicate found case); a
//     supplied outcome resolves it — "the missing dog is home".
//   - matched animal with an open found case (or the same unmatched
//     chip already flagged) → a 'scan' row on the existing case.
//   - otherwise → a new 'found' case (open, or immediately resolved
//     when outcome is supplied — "scanned, owner fetched her").
// chipNumber is optional: a found animal may have no chip at all — then
// every report is a distinct case (no reliable dedupe key exists).
export async function openFoundCase(
  input: {
    animalId?: string | null;
    microchipRecordId?: string | null;
    chipNumber?: string | null;
    chipDisplay?: string | null;
    foundOn?: string | null;
    foundLocation?: string | null;
    description?: string | null;
    photoUrls?: string[] | null;
    reporterName?: string | null;
    reporterContact?: string | null;
    notes?: string | null;
    outcome?: string | null;
    resolutionNote?: string | null;
    actorIdentityId?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  let normalized: string | null = null;
  if (input.chipNumber) {
    normalized = normalizeChipNumber(input.chipNumber);
    if (chipNumberProblem(normalized)) {
      return { ok: false, reason: "invalid", field: "chipNumber" };
    }
  }
  if (input.animalId && !UUID_RE.test(input.animalId)) {
    return { ok: false, reason: "not-found" };
  }
  if (input.foundOn && !isIsoDateString(input.foundOn)) {
    return { ok: false, reason: "invalid", field: "foundOn" };
  }
  let outcome: LostFoundOutcome | null = null;
  if (input.outcome) {
    if (!isLostFoundOutcome(input.outcome)) {
      return { ok: false, reason: "invalid", field: "outcome" };
    }
    outcome = input.outcome;
  }

  const scanNote = trimNote(input.notes);
  const location = trimField(input.foundLocation);
  const reporterName = trimField(input.reporterName);
  const reporterContact = trimField(input.reporterContact);

  // Route through the existing open case when one matches.
  const existing = await findAttachableCase(
    { animalId: input.animalId ?? null, chipNumber: normalized },
    db,
  );
  if (existing) {
    // A scan/update row preserves that this event happened even though
    // the case itself already existed.
    await insertUpdate(db, {
      caseId: existing.id,
      kind: "scan",
      location,
      note: scanNote,
      reporterName,
      reporterContact,
      source: "staff",
      actorIdentityId: input.actorIdentityId ?? null,
      actorLabel,
    });
    if (outcome) {
      return resolveCase(
        existing.id,
        { outcome, resolutionNote: input.resolutionNote ?? scanNote },
        actorLabel,
        db,
      );
    }
    const refreshed = await getCaseRow(existing.id, db);
    return {
      ok: true,
      case: toCaseDto({ ...(refreshed ?? existing) }),
      existing: true,
      matchedMissing: existing.caseType === "missing",
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(lostFoundCases)
        .values({
          caseType: "found",
          animalId: input.animalId ?? null,
          microchipRecordId: input.microchipRecordId ?? null,
          chipNumber: normalized,
          chipDisplay: normalized
            ? chipDisplayValue(input.chipNumber, normalized)
            : null,
          foundOn: input.foundOn ?? todayIsoDate(),
          foundLocation: location,
          description: trimNote(input.description),
          photoUrls: (input.photoUrls ?? []).slice(0, 12),
          reporterName,
          reporterContact,
          notes: scanNote,
          outcome,
          resolutionNote: outcome ? trimNote(input.resolutionNote) : null,
          resolvedAt: outcome ? new Date() : null,
          resolvedBy: outcome ? actorLabel : null,
          status: outcome ? "resolved" : "open",
          actorIdentityId: input.actorIdentityId ?? null,
          actorLabel,
        })
        .returning();
      if (!row) return { ok: false as const, reason: "invalid" as const };
      await audit(tx, {
        entityId: row.id,
        action: "create",
        actorIdentityId: input.actorIdentityId,
        actorLabel,
        after: {
          caseType: "found",
          animalId: row.animalId,
          chipNumber: normalized,
          matched: !!input.animalId,
          resolvedImmediately: !!outcome,
        },
      });
      return {
        ok: true as const,
        case: (await fetchCaseDto(tx, row.id)) ?? toCaseDto(row),
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Concurrent insert won the dedupe index — fold into that case
    // exactly as if we had found it in the pre-check.
    const winner = await findAttachableCase(
      { animalId: input.animalId ?? null, chipNumber: normalized },
      db,
    );
    if (winner) {
      await insertUpdate(db, {
        caseId: winner.id,
        kind: "scan",
        location,
        note: scanNote,
        reporterName,
        reporterContact,
        source: "staff",
        actorIdentityId: input.actorIdentityId ?? null,
        actorLabel,
      });
      return {
        ok: true,
        case: toCaseDto(winner),
        existing: true,
        matchedMissing: winner.caseType === "missing",
      };
    }
    throw error;
  }
}

// The open case a found-animal event attaches to, or null: the animal's
// open MISSING case first (the found animal IS the missing animal —
// the scan is evidence on that case), then its open found case, then
// an unmatched case already filed for this chip number.
async function findAttachableCase(
  { animalId, chipNumber }: { animalId: string | null; chipNumber: string | null },
  db: RegistryDb,
): Promise<typeof lostFoundCases.$inferSelect | undefined> {
  if (animalId) {
    const [missing] = await db
      .select()
      .from(lostFoundCases)
      .where(
        and(
          eq(lostFoundCases.animalId, animalId),
          eq(lostFoundCases.caseType, "missing"),
          eq(lostFoundCases.status, "open"),
        ),
      )
      .limit(1);
    if (missing) return missing;
    const [found] = await db
      .select()
      .from(lostFoundCases)
      .where(
        and(
          eq(lostFoundCases.animalId, animalId),
          eq(lostFoundCases.caseType, "found"),
          eq(lostFoundCases.status, "open"),
        ),
      )
      .limit(1);
    if (found) return found;
  } else if (chipNumber) {
    const [unmatched] = await db
      .select()
      .from(lostFoundCases)
      .where(
        and(
          eq(lostFoundCases.chipNumber, chipNumber),
          isNull(lostFoundCases.animalId),
          eq(lostFoundCases.status, "open"),
        ),
      )
      .limit(1);
    if (unmatched) return unmatched;
  }
  return undefined;
}

async function insertUpdate(
  db: Pick<RegistryDb, "insert">,
  input: {
    caseId: string;
    kind: LostFoundUpdateKind;
    occurredAt?: Date;
    location?: string | null;
    note?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
    source?: string;
    actorIdentityId?: string | null;
    actorLabel?: string | null;
  },
): Promise<typeof lostFoundUpdates.$inferSelect> {
  const [row] = await db
    .insert(lostFoundUpdates)
    .values({
      caseId: input.caseId,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date(),
      location: input.location ?? null,
      note: input.note ?? null,
      reporterName: input.reporterName ?? null,
      reporterContact: input.reporterContact ?? null,
      source: input.source ?? "staff",
      actorIdentityId: input.actorIdentityId ?? null,
      actorLabel: input.actorLabel ?? null,
    })
    .returning();
  return row;
}

// Append a chronology row to an open case — a sighting, a scan note, or
// a staff beat. The row is the domain history; an audit event records
// the write too.
export async function addCaseUpdate(
  caseId: string,
  input: {
    kind: LostFoundUpdateKind;
    occurredAt?: string | Date | null;
    location?: string | null;
    note?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
    source?: string;
    actorIdentityId?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<
  | { ok: true; update: LostFoundUpdateRecord }
  | { ok: false; reason: "not-found" | "invalid" | "not-open"; field?: string }
> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  if (!isLostFoundUpdateKind(input.kind)) {
    return { ok: false, reason: "invalid", field: "kind" };
  }
  const source = input.source ?? "staff";
  if (!["staff", "owner-portal", "public"].includes(source)) {
    return { ok: false, reason: "invalid", field: "source" };
  }
  let occurredAt: Date | undefined;
  if (input.occurredAt) {
    const parsed = new Date(input.occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, reason: "invalid", field: "occurredAt" };
    }
    occurredAt = parsed;
  }
  if (!trimNote(input.note) && !trimField(input.location)) {
    return { ok: false, reason: "invalid", field: "note" };
  }

  return db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(lostFoundCases)
      .where(eq(lostFoundCases.id, caseId))
      .for("update")
      .limit(1);
    if (!caseRow) return { ok: false as const, reason: "not-found" as const };
    if (caseRow.status !== "open") {
      return { ok: false as const, reason: "not-open" as const };
    }
    const row = await insertUpdate(tx, {
      caseId,
      kind: input.kind,
      occurredAt,
      location: trimField(input.location),
      note: trimNote(input.note),
      reporterName: trimField(input.reporterName),
      reporterContact: trimField(input.reporterContact),
      source,
      actorIdentityId: input.actorIdentityId ?? null,
      actorLabel,
    });
    await tx.insert(auditEvents).values({
      entityType: "lost_found_update",
      entityId: row.id,
      action: "add",
      actorIdentityId: input.actorIdentityId ?? null,
      actorLabel,
      after: JSON.stringify({ caseId, kind: input.kind, source }),
    });
    return { ok: true as const, update: toUpdateDto(row) };
  });
}

// The public sighting form — writes ONLY through here, and only onto a
// case the public page currently lists (isPubliclyListable). No case
// detail is returned to the caller either way.
export async function submitPublicSighting(
  caseId: string,
  input: {
    location?: string | null;
    note?: string | null;
    reporterName?: string | null;
    reporterContact?: string | null;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<{ ok: true } | { ok: false }> {
  if (!(await isPubliclyListable(caseId, db))) return { ok: false };
  if (!trimNote(input.note) && !trimField(input.location)) {
    return { ok: false };
  }
  const result = await addCaseUpdate(
    caseId,
    {
      kind: "sighting",
      location: input.location,
      note: input.note,
      reporterName: input.reporterName,
      reporterContact: input.reporterContact,
      source: "public",
    },
    "public-report",
    db,
  );
  return result.ok ? { ok: true } : { ok: false };
}

// Link an unmatched found case to a registry animal — explicit staff
// action, never fuzzy auto-matching. The link stamps linked_at/linked_by
// so "this case began unmatched" stays true forever. Rejected when the
// animal already has an open FOUND case (two open found cases for one
// animal is never meaningful); an open MISSING case is fine — the pair
// is the "missing animal was found" signal, and resolving either closes
// both.
export async function linkCaseToAnimal(
  caseId: string,
  animalId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId) || !UUID_RE.test(animalId)) {
    return { ok: false, reason: "not-found" };
  }
  const [animal] = await db
    .select({ id: animals.id, registryRef: animals.registryRef })
    .from(animals)
    .where(eq(animals.id, animalId))
    .limit(1);
  if (!animal) return { ok: false, reason: "not-found" };

  const [siblingFound] = await db
    .select({ id: lostFoundCases.id })
    .from(lostFoundCases)
    .where(
      and(
        eq(lostFoundCases.animalId, animalId),
        eq(lostFoundCases.caseType, "found"),
        eq(lostFoundCases.status, "open"),
        sql`${lostFoundCases.id} <> ${caseId}`,
      ),
    )
    .limit(1);
  if (siblingFound) return { ok: false, reason: "has-open-case" };

  let result: LostFoundResult;
  try {
    result = await db.transaction(async (tx) => {
      const [caseRow] = await tx
        .select()
        .from(lostFoundCases)
        .where(eq(lostFoundCases.id, caseId))
        .for("update")
        .limit(1);
      if (!caseRow) return { ok: false as const, reason: "not-found" as const };
      if (caseRow.status !== "open") {
        return { ok: false as const, reason: "not-open" as const };
      }
      if (caseRow.animalId) {
        return { ok: false as const, reason: "not-unmatched" as const };
      }

      const [row] = await tx
        .update(lostFoundCases)
        .set({
          animalId,
          linkedAt: new Date(),
          linkedBy: actorLabel,
          updatedAt: new Date(),
        })
        .where(eq(lostFoundCases.id, caseId))
        .returning();
      await insertUpdate(tx, {
        caseId,
        kind: "update",
        note: `Linked to registry animal ${animal.registryRef} by ${actorLabel}`,
        source: "staff",
        actorLabel,
      });
      await audit(tx, {
        entityId: caseId,
        action: "link-animal",
        actorLabel,
        before: { animalId: null },
        after: { animalId, registryRef: animal.registryRef },
      });

      const [detail] = await tx
        .select(CASE_COLUMNS)
        .from(lostFoundCases)
        .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
        .where(eq(lostFoundCases.id, caseId))
        .limit(1);
      return { ok: true as const, case: toCaseDto(detail ?? row) };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { ok: false, reason: "has-open-case" };
  }

  // If the animal already has an open missing case, this link IS the
  // match — notify the owner through the communication ledger
  // (idempotent; a re-link or duplicate path can't double-send). Runs
  // post-commit: a ledger failure must never roll back the link.
  if (result.ok) {
    const [missing] = await db
      .select({ id: lostFoundCases.id })
      .from(lostFoundCases)
      .where(
        and(
          eq(lostFoundCases.animalId, animalId),
          eq(lostFoundCases.caseType, "missing"),
          eq(lostFoundCases.status, "open"),
        ),
      )
      .limit(1);
    if (missing) {
      await queueCaseOwnerNotice(db, {
        animalId,
        event: "found-match",
        caseId,
      });
    }
  }
  return result;
}

// Resolve an open case. Sibling propagation is deliberate: when an
// animal has both a missing and a found case open, resolving either
// means the event ended — the other closes with the same outcome in the
// same transaction. Cancelling is the opposite: it only ever touches the
// one case (the OTHER case was never wrong).
export async function resolveCase(
  caseId: string,
  input: {
    outcome: LostFoundOutcome;
    resolutionNote?: string | null;
    // Real-world date for the lifecycle write when outcome='deceased'.
    deceasedEffectiveOn?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  if (!isLostFoundOutcome(input.outcome)) {
    return { ok: false, reason: "invalid", field: "outcome" };
  }
  const [existing] = await db
    .select()
    .from(lostFoundCases)
    .where(eq(lostFoundCases.id, caseId))
    .limit(1);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.status !== "open") return { ok: false, reason: "not-open" };

  // 'deceased' is a registry fact, not a case note — drive the canonical
  // lifecycle transition FIRST (its own transaction+audit, same as an
  // owner-request approval). If it can't land the case stays open.
  // Deliberate lazy import: animals.ts reads this service for the
  // registry context, so a static import would make the two modules
  // circular — the service graph stays acyclic this way.
  if (input.outcome === "deceased" && existing.animalId) {
    const [animal] = await db
      .select({ lifecycleStatus: animals.lifecycleStatus })
      .from(animals)
      .where(eq(animals.id, existing.animalId))
      .limit(1);
    if (animal && animal.lifecycleStatus !== "deceased") {
      const { transitionAnimalLifecycle } = await import("./animals");
      const transition = await transitionAnimalLifecycle(
        existing.animalId,
        {
          toStatus: "deceased",
          effectiveOn: input.deceasedEffectiveOn ?? todayIsoDate(),
          reason:
            trimNote(input.resolutionNote) ??
            "Resolved through a lost/found case.",
          source: "staff",
          sourceRef: caseId,
          actorLabel,
        },
        db,
      );
      if (!transition.ok) {
        return { ok: false, reason: "invalid", field: "outcome" };
      }
    }
  }

  const result = await db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(lostFoundCases)
      .where(eq(lostFoundCases.id, caseId))
      .for("update")
      .limit(1);
    if (!caseRow) return { ok: false as const, reason: "not-found" as const };
    if (caseRow.status !== "open") {
      return { ok: false as const, reason: "not-open" as const };
    }

    const resolvedAt = new Date();
    const note = trimNote(input.resolutionNote);
    const [row] = await tx
      .update(lostFoundCases)
      .set({
        status: "resolved",
        outcome: input.outcome,
        resolvedAt,
        resolvedBy: actorLabel,
        resolutionNote: note,
        updatedAt: resolvedAt,
      })
      .where(eq(lostFoundCases.id, caseId))
      .returning();
    await audit(tx, {
      entityId: caseId,
      action: "resolve",
      actorLabel,
      before: { status: "open" },
      after: { status: "resolved", outcome: input.outcome },
    });

    // Sibling open cases on the same animal end with the same outcome.
    if (caseRow.animalId) {
      const siblings = await tx
        .select()
        .from(lostFoundCases)
        .where(
          and(
            eq(lostFoundCases.animalId, caseRow.animalId),
            eq(lostFoundCases.status, "open"),
            sql`${lostFoundCases.id} <> ${caseId}`,
          ),
        )
        .for("update");
      for (const sib of siblings) {
        await tx
          .update(lostFoundCases)
          .set({
            status: "resolved",
            outcome: input.outcome,
            resolvedAt,
            resolvedBy: actorLabel,
            resolutionNote: note,
            updatedAt: resolvedAt,
          })
          .where(eq(lostFoundCases.id, sib.id));
        await insertUpdate(tx, {
          caseId: sib.id,
          kind: "update",
          note: `Resolved automatically — sibling case ${caseId} closed as ${LOST_FOUND_OUTCOME_LABELS[input.outcome]}.`,
          source: "staff",
          actorLabel,
        });
        await audit(tx, {
          entityId: sib.id,
          action: "resolve",
          actorLabel,
          before: { status: "open" },
          after: {
            status: "resolved",
            outcome: input.outcome,
            auto: `sibling of ${caseId}`,
          },
        });
      }
    }

    const [detail] = await tx
      .select(CASE_COLUMNS)
      .from(lostFoundCases)
      .leftJoin(animals, eq(lostFoundCases.animalId, animals.id))
      .where(eq(lostFoundCases.id, caseId))
      .limit(1);
    return { ok: true as const, case: toCaseDto(detail ?? row) };
  });

  // Post-commit owner notice — a ledger failure must never roll back
  // the resolution.
  if (result.ok && existing.animalId) {
    await queueCaseOwnerNotice(db, {
      animalId: existing.animalId,
      event: "resolved",
      caseId,
      outcome: input.outcome,
    });
  }
  return result;
}

// Cancel a case — it should never have existed (duplicate entry, false
// report, wrong animal). Never propagates to siblings: the OTHER open
// case on the animal may be perfectly real.
export async function cancelCase(
  caseId: string,
  input: { note?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  return db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(lostFoundCases)
      .where(eq(lostFoundCases.id, caseId))
      .for("update")
      .limit(1);
    if (!caseRow) return { ok: false as const, reason: "not-found" as const };
    if (caseRow.status !== "open") {
      return { ok: false as const, reason: "not-open" as const };
    }
    const [row] = await tx
      .update(lostFoundCases)
      .set({
        status: "cancelled",
        resolvedAt: new Date(),
        resolvedBy: actorLabel,
        outcome: null,
        resolutionNote: trimNote(input.note),
        updatedAt: new Date(),
      })
      .where(eq(lostFoundCases.id, caseId))
      .returning();
    await insertUpdate(tx, {
      caseId,
      kind: "update",
      note: `Case cancelled${trimNote(input.note) ? `: ${trimNote(input.note)}` : ""}`,
      source: "staff",
      actorLabel,
    });
    await audit(tx, {
      entityId: caseId,
      action: "cancel",
      actorLabel,
      before: { status: "open" },
      after: { status: "cancelled" },
    });
    return {
      ok: true as const,
      case: (await fetchCaseDto(tx, row.id)) ?? toCaseDto(row),
    };
  });
}

// Reopen a closed case (resolved by mistake, or the animal went missing
// again before the ink dried). Reopening clears the resolution fields —
// the chronology and audit rows keep the truth that it once closed.
// The unique open-case indexes may reject this: another case of the
// same type was opened meanwhile, which is a real conflict.
export async function reopenCase(
  caseId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  try {
    return await db.transaction(async (tx) => {
      const [caseRow] = await tx
        .select()
        .from(lostFoundCases)
        .where(eq(lostFoundCases.id, caseId))
        .for("update")
        .limit(1);
      if (!caseRow) return { ok: false as const, reason: "not-found" as const };
      if (caseRow.status === "open") {
        return { ok: false as const, reason: "conflict" as const };
      }
      const [row] = await tx
        .update(lostFoundCases)
        .set({
          status: "open",
          resolvedAt: null,
          resolvedBy: null,
          outcome: null,
          updatedAt: new Date(),
        })
        .where(eq(lostFoundCases.id, caseId))
        .returning();
      await insertUpdate(tx, {
        caseId,
        kind: "update",
        note: "Case reopened",
        source: "staff",
        actorLabel,
      });
      await audit(tx, {
        entityId: caseId,
        action: "reopen",
        actorLabel,
        before: { status: caseRow.status },
        after: { status: "open" },
      });
      return {
        ok: true as const,
        case: (await fetchCaseDto(tx, row.id)) ?? toCaseDto(row),
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { ok: false, reason: "has-open-case" };
  }
}

// Explicit staff opt-in to the public lost-pets listing — never implied
// by the case being open. Only a missing case with a linked animal can
// publish (the CHECK enforces the same). public_note is the approved
// public text; everything else the page shows comes off the animal row.
export async function publishCase(
  caseId: string,
  input: { publicNote?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  return db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(lostFoundCases)
      .where(eq(lostFoundCases.id, caseId))
      .for("update")
      .limit(1);
    if (!caseRow) return { ok: false as const, reason: "not-found" as const };
    if (caseRow.status !== "open") {
      return { ok: false as const, reason: "not-open" as const };
    }
    if (caseRow.caseType !== "missing" || !caseRow.animalId) {
      return { ok: false as const, reason: "invalid" as const, field: "caseType" };
    }
    const [row] = await tx
      .update(lostFoundCases)
      .set({
        publishedAt: caseRow.publishedAt ?? new Date(),
        publishedBy: caseRow.publishedBy ?? actorLabel,
        publicNote:
          input.publicNote !== undefined
            ? trimNote(input.publicNote)
            : caseRow.publicNote,
        updatedAt: new Date(),
      })
      .where(eq(lostFoundCases.id, caseId))
      .returning();
    await audit(tx, {
      entityId: caseId,
      action: "publish",
      actorLabel,
      after: { publishedAt: row.publishedAt, publicNote: row.publicNote },
    });
    return { ok: true as const, case: toCaseDto(row), existing: !!caseRow.publishedAt };
  });
}

export async function unpublishCase(
  caseId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LostFoundResult> {
  if (!UUID_RE.test(caseId)) return { ok: false, reason: "not-found" };
  return db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(lostFoundCases)
      .where(eq(lostFoundCases.id, caseId))
      .for("update")
      .limit(1);
    if (!caseRow) return { ok: false as const, reason: "not-found" as const };
    if (!caseRow.publishedAt) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const [row] = await tx
      .update(lostFoundCases)
      .set({ publishedAt: null, publishedBy: null, updatedAt: new Date() })
      .where(eq(lostFoundCases.id, caseId))
      .returning();
    await audit(tx, {
      entityId: caseId,
      action: "unpublish",
      actorLabel,
      before: { publishedAt: caseRow.publishedAt },
      after: { publishedAt: null },
    });
    return { ok: true as const, case: toCaseDto(row) };
  });
}

// Owner-portal missing report (#176). Deliberately NOT an
// owner-request-queue item: a missing report is low-risk information
// with no ambiguity to adjudicate, and the case itself is the
// staff-visible work item. Authorization is the same canonical check
// every portal mutation uses — getOwnedOwnership requires the
// ownership to be currently valid AND held by this person (directly or
// via household membership), so a former owner is denied even though
// their historical interval still exists. The reporter name/contact
// snapshot comes from the resolved person's registry record, never
// free-typed identity claims.
export async function reportMissingByOwner(
  input: {
    ownershipId: string;
    personId: string;
    reporterEmail: string | null;
    actorIdentity: string | null;
    lastSeenOn?: string | null;
    lastSeenLocation?: string | null;
    notes?: string | null;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<
  | { ok: true; caseId: string; animalId: string; existing?: boolean }
  | { ok: false; reason: "invalid" | "not-owner" | "not-found"; field?: string }
> {
  const owned = await getOwnedOwnership(
    input.ownershipId,
    input.personId,
    todayIsoDate(),
    db,
  );
  if (!owned) return { ok: false, reason: "not-owner" };

  const result = await openMissingCase(
    {
      animalId: owned.animalId,
      lastSeenOn: input.lastSeenOn,
      lastSeenLocation: input.lastSeenLocation,
      reporterName: owned.ownerName,
      reporterContact: input.reporterEmail,
      notes: input.notes,
      reportedVia: "owner-portal",
      actorIdentityId: input.actorIdentity,
    },
    owned.ownerName ?? "owner",
    db,
  );
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === "not-found" ? "not-found" : "invalid",
      field: result.field,
    };
  }
  return {
    ok: true,
    caseId: result.case.id,
    animalId: owned.animalId,
    existing: result.existing,
  };
}

// --- Owner notification ------------------------------------------------------

// The single notification seam: queue one communication-ledger row for
// the animal's resolved owner (#172 infrastructure — no second engine).
// Idempotency keys make re-links/retries safe; a skip resolves to a
// 'skipped' ledger row so the exception pipeline still sees it.
// Deliberately operational (not preference-suppressible): "your missing
// dog was scanned" is a notice the owner asked for by reporting.
async function queueCaseOwnerNotice(
  db: RegistryDb,
  input: {
    animalId: string;
    event: "found-match" | "resolved";
    caseId: string;
    outcome?: LostFoundOutcome;
  },
) {
  const resolved = await resolveAnimalOwner(
    input.animalId,
    todayIsoDate(),
    db,
  );
  const [animal] = await db
    .select({ name: animals.name })
    .from(animals)
    .where(eq(animals.id, input.animalId))
    .limit(1);
  const animalName = animal?.name ?? "your animal";
  const idempotencyKey = `lostfound:${input.caseId}:${input.event}`;

  if (resolved.status !== "ok") {
    await insertCommunication(
      {
        personId: null,
        animalId: input.animalId,
        channel: "email",
        kind: "lost-found-notice",
        status: "skipped",
        idempotencyKey,
        relatedType: "lost-found-case",
        relatedId: input.caseId,
        detail: resolved.detail,
      },
      db,
    );
    return;
  }
  if (!resolved.email) {
    await insertCommunication(
      {
        personId: resolved.personId,
        animalId: input.animalId,
        channel: "email",
        kind: "lost-found-notice",
        status: "skipped",
        idempotencyKey,
        relatedType: "lost-found-case",
        relatedId: input.caseId,
        detail: "missing-email",
      },
      db,
    );
    return;
  }

  const rendered = renderCaseNotice({
    ownerName: resolved.name,
    animalName,
    event: input.event,
    outcome: input.outcome,
    siteUrl: getSiteUrl(),
  });
  await insertCommunication(
    {
      personId: resolved.personId,
      animalId: input.animalId,
      channel: "email",
      kind: "lost-found-notice",
      status: "queued",
      idempotencyKey,
      relatedType: "lost-found-case",
      relatedId: input.caseId,
      recipient: resolved.email,
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
    },
    db,
  );
}

const LF_ORG =
  "Saba Foundation for the Prevention of Cruelty to Animals (SFPCA)";

function renderCaseNotice(ctx: {
  ownerName: string;
  animalName: string;
  event: "found-match" | "resolved";
  outcome?: LostFoundOutcome;
  siteUrl: string;
}): { subject: string; text: string; html: string } {
  const esc = (v: string) =>
    v
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const contactUrl = absoluteUrl("/contact", {
    NEXT_PUBLIC_SITE_URL: ctx.siteUrl,
  });

  const body =
    ctx.event === "found-match"
      ? `A found animal matching ${ctx.animalName} was scanned and linked to the registry. Please contact us as soon as you can so we can confirm it is ${ctx.animalName} and arrange a reunion:`
      : `The lost/found case for ${ctx.animalName} has been closed as "${LOST_FOUND_OUTCOME_LABELS[ctx.outcome ?? "other"]}". If this looks wrong or you have questions, please contact us:`;

  const subject =
    ctx.event === "found-match"
      ? `${ctx.animalName} may have been found`
      : `Update on ${ctx.animalName}'s lost/found case`;

  const text = [
    `Hello ${ctx.ownerName},`,
    ``,
    `${body}`,
    `${contactUrl}`,
    ``,
    `— ${LF_ORG}`,
  ].join("\n");
  const html = [
    `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:36rem">`,
    `<p style="margin:0 0 12px">Hello ${esc(ctx.ownerName)},</p>`,
    `<p style="margin:0 0 12px">${esc(body)} <a href="${esc(contactUrl)}">contact us</a>.</p>`,
    `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">— ${esc(LF_ORG)}</p>`,
    `</div>`,
  ].join("\n");
  return { subject, text, html };
}
