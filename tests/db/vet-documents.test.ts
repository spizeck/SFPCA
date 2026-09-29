// Clinical-document service tests (#192), run against PGlite — real
// Postgres semantics for the transaction, the storage_path unique
// index, the path CHECK constraint, and encounter/vaccination
// belong-to-animal validation.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  getVetDocumentStoragePath,
  registerVetDocument,
  vetDocumentPathExists,
} from "@/lib/registry/medical";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

async function seedAnimal(name = "Rex") {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name,
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
    })
    .returning();
  return animal;
}

async function seedEncounter(animalId: string) {
  const [encounter] = await db
    .insert(schema.vetEncounters)
    .values({ animalId, kind: "visit", occurredOn: "2026-06-01" })
    .returning();
  return encounter;
}

async function seedVaccination(animalId: string) {
  const [vaccination] = await db
    .insert(schema.vaccinations)
    .values({
      animalId,
      vaccineName: "Rabies",
      administeredOn: "2026-06-01",
    })
    .returning();
  return vaccination;
}

function docPath() {
  return `vet-docs/${crypto.randomUUID()}.pdf`;
}

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("registerVetDocument", () => {
  test("creates the row and writes an audit event in one transaction", async () => {
    const animal = await seedAnimal("Bella");
    const encounter = await seedEncounter(animal.id);
    const vaccination = await seedVaccination(animal.id);
    const storagePath = docPath();

    const result = await registerVetDocument(
      {
        animalId: animal.id,
        storagePath,
        label: "Lab report",
        notes: "CBC panel",
        encounterId: encounter.id,
        vaccinationId: vaccination.id,
      },
      "vet@test.dev",
      db,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.animalId).toBe(animal.id);
    expect(result.record.encounterId).toBe(encounter.id);
    expect(result.record.vaccinationId).toBe(vaccination.id);
    expect(result.record.uploadedBy).toBe("vet@test.dev");

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, result.record.id));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");
    expect(audits[0].entityType).toBe("vet_document");
    expect(audits[0].actorLabel).toBe("vet@test.dev");
  });

  test("rejects a path outside the vet-docs prefix and a non-uuid name", async () => {
    const animal = await seedAnimal();
    for (const storagePath of [
      "receipts/abc",
      "vet-docs/not-a-uuid",
      "vet-docs/nested/path.pdf",
      "",
    ]) {
      const result = await registerVetDocument(
        { animalId: animal.id, storagePath, label: "x" },
        "vet@test.dev",
        db,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "invalid",
        field: "storagePath",
      });
    }
    // And even a direct insert is held by the CHECK constraint.
    await expect(
      db.insert(schema.vetDocuments).values({
        animalId: animal.id,
        storagePath: "elsewhere/abc",
        label: "x",
      }),
    ).rejects.toThrow();
  });

  test("rejects missing/oversized labels and unknown animals", async () => {
    const animal = await seedAnimal();
    for (const label of ["", "   ", "x".repeat(201)]) {
      const result = await registerVetDocument(
        { animalId: animal.id, storagePath: docPath(), label },
        "vet@test.dev",
        db,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "invalid",
        field: "label",
      });
    }
    const missing = await registerVetDocument(
      {
        animalId: crypto.randomUUID(),
        storagePath: docPath(),
        label: "Lab report",
      },
      "vet@test.dev",
      db,
    );
    expect(missing).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("rejects encounter/vaccination links owned by another animal", async () => {
    const animal = await seedAnimal("Mine");
    const other = await seedAnimal("Theirs");
    const otherEncounter = await seedEncounter(other.id);
    const otherVaccination = await seedVaccination(other.id);

    const badEncounter = await registerVetDocument(
      {
        animalId: animal.id,
        storagePath: docPath(),
        label: "Lab report",
        encounterId: otherEncounter.id,
      },
      "vet@test.dev",
      db,
    );
    expect(badEncounter).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "encounterId",
    });

    const badVaccination = await registerVetDocument(
      {
        animalId: animal.id,
        storagePath: docPath(),
        label: "Lab report",
        vaccinationId: otherVaccination.id,
      },
      "vet@test.dev",
      db,
    );
    expect(badVaccination).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "vaccinationId",
    });
  });

  test("re-registering the same object is idempotent — one row, no new audit", async () => {
    const animal = await seedAnimal();
    const storagePath = docPath();

    const first = await registerVetDocument(
      { animalId: animal.id, storagePath, label: "Lab report" },
      "vet@test.dev",
      db,
    );
    expect(first.ok).toBe(true);

    const second = await registerVetDocument(
      { animalId: animal.id, storagePath, label: "Different label" },
      "other@test.dev",
      db,
    );
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same row returned — the retry did not create a second document.
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.label).toBe("Lab report");

    const rows = await db
      .select()
      .from(schema.vetDocuments)
      .where(eq(schema.vetDocuments.storagePath, storagePath));
    expect(rows).toHaveLength(1);
  });

  test("the unique index holds under concurrent duplicate inserts", async () => {
    const animal = await seedAnimal();
    const storagePath = docPath();
    await db.insert(schema.vetDocuments).values({
      animalId: animal.id,
      storagePath,
      label: "first",
    });
    await expect(
      db.insert(schema.vetDocuments).values({
        animalId: animal.id,
        storagePath,
        label: "second",
      }),
    ).rejects.toThrow();
  });
});

describe("document path resolution", () => {
  test("getVetDocumentStoragePath resolves the row's path only", async () => {
    const animal = await seedAnimal();
    const storagePath = docPath();
    const created = await registerVetDocument(
      { animalId: animal.id, storagePath, label: "Cert" },
      "vet@test.dev",
      db,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await getVetDocumentStoragePath(created.record.id, db)).toBe(
      storagePath,
    );
    expect(await getVetDocumentStoragePath(crypto.randomUUID(), db)).toBeNull();
    expect(await getVetDocumentStoragePath("not-a-uuid", db)).toBeNull();
  });

  test("vetDocumentPathExists is the sweeper's existence check", async () => {
    const animal = await seedAnimal();
    const storagePath = docPath();
    expect(await vetDocumentPathExists(storagePath, db)).toBe(false);
    await registerVetDocument(
      { animalId: animal.id, storagePath, label: "Cert" },
      "vet@test.dev",
      db,
    );
    expect(await vetDocumentPathExists(storagePath, db)).toBe(true);
  });
});
