// #181 migration import tests. Transforms are pure functions tested with
// synthetic fixtures; upsert/idempotency behavior runs against PGlite
// (real Postgres semantics). No production data or PII in fixtures.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { animals, registrationSubmissions } from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  transformAnimal,
  transformAdmin,
  transformRegistration,
  animalProjection,
  submissionProjection,
  projectDestRow,
  diffProjection,
  projectionHash,
} from "../../scripts/lib/migrate-transform";

const T0 = new Date("2025-06-01T12:00:00.000Z");
const T1 = new Date("2025-06-02T12:00:00.000Z");
const fsTs = (d: Date) => ({ toDate: () => d });

describe("transformAnimal", () => {
  test("maps a complete doc faithfully", () => {
    const { row, exceptions } = transformAnimal("fs-abc", {
      name: "Rex",
      species: "dog",
      sex: "male",
      approxAge: "3 years",
      description: "Friendly",
      status: "available",
      photos: ["https://x/1.jpg", "https://x/2.jpg"],
      createdAt: fsTs(T0),
      updatedAt: fsTs(T1),
    });
    expect(exceptions).toEqual([]);
    expect(row.legacyId).toBe("fs-abc");
    // The Firestore status was the adoption-catalog state; imported
    // animals enter the registry lifecycle as 'active'.
    expect(row.lifecycleStatus).toBe("active");
    expect(row.adoptionStatus).toBe("available");
    // Free-text approxAge is preserved as staff-only identifying
    // context — never fabricated into a birth date.
    expect(row.identifyingNotes).toBe("Approx. age at import: 3 years");
    expect(row.photoUrls).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
    expect(row.createdAt).toEqual(T0);
    expect(row.updatedAt).toEqual(T1);
  });

  test("unknown status fails closed to pending and is flagged", () => {
    const { row, exceptions } = transformAnimal("a1", {
      name: "X", species: "cat", sex: "female", status: "weird",
    });
    expect(row.adoptionStatus).toBe("pending");
    expect(row.lifecycleStatus).toBe("active");
    expect(exceptions.some((e) => e.kind === "unsupported-status")).toBe(true);
  });

  test("missing name becomes (unnamed) with an exception", () => {
    const { row, exceptions } = transformAnimal("a2", { species: "dog" });
    expect(row.name).toBe("(unnamed)");
    expect(exceptions.some((e) => e.kind === "missing-field" && e.field === "name")).toBe(true);
  });

  test("unsupported species/sex normalize with exceptions", () => {
    const { row, exceptions } = transformAnimal("a3", {
      name: "Y", species: "parrot", sex: "yes", status: "adopted",
    });
    expect(row.species).toBe("other");
    expect(row.sex).toBe("unknown");
    expect(exceptions.filter((e) => e.kind === "unsupported-value")).toHaveLength(2);
  });

  test("non-string photo elements are dropped and flagged", () => {
    const { row, exceptions } = transformAnimal("a4", {
      name: "Z", status: "available", photos: ["ok", 42, null],
    });
    expect(row.photoUrls).toEqual(["ok"]);
    expect(exceptions.some((e) => e.field === "photos")).toBe(true);
  });

  test("absent timestamps are left to column defaults (not reconciled)", () => {
    const { row } = transformAnimal("a5", { name: "W", status: "pending" });
    expect(row.createdAt).toBeUndefined();
    expect(row.updatedAt).toBeUndefined();
    const p = animalProjection(row);
    expect("createdAt" in p).toBe(false);
  });

  test("invalid timestamp is flagged, not crashed", () => {
    const { exceptions } = transformAnimal("a6", {
      name: "V", status: "available", createdAt: "not-a-timestamp",
    });
    expect(exceptions.some((e) => e.kind === "invalid-timestamp")).toBe(true);
  });
});

describe("transformAdmin", () => {
  test("doc id is the normalized email", () => {
    const { row, exceptions } = transformAdmin("Admin@Example.COM ", { role: "admin" });
    expect(row.email).toBe("admin@example.com");
    expect(row.role).toBe("admin");
    expect(exceptions).toEqual([]);
  });

  test("unknown role falls back to editor with exception", () => {
    const { row, exceptions } = transformAdmin("x@y.z", { role: "superuser" });
    expect(row.role).toBe("editor");
    expect(exceptions.some((e) => e.kind === "unsupported-value")).toBe(true);
  });

  test("non-email doc id is flagged", () => {
    const { exceptions } = transformAdmin("randomDocId", { role: "admin" });
    expect(exceptions.some((e) => e.field === "email")).toBe(true);
  });
});

