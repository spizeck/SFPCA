// Registry data-access seam for public animal reads (#165 Phase E / #182,
// made Postgres-only in #183).
//
// Postgres is the single read authority for public animal pages — the
// transitional PUBLIC_ANIMALS_SOURCE switch and its Firestore branch were
// removed once admin writes moved to Postgres (#183). There is no
// alternate read source and no fallback: a Postgres failure fails closed
// to empty/not-found and is logged as an incident.
//
// Boundary rules for anything added under src/lib/registry/:
// - server-side only (src/lib/db/client.ts imports "server-only")
// - return DTOs, never raw rows: public payloads carry only fields a
//   visitor may see — no owner, registration, payment, or vet data
// - enforce the same visibility boundary as firestore.rules: only
//   lifecycleStatus 'available' is public

import "server-only";

import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { animals } from "../db/schema";
import * as schema from "../db/schema";
import { getRegistryDb } from "../db/client";
import { PUBLIC_ANIMAL_STATUS, isPublicAnimalStatus } from "../animal-lifecycle";
import { logError } from "../logger";
import type { Animal } from "../types";

// Both drivers expose the same drizzle query API; services accept either
// so tests can run against PGlite without a network database.
export type RegistryDb =
  | PostgresJsDatabase<typeof schema>
  | PgliteDatabase<typeof schema>;

// Public DTO — deliberately a subset of the animals row. The Firestore
// document id is what public URLs use, so legacyId is the public id.
// Timestamps are public-safe (they describe the listing, not a person)
// and are included so the app-facing Animal shape stays complete.
export interface PublicRegistryAnimal {
  id: string; // legacyId when present, else the Postgres uuid
  name: string;
  species: string;
  sex: string;
  approxAge: string | null;
  description: string | null;
  photoUrls: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// Explicit column list — never select(): if the animals table later gains
// a private column, this query cannot start returning it.
const PUBLIC_COLUMNS = {
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

type PublicRow = Pick<
  typeof animals.$inferSelect,
  keyof typeof PUBLIC_COLUMNS
>;

function toPublicDto(row: PublicRow): PublicRegistryAnimal {
  return {
    id: row.legacyId ?? row.id,
    name: row.name,
    species: row.species,
    sex: row.sex,
    approxAge: row.approxAge,
    description: row.description,
    photoUrls: row.photoUrls ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPublicAnimals(
  db: RegistryDb,
): Promise<PublicRegistryAnimal[]> {
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(animals)
    .where(eq(animals.lifecycleStatus, PUBLIC_ANIMAL_STATUS))
    // Deterministic order: arrival order (created_at), uuid as stable
    // tiebreak. The Firestore path had no defined order; this replaces
    // undefined behavior rather than changing a real contract.
    .orderBy(asc(animals.createdAt), asc(animals.id));

  // Second defensive layer, same as the Firestore path: even if the query
  // ever drifted, a non-public row never reaches a public payload.
  return rows
    .filter((row) => isPublicAnimalStatus(row.lifecycleStatus))
    .map(toPublicDto);
}

export async function getPublicAnimalById(
  db: RegistryDb,
  id: string,
): Promise<PublicRegistryAnimal | null> {
  // Resolve by legacy Firestore id first (public URL form), then uuid.
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(animals)
    .where(eq(animals.legacyId, id));
  const byUuid =
    rows.length === 0 && /^[0-9a-f-]{36}$/i.test(id)
      ? await db
          .select(PUBLIC_COLUMNS)
          .from(animals)
          .where(eq(animals.id, id))
      : rows;

  const row = (rows.length ? rows : byUuid)[0];
  if (!row || !isPublicAnimalStatus(row.lifecycleStatus)) return null;
  return toPublicDto(row);
}

// Maps the registry DTO onto the app's public Animal shape so existing
// components keep working unchanged. status is always the public status —
// non-public rows never reach this mapper. Exported for tests.
export function toAnimal(dto: PublicRegistryAnimal): Animal {
  return {
    id: dto.id,
    name: dto.name,
    species: dto.species as Animal["species"],
    sex: dto.sex as Animal["sex"],
    approxAge: dto.approxAge ?? "",
    description: dto.description ?? "",
    status: PUBLIC_ANIMAL_STATUS,
    photos: dto.photoUrls,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

// --- App-facing read surface ----------------------------------------------
//
// Failure contract: log the failure (counts/surface only — no PII, no
// credentials) and fail closed to empty/not-found. There is no alternate
// read source: a broken Postgres path must be visible as an incident, not
// masked by a second authority.
export async function getAvailableAnimals(): Promise<Animal[]> {
  try {
    const rows = await listPublicAnimals(getRegistryDb());
    return rows.map(toAnimal);
  } catch (error) {
    logError("animals", "fetch-registry", error);
    return [];
  }
}

export async function getPublicAnimal(id: string): Promise<Animal | null> {
  try {
    const dto = await getPublicAnimalById(getRegistryDb(), id);
    return dto ? toAnimal(dto) : null;
  } catch (error) {
    logError("animals", "fetch-registry-detail", error);
    return null;
  }
}
