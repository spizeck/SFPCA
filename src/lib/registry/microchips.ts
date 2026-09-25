// Microchip registry service (#168) — THE write/lookup seam for chip
// identity. Route handlers and server actions call these functions;
// Drizzle never appears in UI code.
//
// Model (src/lib/db/schema.ts, evolved from the #165 scaffold):
//   - microchip_records rows are chip ASSIGNMENTS on an animal. An open
//     row (assigned_to NULL) is the animal's current chip; two partial
//     unique indexes enforce at most one current chip per animal and at
//     most one active assignment per normalized chip number.
//   - "Chip replaced / removed / wrongly recorded" CLOSES the row
//     (assigned_to + closed_reason) — history is never deleted, so a
//     scan of a superseded chip still reaches the animal. A metadata or
//     number typo is corrected in place by correctMicrochip and never
//     manufactures a replacement event.
//   - chip_number is normalized by the canonical normalizeChipNumber
//     (src/lib/microchips.ts) — every write, lookup, and the registry
//     search share the same semantics; chip_display keeps the
//     as-entered representation.
//   - Duplicate chip claims never overwrite: the attempt is rejected
//     AND recorded as a microchip_conflicts row for human resolution
//     (#178 owns the generic merge engine; this stays chip-scoped).
//   - found_reports is the small found-animal resolution log — durable
//     evidence that a scan happened and how staff resolved it. It is
//     deliberately not #176's lost/found case management.
//
// Every mutation commits with its audit_events row in one transaction,
// same as the other registry services.

import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  foundReports,
  householdMembers,
  households,
  microchipConflicts,
  microchipRecords,
  persons,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  chipDisplayValue,
  chipNumberProblem,
  isValidChipNumber,
  normalizeChipNumber,
} from "../microchips";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import { listCurrentOwnerships } from "./ownership";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_FIELD = 200;
const MAX_NOTE = 2000;

// A read/write handle — the db itself or a transaction inside it
// (matches the Queryable/Tx pattern in medical.ts / ownership.ts).
type Queryable = Pick<RegistryDb, "select">;

// --- DTOs ---------------------------------------------------------------------

