// Registry data-access seam for public animal reads (#165 Phase E).
//
// This is the Postgres-side counterpart to src/lib/animals.ts
// (Firestore). It is intentionally not wired into any page yet — it
// exists to prove the schema/client/DTO contract end-to-end under test
// and becomes the cutover point when the public animal reads move to
// Postgres.
//
// Boundary rules for anything added under src/lib/registry/:
// - server-side only (src/lib/db/client.ts imports "server-only")
// - return DTOs, never raw rows: public payloads carry only fields a
//   visitor may see — no owner, registration, payment, or vet data
// - enforce the same visibility boundary as firestore.rules: only
//   lifecycleStatus 'available' is public

import "server-only";

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { animals } from "../db/schema";
import * as schema from "../db/schema";
import { PUBLIC_ANIMAL_STATUS, isPublicAnimalStatus } from "../animal-lifecycle";

// Both drivers expose the same drizzle query API; services accept either
// so tests can run against PGlite without a network database.
export type RegistryDb =
  | PostgresJsDatabase<typeof schema>
  | PgliteDatabase<typeof schema>;

// Public DTO — deliberately a subset of the animals row. The Firestore
// document id is what public URLs use, so legacyId is the public id.
export interface PublicRegistryAnimal {
  id: string; // legacyId when present, else the Postgres uuid
  name: string;
  species: string;
  sex: string;
  approxAge: string | null;
  description: string | null;
  photoUrls: string[];
}

function toPublicDto(row: typeof animals.$inferSelect): PublicRegistryAnimal {
  return {
    id: row.legacyId ?? row.id,
    name: row.name,
    species: row.species,
    sex: row.sex,
    approxAge: row.approxAge,
    description: row.description,
    photoUrls: row.photoUrls ?? [],
  };
}

export async function listPublicAnimals(
  db: RegistryDb,
): Promise<PublicRegistryAnimal[]> {
  const rows = await db
    .select()
    .from(animals)
    .where(eq(animals.lifecycleStatus, PUBLIC_ANIMAL_STATUS));

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
    .select()
    .from(animals)
    .where(eq(animals.legacyId, id));
  const byUuid =
    rows.length === 0 && /^[0-9a-f-]{36}$/i.test(id)
      ? await db.select().from(animals).where(eq(animals.id, id))
      : rows;

  const row = (rows.length ? rows : byUuid)[0];
  if (!row || !isPublicAnimalStatus(row.lifecycleStatus)) return null;
  return toPublicDto(row);
}