describe("transformRegistration", () => {
  const good = {
    ownerInfo: { name: "Jane Doe", address: "Windwardside", phone: "555", email: "j@x.z" },
    paymentReceipt: "receipts/abc.pdf",
    totalFee: 25,
    status: "approved",
    createdAt: fsTs(T0),
    updatedAt: fsTs(T1),
    decidedAt: fsTs(T1),
  };

  test("maps a complete submission including cents + receipt path", () => {
    const { row, exceptions } = transformRegistration("reg-1", good);
    expect(exceptions).toEqual([]);
    expect(row.legacyId).toBe("reg-1");
    expect(row.totalFeeCents).toBe(2500);
    expect(row.paymentReceiptPath).toBe("receipts/abc.pdf");
    expect(row.status).toBe("approved");
    expect(row.submittedAt).toEqual(T0);
    expect(row.decidedAt).toEqual(T1);
  });

  test("missing createdAt is flagged; submittedAt left to default", () => {
    const { createdAt, ...rest } = good;
    const { row, exceptions } = transformRegistration("reg-2", rest);
    expect(row.submittedAt).toBeUndefined();
    expect(exceptions.some((e) => e.kind === "missing-field" && e.field === "createdAt")).toBe(true);
  });

  test("unknown status → pending + exception; bad fee → 0 + exception", () => {
    const { row, exceptions } = transformRegistration("reg-3", {
      ownerInfo: { name: "A" }, status: "mystery", totalFee: "lots",
    });
    expect(row.status).toBe("pending");
    expect(row.totalFeeCents).toBe(0);
    expect(exceptions.filter((e) => e.kind === "unsupported-status")).toHaveLength(1);
    expect(exceptions.filter((e) => e.field === "totalFee")).toHaveLength(1);
  });
});

describe("reconciliation helpers", () => {
  test("diffProjection catches a changed field by name only", () => {
    const expected = { name: "Rex", status: "available" };
    const actual = { name: "Rex", status: "adopted", extra: "ignored" };
    const proj = projectDestRow(actual, Object.keys(expected));
    expect(diffProjection(expected, proj)).toEqual(["status"]);
  });

  test("dest extras and default timestamps never cause false mismatches", () => {
    const expected = animalProjection(
      transformAnimal("a9", { name: "M", status: "available" }).row,
    );
    const destRow = { ...expected, createdAt: new Date(), id: "uuid-x" };
    const proj = projectDestRow(
      destRow as Record<string, unknown>,
      Object.keys(expected),
    );
    expect(diffProjection(expected, proj)).toEqual([]);
  });

  test("projectionHash is order-independent", () => {
    const a = projectionHash({ x: 1, y: "a" });
    const b = projectionHash({ y: "a", x: 1 });
    expect(a).toBe(b);
  });
});

// --- idempotent upserts against real Postgres (PGlite) ---------------------

describe("import upserts (PGlite)", () => {
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

  async function upsertAnimal(row: ReturnType<typeof transformAnimal>["row"]) {
    // Mirrors scripts/migrate-firestore.ts — updated_at copies the
    // source value so re-runs converge to the same semantic state.
    await db
      .insert(animals)
      .values(row)
      .onConflictDoUpdate({
        target: animals.legacyId,
        set: {
          name: sql`excluded.name`,
          adoptionStatus: sql`excluded.adoption_status`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  test("re-running the same import creates exactly one row", async () => {
    const { row } = transformAnimal("dup-1", {
      name: "Rex", species: "dog", sex: "male", status: "available",
      createdAt: fsTs(T0),
    });
    await upsertAnimal(row);
    await upsertAnimal(row);
    const r = await db.execute<{ n: number; created_at: string }>(sql`
      SELECT count(*)::int AS n, min(created_at) AS created_at
      FROM animals WHERE legacy_id = 'dup-1'`);
    expect(r.rows[0].n).toBe(1);
    // provenance timestamp preserved, not overwritten by now()
    expect(new Date(r.rows[0].created_at).toISOString()).toBe(T0.toISOString());
  });

  test("a source change updates in place — no duplicate", async () => {
    const v1 = transformAnimal("upd-1", {
      name: "Rex", species: "dog", sex: "male", status: "available",
    }).row;
    await upsertAnimal(v1);
    const v2 = transformAnimal("upd-1", {
      name: "Rex II", species: "dog", sex: "male", status: "adopted",
    }).row;
    await upsertAnimal(v2);
    const r = await db.execute<{ n: number; name: string; adoption_status: string }>(sql`
      SELECT count(*)::int AS n, max(name) AS name, max(adoption_status) AS adoption_status
      FROM animals WHERE legacy_id = 'upd-1'`);
    expect(r.rows[0].n).toBe(1);
    expect(r.rows[0].name).toBe("Rex II");
    expect(r.rows[0].adoption_status).toBe("adopted");
  });

  test("submission upsert is idempotent on legacy_id", async () => {
    const { row } = transformRegistration("sub-1", {
      ownerInfo: { name: "J" }, totalFee: 10, status: "pending",
      createdAt: fsTs(T0),
    });
    const insert = () =>
      db
        .insert(registrationSubmissions)
        .values(row)
        .onConflictDoUpdate({
          target: registrationSubmissions.legacyId,
          set: { status: sql`excluded.status`, updatedAt: sql`now()` },
        });
    await insert();
    await insert();
    const r = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM registration_submissions WHERE legacy_id = 'sub-1'`);
    expect(r.rows[0].n).toBe(1);
  });

  test("dest projection round-trips through the DB unchanged", async () => {
    const { row } = transformAnimal("rt-1", {
      name: "Kitty", species: "cat", sex: "female", status: "available",
      approxAge: "2", description: "desc", photos: ["u1"],
      createdAt: fsTs(T0), updatedAt: fsTs(T1),
    });
    await db.insert(animals).values(row);
    const [dest] = await db.select().from(animals).where(sql`legacy_id = 'rt-1'`);
    const expected = animalProjection(row);
    const actual = projectDestRow(
      dest as unknown as Record<string, unknown>,
      Object.keys(expected),
    );
    expect(diffProjection(expected, actual)).toEqual([]);
  });
});