export interface MicrochipRecord {
  id: string;
  animalId: string;
  // Normalized lookup form (uppercase A–Z0–9) — the indexed key.
  chipNumber: string;
  // As-entered display form; falls back to chipNumber for pre-#168 rows.
  chipDisplay: string;
  manufacturer: string | null;
  implantedOn: string | null;
  implantedBy: string | null;
  notes: string | null;
  // Currency interval on the animal — NULL assignedTo = current chip.
  assignedFrom: string;
  assignedTo: string | null;
  // Why the chip left use: 'replaced' | 'removed' | 'corrected'.
  closedReason: string | null;
  replacedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChipConflictRecord {
  id: string;
  chipNumber: string;
  claimedAnimalId: string;
  claimedAnimalName: string | null;
  existingRecordId: string | null;
  existingAnimalId: string | null;
  existingAnimalName: string | null;
  source: string;
  detail: string | null;
  status: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface FoundReportRecord {
  id: string;
  animalId: string | null;
  microchipRecordId: string | null;
  chipNumber: string;
  chipDisplay: string | null;
  reportedOn: string;
  status: string;
  resolvedOn: string | null;
  outcome: string | null;
  notes: string | null;
  actorLabel: string | null;
  createdAt: string;
}

export const CHIP_CLOSE_REASONS = ["replaced", "removed", "corrected"] as const;
export const FOUND_OUTCOMES = ["reunited", "in-care", "other"] as const;

const CHIP_COLUMNS = {
  id: microchipRecords.id,
  animalId: microchipRecords.animalId,
  chipNumber: microchipRecords.chipNumber,
  chipDisplay: microchipRecords.chipDisplay,
  manufacturer: microchipRecords.manufacturer,
  implantedOn: microchipRecords.implantedOn,
  implantedBy: microchipRecords.implantedBy,
  notes: microchipRecords.notes,
  assignedFrom: microchipRecords.assignedFrom,
  assignedTo: microchipRecords.assignedTo,
  closedReason: microchipRecords.closedReason,
  replacedById: microchipRecords.replacedById,
  createdAt: microchipRecords.createdAt,
  updatedAt: microchipRecords.updatedAt,
} as const;

type ChipRow = typeof microchipRecords.$inferSelect;

export function toMicrochipDto(row: ChipRow): MicrochipRecord {
  return {
    ...row,
    chipDisplay: row.chipDisplay ?? row.chipNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toConflictDto(row: {
  id: string;
  chipNumber: string;
  claimedAnimalId: string;
  claimedAnimalName: string | null;
  existingRecordId: string | null;
  existingAnimalId: string | null;
  existingAnimalName: string | null;
  source: string;
  detail: string | null;
  status: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: Date;
}): ChipConflictRecord {
  return {
    ...row,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFoundReportDto(row: typeof foundReports.$inferSelect): FoundReportRecord {
  return {
    id: row.id,
    animalId: row.animalId,
    microchipRecordId: row.microchipRecordId,
    chipNumber: row.chipNumber,
    chipDisplay: row.chipDisplay,
    reportedOn: row.reportedOn,
    status: row.status,
    resolvedOn: row.resolvedOn,
    outcome: row.outcome,
    notes: row.notes,
    actorLabel: row.actorLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Validation -----------------------------------------------------------------

export interface MicrochipWriteInput {
  // Raw scanner/manual input — normalized inside the service; never
  // pre-normalized by callers (that would split the semantics).
  chipNumber: string;
  manufacturer?: string | null;
  implantedOn?: string | null;
  implantedBy?: string | null;
  notes?: string | null;
}

export function validateMicrochipInput(
  input: MicrochipWriteInput,
): string | null {
  const normalized = normalizeChipNumber(input.chipNumber);
  if (!isValidChipNumber(normalized)) return "chipNumber";
  const implantedOn = input.implantedOn?.trim() || null;
  if (implantedOn !== null && !isIsoDateString(implantedOn)) {
    return "implantedOn";
  }
  for (const [field, value] of [
    ["manufacturer", input.manufacturer],
    ["implantedBy", input.implantedBy],
  ] as const) {
    if (value != null && value.length > MAX_FIELD) return field;
  }
  if (input.notes != null && input.notes.length > MAX_NOTE) return "notes";
  return null;
}

function writeValues(input: MicrochipWriteInput) {
  const normalized = normalizeChipNumber(input.chipNumber);
  return {
    chipNumber: normalized,
    chipDisplay: chipDisplayValue(input.chipNumber, normalized),
    manufacturer: input.manufacturer?.trim() || null,
    implantedOn: input.implantedOn?.trim() || null,
    implantedBy: input.implantedBy?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

// --- Result shapes ---------------------------------------------------------------

// What a rejected duplicate claim leaves behind for humans: the flagged
// conflict row plus WHO currently holds the number.
export interface ChipConflictInfo {
  conflictId: string;
  chipNumber: string;
  holderRecordId: string;
  holderAnimalId: string;
  holderAnimalName: string;
  holderRegistryRef: string;
}

export type ChipMutationResult =
  | { ok: true; record: MicrochipRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "invalid"
        | "conflict"
        | "has-current"
        | "chip-conflict";
      field?: string;
      current?: MicrochipRecord;
      chipConflict?: ChipConflictInfo;
    };

// --- Internal helpers -----------------------------------------------------------

// The active assignment holding a normalized chip number, with the
// holder animal's display identity — the evidence a conflict UI needs.
async function activeChipHolder(
  tx: Queryable,
  chipNumber: string,
) {
  const [row] = await tx
    .select({
      id: microchipRecords.id,
      animalId: microchipRecords.animalId,
      animalName: animals.name,
      registryRef: animals.registryRef,
    })
    .from(microchipRecords)
    .innerJoin(animals, eq(microchipRecords.animalId, animals.id))
    .where(
      and(
        eq(microchipRecords.chipNumber, chipNumber),
        isNull(microchipRecords.assignedTo),
      ),
    );
  return row ?? null;
}

// Flag a rejected duplicate claim for human resolution. One open
// conflict per (chip, claimant) — a repeat attempt re-flags the same
// work item rather than stacking rows. Returns the conflict + holder
// evidence for the error path.
async function flagChipConflict(
  tx: Queryable & Pick<RegistryDb, "insert">,
  {
    chipNumber,
    claimedAnimalId,
    source,
    detail,
    actorLabel,
  }: {
    chipNumber: string;
    claimedAnimalId: string;
    source: "staff" | "import";
    detail?: string | null;
    actorLabel: string;
  },
): Promise<ChipConflictInfo | null> {
  const holder = await activeChipHolder(tx, chipNumber);
  if (!holder) return null;

  const [existing] = await tx
    .select({ id: microchipConflicts.id })
    .from(microchipConflicts)
    .where(
      and(
        eq(microchipConflicts.chipNumber, chipNumber),
        eq(microchipConflicts.claimedAnimalId, claimedAnimalId),
        eq(microchipConflicts.status, "open"),
      ),
    )
    .limit(1);

  let conflictId = existing?.id;
  if (!conflictId) {
    const [row] = await tx
      .insert(microchipConflicts)
      .values({
        chipNumber,
        claimedAnimalId,
        existingRecordId: holder.id,
        existingAnimalId: holder.animalId,
        source,
        detail: detail?.trim() || null,
      })
      .returning();
    conflictId = row.id;
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip_conflict",
      entityId: conflictId,
      action: "flag",
      after: {
        chipNumber,
        claimedAnimalId,
        existingAnimalId: holder.animalId,
        source,
      },
    });
  }

  return {
    conflictId,
    chipNumber,
    holderRecordId: holder.id,
    holderAnimalId: holder.animalId,
    holderAnimalName: holder.animalName,
    holderRegistryRef: holder.registryRef,
  };
}

// --- Reads ---------------------------------------------------------------------

// All chip records for an animal — current first, then newest currency
// first. Both open and closed rows are history; nothing is filtered out.
export async function listMicrochipsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MicrochipRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(CHIP_COLUMNS)
    .from(microchipRecords)
    .where(eq(microchipRecords.animalId, animalId))
    .orderBy(
      asc(sql`(${microchipRecords.assignedTo} IS NOT NULL)`),
      desc(microchipRecords.assignedFrom),
      desc(microchipRecords.createdAt),
    );
  return rows.map(toMicrochipDto);
}

export async function getCurrentMicrochip(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<MicrochipRecord | null> {
  if (!UUID_RE.test(animalId)) return null;
  const [row] = await db
    .select(CHIP_COLUMNS)
    .from(microchipRecords)
    .where(
      and(
        eq(microchipRecords.animalId, animalId),
        isNull(microchipRecords.assignedTo),
      ),
    )
    .limit(1);
  return row ? toMicrochipDto(row) : null;
}

const CONFLICT_COLUMNS = {
  id: microchipConflicts.id,
  chipNumber: microchipConflicts.chipNumber,
  claimedAnimalId: microchipConflicts.claimedAnimalId,
  claimedAnimalName: animals.name,
  existingRecordId: microchipConflicts.existingRecordId,
  existingAnimalId: microchipConflicts.existingAnimalId,
  source: microchipConflicts.source,
  detail: microchipConflicts.detail,
  status: microchipConflicts.status,
  resolvedAt: microchipConflicts.resolvedAt,
  resolvedBy: microchipConflicts.resolvedBy,
  resolutionNote: microchipConflicts.resolutionNote,
  createdAt: microchipConflicts.createdAt,
} as const;

// Chip conflicts for staff surfaces. animalId filters to conflicts the
// animal is a party to (either side); status defaults to open-only.
export async function listChipConflicts(
  {
    animalId,
    status = "open",
  }: { animalId?: string; status?: "open" | "resolved" | "all" } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<ChipConflictRecord[]> {
  const conditions = [
    status === "all" ? undefined : eq(microchipConflicts.status, status),
    animalId && UUID_RE.test(animalId)
      ? sql`(${microchipConflicts.claimedAnimalId} = ${animalId} OR ${microchipConflicts.existingAnimalId} = ${animalId})`
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const claimedAnimal = animals;
  const rows = await db
    .select({
      ...CONFLICT_COLUMNS,
    })
    .from(microchipConflicts)
    .leftJoin(claimedAnimal, eq(microchipConflicts.claimedAnimalId, claimedAnimal.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(microchipConflicts.createdAt));

  // Resolve the holder side's display name in a second pass (its animal
  // may differ from the claimant).
  const holderIds = [
    ...new Set(rows.map((r) => r.existingAnimalId).filter(Boolean)),
  ] as string[];
  const holderNames = new Map<string, string>();
  if (holderIds.length) {
    const holderRows = await db
      .select({ id: animals.id, name: animals.name })
      .from(animals)
      .where(inArray(animals.id, holderIds));
    for (const r of holderRows) holderNames.set(r.id, r.name);
  }

  return rows.map((r) =>
    toConflictDto({
      ...r,
      existingAnimalName: r.existingAnimalId
        ? (holderNames.get(r.existingAnimalId) ?? null)
        : null,
    }),
  );
}

// --- Writes --------------------------------------------------------------------

// Record a chip as the animal's CURRENT chip. Rejects cleanly when the
// animal already has one (staff should use replaceMicrochip — an
// implicit second-current would violate the invariant) or when the chip
// number is already active elsewhere (a conflict is flagged for human
// resolution — the write NEVER moves or overwrites the other animal's
// record).
export async function assignMicrochip(
  input: MicrochipWriteInput & { animalId: string; assignedFrom?: string },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ChipMutationResult> {
  const invalidField = validateMicrochipInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  if (!UUID_RE.test(input.animalId)) return { ok: false, reason: "not-found" };
  const assignedFrom = input.assignedFrom?.trim() || todayIsoDate();
  if (!isIsoDateString(assignedFrom)) {
    return { ok: false, reason: "invalid", field: "assignedFrom" };
  }
  const normalized = normalizeChipNumber(input.chipNumber);

  return db.transaction(async (tx) => {
    const [animal] = await tx
      .select({ id: animals.id })
      .from(animals)
      .where(eq(animals.id, input.animalId));
    if (!animal) return { ok: false as const, reason: "not-found" as const };

    const [current] = await tx
      .select(CHIP_COLUMNS)
      .from(microchipRecords)
      .where(
        and(
          eq(microchipRecords.animalId, input.animalId),
          isNull(microchipRecords.assignedTo),
        ),
      )
      .for("update");
    if (current) {
      return {
        ok: false as const,
        reason: "has-current" as const,
        current: toMicrochipDto(current),
      };
    }

    const conflict = await flagChipConflict(tx, {
      chipNumber: normalized,
      claimedAnimalId: input.animalId,
      source: "staff",
      actorLabel,
    });
    if (conflict) {
      return { ok: false as const, reason: "chip-conflict" as const, chipConflict: conflict };
    }

    const [row] = await tx
      .insert(microchipRecords)
      .values({ ...writeValues(input), animalId: input.animalId, assignedFrom })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip",
      entityId: row.id,
      action: "assign",
      after: {
        animalId: row.animalId,
        chipNumber: row.chipNumber,
        assignedFrom: row.assignedFrom,
      },
    });
    return { ok: true, record: toMicrochipDto(row) };
  });
}

// Chip replacement — close the current record AND open the successor in
// ONE transaction (mirrors transferOwnership): the registry never has a
// gap where the animal has no chip nor a moment with two current chips.
// The old row keeps 'replaced' + replaced_by_id so the history reads as
// a chain, not a disappearance.
export async function replaceMicrochip(
  currentRecordId: string,
  input: MicrochipWriteInput & { effectiveOn?: string },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ChipMutationResult> {
  const invalidField = validateMicrochipInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  if (!UUID_RE.test(currentRecordId)) return { ok: false, reason: "not-found" };
  const effectiveOn = input.effectiveOn?.trim() || todayIsoDate();
  if (!isIsoDateString(effectiveOn)) {
    return { ok: false, reason: "invalid", field: "effectiveOn" };
  }
  const normalized = normalizeChipNumber(input.chipNumber);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(CHIP_COLUMNS)
      .from(microchipRecords)
      .where(eq(microchipRecords.id, currentRecordId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.assignedTo !== null) {
      // Already closed — replacing a historical row is a conflict,
      // not a rewrite.
      return { ok: false as const, reason: "conflict" as const };
    }
    if (normalized === before.chipNumber) {
      // Same number is not a replacement — a no-op must not fabricate
      // history. Correct the row in place instead.
      return { ok: false as const, reason: "invalid" as const, field: "chipNumber" };
    }
    if (effectiveOn < before.assignedFrom) {
      return { ok: false as const, reason: "invalid" as const, field: "effectiveOn" };
    }

    const conflict = await flagChipConflict(tx, {
      chipNumber: normalized,
      claimedAnimalId: before.animalId,
      source: "staff",
      actorLabel,
    });
    if (conflict) {
      return { ok: false as const, reason: "chip-conflict" as const, chipConflict: conflict };
    }

    // Close first — the per-animal current-chip unique index requires
    // the old row closed before the successor can be inserted.
    await tx
      .update(microchipRecords)
      .set({
        assignedTo: effectiveOn,
        closedReason: "replaced",
        updatedAt: new Date(),
      })
      .where(eq(microchipRecords.id, currentRecordId));
    const [row] = await tx
      .insert(microchipRecords)
      .values({
        ...writeValues(input),
        animalId: before.animalId,
        assignedFrom: effectiveOn,
      })
      .returning();
    await tx
      .update(microchipRecords)
      .set({ replacedById: row.id })
      .where(eq(microchipRecords.id, currentRecordId));

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip",
      entityId: row.id,
      action: "replace",
      before: {
        recordId: before.id,
        animalId: before.animalId,
        chipNumber: before.chipNumber,
      },
      after: {
        recordId: row.id,
        animalId: row.animalId,
        chipNumber: row.chipNumber,
        closedAssignedTo: effectiveOn,
      },
    });
    return { ok: true, record: toMicrochipDto(row) };
  });
}

// Close a current chip with NO successor: the chip physically left use
// ('removed') or the record itself was wrong ('corrected' — the chip
// never belonged to this animal; the right fix for a mistaken
// assignment, distinct from a replacement). The row stays as history.
export async function closeMicrochip(
  recordId: string,
  {
    assignedTo,
    reason,
  }: { assignedTo?: string; reason: "removed" | "corrected" },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ChipMutationResult> {
  if (!UUID_RE.test(recordId)) return { ok: false, reason: "not-found" };
  if (reason !== "removed" && reason !== "corrected") {
    return { ok: false, reason: "invalid", field: "reason" };
  }
  const effectiveOn = assignedTo?.trim() || todayIsoDate();
  if (!isIsoDateString(effectiveOn)) {
    return { ok: false, reason: "invalid", field: "assignedTo" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(CHIP_COLUMNS)
      .from(microchipRecords)
      .where(eq(microchipRecords.id, recordId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.assignedTo !== null) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (effectiveOn < before.assignedFrom) {
      return { ok: false as const, reason: "invalid" as const, field: "assignedTo" };
    }

    const [row] = await tx
      .update(microchipRecords)
      .set({
        assignedTo: effectiveOn,
        closedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(microchipRecords.id, recordId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip",
      entityId: recordId,
      action: "close",
      before: {
        animalId: before.animalId,
        chipNumber: before.chipNumber,
        assignedFrom: before.assignedFrom,
      },
      after: { assignedTo: effectiveOn, closedReason: reason },
    });
    return { ok: true, record: toMicrochipDto(row) };
  });
}

// In-place correction of a record that was never right — wrong number,
// wrong dates, wrong metadata. History-preserving changes go through
// replace/close; this path exists for fixing bad data and never
// fabricates a replacement event. Guarded by the created_at token the
// caller rendered (same convention as correctOwnership).
export async function correctMicrochip(
  recordId: string,
  input: MicrochipWriteInput & { assignedFrom?: string },
  expectedCreatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ChipMutationResult> {
  const invalidField = validateMicrochipInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  if (!UUID_RE.test(recordId)) return { ok: false, reason: "not-found" };
  const assignedFrom = input.assignedFrom?.trim();
  if (assignedFrom != null && !isIsoDateString(assignedFrom)) {
    return { ok: false, reason: "invalid", field: "assignedFrom" };
  }
  const expectedMs = new Date(expectedCreatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };
  const normalized = normalizeChipNumber(input.chipNumber);

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(CHIP_COLUMNS)
      .from(microchipRecords)
      .where(eq(microchipRecords.id, recordId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.createdAt.getTime() !== expectedMs) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const nextAssignedFrom = assignedFrom ?? before.assignedFrom;
    if (before.assignedTo !== null && nextAssignedFrom > before.assignedTo) {
      return { ok: false as const, reason: "invalid" as const, field: "assignedFrom" };
    }

    // A number change on an ACTIVE record must not collide with another
    // animal's current chip — same protection as a fresh assignment.
    if (normalized !== before.chipNumber && before.assignedTo === null) {
      const conflict = await flagChipConflict(tx, {
        chipNumber: normalized,
        claimedAnimalId: before.animalId,
        source: "staff",
        actorLabel,
      });
      if (conflict) {
        return { ok: false as const, reason: "chip-conflict" as const, chipConflict: conflict };
      }
    }

    const [row] = await tx
      .update(microchipRecords)
      .set({
        ...writeValues(input),
        assignedFrom: nextAssignedFrom,
        updatedAt: new Date(),
      })
      .where(eq(microchipRecords.id, recordId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip",
      entityId: recordId,
      action: "correct",
      before: {
        chipNumber: before.chipNumber,
        chipDisplay: before.chipDisplay,
        assignedFrom: before.assignedFrom,
        manufacturer: before.manufacturer,
        implantedOn: before.implantedOn,
        implantedBy: before.implantedBy,
      },
      after: {
        chipNumber: row.chipNumber,
        chipDisplay: row.chipDisplay,
        assignedFrom: row.assignedFrom,
        manufacturer: row.manufacturer,
        implantedOn: row.implantedOn,
        implantedBy: row.implantedBy,
      },
    });
    return { ok: true, record: toMicrochipDto(row) };
  });
}

// --- Chip-identity conflicts -----------------------------------------------------

export type ConflictMutationResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "conflict" };

// Human resolution of a flagged duplicate — marks the work item done.
// Resolution NEVER changes chip data itself; staff fix the underlying
// records through the normal mutation paths.
export async function resolveChipConflict(
  conflictId: string,
  { resolutionNote }: { resolutionNote?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ConflictMutationResult> {
  if (!UUID_RE.test(conflictId)) return { ok: false, reason: "not-found" };
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(microchipConflicts)
      .where(eq(microchipConflicts.id, conflictId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.status !== "open") {
      return { ok: false as const, reason: "conflict" as const };
    }
    await tx
      .update(microchipConflicts)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: actorLabel,
        resolutionNote: resolutionNote?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(microchipConflicts.id, conflictId));
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "microchip_conflict",
      entityId: conflictId,
      action: "resolve",
      before: { status: before.status, chipNumber: before.chipNumber },
      after: { status: "resolved" },
    });
    return { ok: true as const };
  });
}

// --- Fast staff lookup ----------------------------------------------------------

// The owner/contact block of a found-animal result. owners comes from
// the CANONICAL current-ownership projection (listCurrentOwnerships —
// the same "current owner" every other surface uses); this module only
// resolves the contact details staff need to reach them.
export interface FoundOwnerContact {
  personId: string;
  name: string;
  // Household member role when the contact is reached through a
  // household ownership ('primary' shown first).
  role: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  preferredChannel: string | null;
}

export interface ChipLookupOwner {
  ownershipId: string;
  kind: "person" | "household";
  // Display name of the owning party (person fullName / household name).
  name: string;
  householdAddress: string | null;
  contacts: FoundOwnerContact[];
}

export interface ChipLookupAnimal {
  id: string;
  name: string;
  registryRef: string;
  species: string;
  sex: string;
  birthDate: string | null;
  birthDateEstimated: boolean;
  identifyingNotes: string | null;
  lifecycleStatus: string;
  lifecycleEffectiveOn: string | null;
  photoUrl: string | null;
}

// Every row carrying the scanned number — more than one animal means
// the chip number is disputed data and the result must say so.
export interface ChipLookupMatch {
  record: MicrochipRecord;
  animalId: string;
  animalName: string;
  registryRef: string;
}

export type ChipLookupResult =
  | { status: "invalid"; normalized: string }
  | { status: "not-found"; normalized: string; display: string }
  // Transient failure (e.g. database unreachable) — retryable, and
  // distinct from 'invalid' so the UI doesn't blame the scan.
  | { status: "error" }
  | {
      status: "match";
      normalized: string;
      // The record the scan matched (active preferred, else most recent
      // closed) and whether it is still the animal's current chip.
      chip: MicrochipRecord;
      // The animal's CURRENT chip — a different record than `chip` when
      // the scanned chip was replaced/removed.
      currentChip: MicrochipRecord | null;
      animal: ChipLookupAnimal;
      matches: ChipLookupMatch[];
      owners: ChipLookupOwner[];
      // More than one currently-valid ownership — staff must verify
      // rather than guess who to call (canonical ambiguity rule).
      ownershipAmbiguous: boolean;
      openConflicts: ChipConflictRecord[];
      openFoundReports: FoundReportRecord[];
    };

// THE found-animal lookup: exact normalized match against active AND
// historical chip records (a replaced chip still identifies the animal).
// Lifecycle is deliberately NOT filtered — a scan of a deceased or
// off-island animal still returns the record; the caller renders the
// discrepancy so stale registry state surfaces for human review.
export async function lookupChip(
  rawInput: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ChipLookupResult> {
  const normalized = normalizeChipNumber(rawInput);
  if (!isValidChipNumber(normalized)) {
    return { status: "invalid", normalized };
  }

  // Exact match on the normalized column — served by
  // microchip_chip_number_idx (btree), not a registry scan.
  const rows = await db
    .select({
      record: microchipRecords,
      animalName: animals.name,
      registryRef: animals.registryRef,
    })
    .from(microchipRecords)
    .innerJoin(animals, eq(microchipRecords.animalId, animals.id))
    .where(eq(microchipRecords.chipNumber, normalized))
    // Active assignment first — when the number is clean there is at
    // most one; historical rows follow newest-first.
    .orderBy(
      asc(sql`(${microchipRecords.assignedTo} IS NOT NULL)`),
      desc(microchipRecords.assignedFrom),
      desc(microchipRecords.createdAt),
    );

  if (rows.length === 0) {
    return {
      status: "not-found",
      normalized,
      display: chipDisplayValue(rawInput, normalized),
    };
  }

  const primary = rows[0];
  const [animal] = await db
    .select({
      id: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      species: animals.species,
      sex: animals.sex,
      birthDate: animals.birthDate,
      birthDateEstimated: animals.birthDateEstimated,
      identifyingNotes: animals.identifyingNotes,
      lifecycleStatus: animals.lifecycleStatus,
      lifecycleEffectiveOn: animals.lifecycleEffectiveOn,
      photoUrls: animals.photoUrls,
    })
    .from(animals)
    .where(eq(animals.id, primary.record.animalId));

  const today = todayIsoDate();
  const [currentChipRow, ownerInfo, conflicts, openReports] = await Promise.all([
    db
      .select(CHIP_COLUMNS)
      .from(microchipRecords)
      .where(
        and(
          eq(microchipRecords.animalId, primary.record.animalId),
          isNull(microchipRecords.assignedTo),
        ),
      )
      .limit(1),
    // Owners resolve through the canonical projection — never a
    // second definition of "current owner".
    listCurrentOwnerships(primary.record.animalId, today, db).then(
      (current) => foundAnimalOwners(db, current),
    ),
    db
      .select(CONFLICT_COLUMNS)
      .from(microchipConflicts)
      .leftJoin(animals, eq(microchipConflicts.claimedAnimalId, animals.id))
      .where(
        and(
          eq(microchipConflicts.chipNumber, normalized),
          eq(microchipConflicts.status, "open"),
        ),
      )
      .orderBy(desc(microchipConflicts.createdAt)),
    db
      .select()
      .from(foundReports)
      .where(
        and(
          eq(foundReports.status, "open"),
          sql`(${foundReports.animalId} = ${primary.record.animalId} OR ${foundReports.chipNumber} = ${normalized})`,
        ),
      )
      .orderBy(asc(foundReports.reportedOn)),
  ]);

  const holderNames = new Map<string, string>();
  const holderIds = [
    ...new Set(conflicts.map((c) => c.existingAnimalId).filter(Boolean)),
  ] as string[];
  if (holderIds.length) {
    const holderRows = await db
      .select({ id: animals.id, name: animals.name })
      .from(animals)
      .where(inArray(animals.id, holderIds));
    for (const r of holderRows) holderNames.set(r.id, r.name);
  }

  return {
    status: "match",
    normalized,
    chip: toMicrochipDto(primary.record),
    currentChip: currentChipRow[0] ? toMicrochipDto(currentChipRow[0]) : null,
    animal: {
      id: animal!.id,
      name: animal!.name,
      registryRef: animal!.registryRef,
      species: animal!.species,
      sex: animal!.sex,
      birthDate: animal!.birthDate,
      birthDateEstimated: animal!.birthDateEstimated,
      identifyingNotes: animal!.identifyingNotes,
      lifecycleStatus: animal!.lifecycleStatus,
      lifecycleEffectiveOn: animal!.lifecycleEffectiveOn,
      photoUrl: animal!.photoUrls?.[0] ?? null,
    },
    matches: rows.map((r) => ({
      record: toMicrochipDto(r.record),
      animalId: r.record.animalId,
      animalName: r.animalName,
      registryRef: r.registryRef,
    })),
    owners: ownerInfo.owners,
    ownershipAmbiguous: ownerInfo.ambiguous,
    openConflicts: conflicts.map((c) =>
      toConflictDto({
        ...c,
        existingAnimalName: c.existingAnimalId
          ? (holderNames.get(c.existingAnimalId) ?? null)
          : null,
      }),
    ),
    openFoundReports: openReports.map(toFoundReportDto),
  };
}

// Owner contacts for the found-animal result. WHO is current comes
// from the canonical listCurrentOwnerships projection; this resolves
// HOW to reach them — person-side owners directly, household ownerships
// through their members (primary first, same deterministic order as
// householdContactFor).
async function foundAnimalOwners(
  db: RegistryDb,
  current: Awaited<ReturnType<typeof listCurrentOwnerships>>,
): Promise<{ owners: ChipLookupOwner[]; ambiguous: boolean }> {
  const owners: ChipLookupOwner[] = [];
  for (const o of current) {
    if (o.personId) {
      const [person] = await db
        .select()
        .from(persons)
        .where(eq(persons.id, o.personId));
      owners.push({
        ownershipId: o.id,
        kind: "person",
        name: o.ownerName,
        householdAddress: null,
        contacts: person
          ? [
              {
                personId: person.id,
                name: person.fullName,
                role: null,
                phone: person.phone,
                email: person.email,
                address: person.address,
                preferredChannel: person.preferredChannel,
              },
            ]
          : [],
      });
    } else if (o.householdId) {
      const [household] = await db
        .select()
        .from(households)
        .where(eq(households.id, o.householdId));
      const memberRows = await db
        .select({
          personId: persons.id,
          name: persons.fullName,
          phone: persons.phone,
          email: persons.email,
          address: persons.address,
          preferredChannel: persons.preferredChannel,
          role: householdMembers.role,
          memberSince: householdMembers.createdAt,
        })
        .from(householdMembers)
        .innerJoin(persons, eq(householdMembers.personId, persons.id))
        .where(eq(householdMembers.householdId, o.householdId));
      memberRows.sort((a, b) => {
        if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
        return a.memberSince.getTime() - b.memberSince.getTime();
      });
      owners.push({
        ownershipId: o.id,
        kind: "household",
        name: o.ownerName,
        householdAddress: household?.address ?? null,
        contacts: memberRows.map((m) => ({
          personId: m.personId,
          name: m.name,
          role: m.role,
          phone: m.phone,
          email: m.email,
          address: m.address,
          preferredChannel: m.preferredChannel,
        })),
      });
    }
  }
  return { owners, ambiguous: current.length > 1 };
}

// --- Found reports ---------------------------------------------------------------

export type FoundReportResult =
  | { ok: true; report: FoundReportRecord; existing?: boolean }
  | { ok: false; reason: "not-found" | "invalid" | "conflict"; field?: string };

// Log that an animal was found via a chip scan. Open rows dedupe per
// (chip, animal) — a second scan of the same animal re-flags the same
// work item instead of stacking duplicates. outcome may be supplied to
// write an already-resolved row ("scanned, called owner, going home").
export async function recordFoundReport(
  {
    animalId,
    microchipRecordId,
    chipNumber,
    notes,
    outcome,
    reportedOn,
    actorIdentityId,
  }: {
    animalId?: string | null;
    microchipRecordId?: string | null;
    chipNumber: string;
    notes?: string | null;
    outcome?: string | null;
    reportedOn?: string;
    actorIdentityId?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<FoundReportResult> {
  const normalized = normalizeChipNumber(chipNumber);
  if (chipNumberProblem(normalized)) {
    return { ok: false, reason: "invalid", field: "chipNumber" };
  }
  if (animalId != null && !UUID_RE.test(animalId)) {
    return { ok: false, reason: "invalid", field: "animalId" };
  }
  if (microchipRecordId != null && !UUID_RE.test(microchipRecordId)) {
    return { ok: false, reason: "invalid", field: "microchipRecordId" };
  }
  const resolved = outcome != null && outcome !== "";
  if (resolved && !(FOUND_OUTCOMES as readonly string[]).includes(outcome!)) {
    return { ok: false, reason: "invalid", field: "outcome" };
  }
  const on = reportedOn?.trim() || todayIsoDate();
  if (!isIsoDateString(on)) {
    return { ok: false, reason: "invalid", field: "reportedOn" };
  }
  if (notes != null && notes.length > MAX_NOTE) {
    return { ok: false, reason: "invalid", field: "notes" };
  }

  return db.transaction(async (tx) => {
    if (animalId) {
      const [animal] = await tx
        .select({ id: animals.id })
        .from(animals)
        .where(eq(animals.id, animalId));
      if (!animal) return { ok: false as const, reason: "not-found" as const };
    }

    if (!resolved) {
      // Reuse the open report for the same chip+animal if one exists —
      // re-scanning is a bump of the same work item, not a duplicate.
      const [existing] = await tx
        .select()
        .from(foundReports)
        .where(
          and(
            eq(foundReports.status, "open"),
            eq(foundReports.chipNumber, normalized),
            animalId
              ? eq(foundReports.animalId, animalId)
              : isNull(foundReports.animalId),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          ok: true as const,
          report: toFoundReportDto(existing),
          existing: true as const,
        };
      }
    }

    const [row] = await tx
      .insert(foundReports)
      .values({
        animalId: animalId ?? null,
        microchipRecordId: microchipRecordId ?? null,
        chipNumber: normalized,
        chipDisplay: chipDisplayValue(chipNumber, normalized),
        reportedOn: on,
        status: resolved ? "resolved" : "open",
        resolvedOn: resolved ? on : null,
        outcome: resolved ? outcome! : null,
        notes: notes?.trim() || null,
        actorIdentityId: actorIdentityId ?? null,
        actorLabel,
      })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "found_report",
      entityId: row.id,
      action: "create",
      after: {
        animalId: row.animalId,
        chipNumber: row.chipNumber,
        status: row.status,
        outcome: row.outcome,
      },
    });
    return { ok: true, report: toFoundReportDto(row) };
  });
}

// Resolve an open found report — staff record how the animal's story
// ended. The row is updated in place exactly once; it is never deleted.
export async function resolveFoundReport(
  reportId: string,
  {
    outcome,
    resolvedOn,
    notes,
  }: { outcome: string; resolvedOn?: string; notes?: string | null },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<FoundReportResult> {
  if (!UUID_RE.test(reportId)) return { ok: false, reason: "not-found" };
  if (!(FOUND_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, reason: "invalid", field: "outcome" };
  }
  const on = resolvedOn?.trim() || todayIsoDate();
  if (!isIsoDateString(on)) {
    return { ok: false, reason: "invalid", field: "resolvedOn" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(foundReports)
      .where(eq(foundReports.id, reportId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.status !== "open") {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (on < before.reportedOn) {
      return { ok: false as const, reason: "invalid" as const, field: "resolvedOn" };
    }

    const [row] = await tx
      .update(foundReports)
      .set({
        status: "resolved",
        resolvedOn: on,
        outcome,
        notes: notes?.trim() || before.notes,
        updatedAt: new Date(),
      })
      .where(eq(foundReports.id, reportId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "found_report",
      entityId: reportId,
      action: "resolve",
      before: { status: before.status },
      after: { status: "resolved", outcome, resolvedOn: on },
    });
    return { ok: true, report: toFoundReportDto(row) };
  });
}

// Found-report history for one animal — the profile's record of "was
// this animal ever scanned/found". Open items first, then newest.
export async function listFoundReportsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<FoundReportRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select()
    .from(foundReports)
    .where(eq(foundReports.animalId, animalId))
    .orderBy(
      desc(sql`(${foundReports.status} = 'open')`),
      desc(foundReports.reportedOn),
      desc(foundReports.createdAt),
    );
  return rows.map(toFoundReportDto);
}
