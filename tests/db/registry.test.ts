// Registry foundation tests (#165). Runs against PGlite — a real
// Postgres engine (WASM) in-process — so migration replay and constraint
// behavior are genuine PostgreSQL semantics, not a mock. No network,
// Docker, or credentials required; setting TEST_DATABASE_URL is reserved
// for an optional real-Postgres path and is not needed here.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  listPublicAnimals,
  getPublicAnimalById,
} from "@/lib/registry/public-animals";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("migration replay from empty database", () => {
  test("creates every foundation table", async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const tables = result.rows.map((r) => r.table_name);
    for (const expected of [
      "admin_users",
      "animals",
      "audit_events",
      "auth_identities",
      "communications",
      "follow_ups",
      "household_members",
      "households",
      "microchip_records",
      "ownerships",
      "payments",
      "persons",
      "registration_submissions",
      "registrations",
      "vaccinations",
      "vet_events",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test("replaying migrations a second time is a no-op", async () => {
    await expect(runMigrationsOnPglite(db)).resolves.toBeUndefined();
  });
});

describe("schema constraints", () => {
  test("animals.legacy_id is unique", async () => {
    const row = {
      legacyId: "fs-animal-1",
      name: "Rex",
      species: "dog",
      sex: "male",
      lifecycleStatus: "available",
    };
    await db.insert(schema.animals).values(row);
    await expect(db.insert(schema.animals).values(row)).rejects.toThrow();
  });

  test("animal status check rejects unsupported lifecycle values", async () => {
    await expect(
      db.insert(schema.animals).values({
        name: "Mystery",
        species: "dog",
        sex: "female",
        lifecycleStatus: "secret",
      }),
    ).rejects.toThrow();
  });

  test("ownership requires exactly one of person or household", async () => {
    const [animal] = await db
      .insert(schema.animals)
      .values({ name: "Solo", species: "cat", sex: "female", lifecycleStatus: "pending" })
      .returning();
    await expect(
      db.insert(schema.ownerships).values({
        animalId: animal.id,
        validFrom: "2026-01-01",
      }),
    ).rejects.toThrow();
  });

  test("ownership rejects inverted date ranges", async () => {
    const [person] = await db
      .insert(schema.persons)
      .values({ fullName: "Test Owner" })
      .returning();
    const [animal] = await db
      .insert(schema.animals)
      .values({ name: "Dates", species: "dog", sex: "male", lifecycleStatus: "pending" })
      .returning();
    await expect(
      db.insert(schema.ownerships).values({
        animalId: animal.id,
        personId: person.id,
        validFrom: "2026-06-01",
        validTo: "2026-01-01",
      }),
    ).rejects.toThrow();
  });

  test("one registration per animal per year", async () => {
    const [animal] = await db
      .insert(schema.animals)
      .values({ name: "Annual", species: "dog", sex: "male", lifecycleStatus: "pending" })
      .returning();
    const reg = { animalId: animal.id, year: 2026, status: "approved" };
    await db.insert(schema.registrations).values(reg);
    await expect(
      db.insert(schema.registrations).values(reg),
    ).rejects.toThrow();
  });

  test("one active microchip assignment per chip number", async () => {
    const [a1] = await db
      .insert(schema.animals)
      .values({ name: "Chip1", species: "dog", sex: "male", lifecycleStatus: "pending" })
      .returning();
    const [a2] = await db
      .insert(schema.animals)
      .values({ name: "Chip2", species: "dog", sex: "female", lifecycleStatus: "pending" })
      .returning();
    await db.insert(schema.microchipRecords).values({
      chipNumber: "ABC123",
      animalId: a1.id,
      assignedFrom: "2026-01-01",
    });
    // Second ACTIVE assignment of the same chip must fail.
    await expect(
      db.insert(schema.microchipRecords).values({
        chipNumber: "ABC123",
        animalId: a2.id,
        assignedFrom: "2026-02-01",
      }),
    ).rejects.toThrow();
    // A closed assignment does not conflict — the partial unique index
    // only covers rows where assigned_to IS NULL, so history is kept.
    await expect(
      db.insert(schema.microchipRecords).values({
        chipNumber: "ABC123",
        animalId: a2.id,
        assignedFrom: "2026-02-01",
        assignedTo: "2026-03-01",
      }),
    ).resolves.toBeDefined();
  });
});

describe("public animal boundary", () => {
  test("only 'available' animals are returned, as redacted DTOs", async () => {
    await db.insert(schema.animals).values([
      { legacyId: "pub-1", name: "Max", species: "dog", sex: "male", lifecycleStatus: "available", photoUrls: ["https://img/1.jpg"] },
      { legacyId: "priv-1", name: "Hidden", species: "cat", sex: "female", lifecycleStatus: "pending" },
      { legacyId: "priv-2", name: "Gone", species: "cat", sex: "female", lifecycleStatus: "adopted" },
    ]);

    const list = await listPublicAnimals(db);
    const names = list.map((a) => a.name);
    expect(names).toContain("Max");
    expect(names).not.toContain("Hidden");
    expect(names).not.toContain("Gone");

    const max = list.find((a) => a.name === "Max")!;
    // Public id is the legacy Firestore id (URL-stable), never the uuid.
    expect(max.id).toBe("pub-1");
    expect(max.photoUrls).toEqual(["https://img/1.jpg"]);
    // No owner/registration/payment fields exist on the DTO.
    expect(Object.keys(max).sort()).toEqual(
      [
        "approxAge",
        "createdAt",
        "description",
        "id",
        "name",
        "photoUrls",
        "sex",
        "species",
        "updatedAt",
      ].sort(),
    );
  });

  test("detail lookup resolves legacy id and uuid; private rows are invisible", async () => {
    const byLegacy = await getPublicAnimalById(db, "pub-1");
    expect(byLegacy?.name).toBe("Max");

    const [row] = await db
      .select()
      .from(schema.animals)
      .where(sql`${schema.animals.legacyId} = 'pub-1'`);
    const byUuid = await getPublicAnimalById(db, row.id);
    expect(byUuid?.name).toBe("Max");

    expect(await getPublicAnimalById(db, "priv-1")).toBeNull();
    expect(await getPublicAnimalById(db, "does-not-exist")).toBeNull();
    // A legacy id that happens to be uuid-shaped still resolves, and a
    // uuid that matches no row fails closed rather than erroring.
    expect(
      await getPublicAnimalById(db, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  test("listing order is deterministic: created_at then id", async () => {
    // The Firestore path had no defined order; the Postgres path orders
    // by created_at with the uuid as a stable tiebreak.
    await db.insert(schema.animals).values([
      {
        legacyId: "ord-new",
        name: "Newer",
        species: "cat",
        sex: "female",
        lifecycleStatus: "available",
        createdAt: new Date("2025-06-02T00:00:00Z"),
      },
      {
        legacyId: "ord-old",
        name: "Older",
        species: "cat",
        sex: "male",
        lifecycleStatus: "available",
        createdAt: new Date("2025-06-01T00:00:00Z"),
      },
    ]);

    const names = (await listPublicAnimals(db)).map((a) => a.name);
    expect(names.indexOf("Older")).toBeLessThan(names.indexOf("Newer"));
  });
});
