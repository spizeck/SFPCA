// Admin-side animal domain service (#183). This is the only application
// seam through which staff reads/writes animal records — route handlers
// and server actions call these functions; Drizzle never appears in UI
// code.
//
// Every mutation runs in a transaction together with its audit_events
// row so a record change can never land without its audit entry (or
// vice versa). Callers supply the actor label from the verified session;
// audit rows carry non-sensitive field projections only.

import "server-only";

import { asc, eq } from "drizzle-orm";
import { animals, auditEvents } from "../db/schema";
import { getRegistryDb } from "../db/client";
import { isAnimalStatus, type AnimalStatus } from "../animal-lifecycle";
import type { RegistryDb } from "./public-animals";

// Admin DTO — all animals columns are staff-safe (no owner data lives on
// an animal row), so the projection is the full row plus legacyId.
export interface AdminAnimal {
  id: string;
  legacyId: string | null;
  name: string;
  species: string;
  sex: string;
  approxAge: string | null;
  description: string | null;
  lifecycleStatus: string;
  photoUrls: string[];
  createdAt: string;
  updatedAt: string;
}

const ADMIN_COLUMNS = {
  id: animals.id,
  legacyId: animals.legacyId,
  name: animals.name,
  species: animals.species,
  sex: animals.sex,
  approxAge: animals.approxAge,
  description: animals.description,
  lifecycleStatus: animals.lifecycleStatus,
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

export interface AnimalWriteInput {
  name: string;
  species: string;
  sex: string;
  approxAge?: string | null;
  description?: string | null;
  lifecycleStatus: string;
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
  if (!isAnimalStatus(input.lifecycleStatus)) return "lifecycleStatus";
  return null;
}

function writeValues(input: AnimalWriteInput) {
  return {
    name: input.name.trim(),
    species: input.species,
    sex: input.sex,
    approxAge: input.approxAge?.trim() || null,
    description: input.description?.trim() || null,
    lifecycleStatus: input.lifecycleStatus as AnimalStatus,
    photoUrls: input.photoUrls ?? [],
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

export type AnimalMutationResult =
  | { ok: true; animal: AdminAnimal }
  | { ok: false; reason: "not-found" | "conflict" | "invalid" };

export async function createAnimal(
  input: AnimalWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  if (validateAnimalInput(input)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(animals)
      .values(writeValues(input))
      .returning();
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

// Hard delete matches the existing admin UI semantics (delete exists only
// for erroneous/test records — lifecycle "adopted" is the real archive).
// Ownership/vet/microchip references are restrictive FKs, so a delete of
// a referenced animal fails loudly instead of orphaning history.
export async function deleteAnimal(
  id: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AnimalMutationResult> {
  return db.transaction(async (tx) => {
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
