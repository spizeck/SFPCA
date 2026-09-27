// Household merge tests (#211) against PGlite — real Postgres locks and
// constraints apply. The contract: memberships dedupe (primary wins),
// ownership intervals reparent with duplicate opens closed annotated,
// registration links reparent while snapshots stay put, and a retired
// household resolves to the survivor via household_merges while staying
// out of pickers.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  executeHouseholdMerge,
  getHouseholdMergeInfo,
  previewHouseholdMerge,
  resolveHouseholdMergeTarget,
} from "@/lib/registry/household-merge";
import {
  listHouseholds,
  setHouseholdMember,
  updateHousehold,
} from "@/lib/registry/persons";
import { createOwnership } from "@/lib/registry/ownership";
import { createRegistration } from "@/lib/registry/registrations";
import { createAnimal } from "@/lib/registry/animals";
import { todayIsoDate } from "@/lib/vaccinations";

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

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE person_merges, household_merges, animal_merges, data_quality_reviews, payments, registrations, registration_submissions, ownership_confirmations, ownerships, animal_lifecycle_events, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

async function seedPerson(fullName = "Jane Owner") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName })
    .returning();
  return person;
}

async function seedHousehold(
  name = "Owner family",
  extra: Partial<typeof schema.households.$inferInsert> = {},
) {
  const [household] = await db
    .insert(schema.households)
    .values({ name, ...extra })
    .returning();
  return household;
}

async function seedAnimal(name = "Bella") {
  const res = await createAnimal(
    { name, species: "dog", sex: "female", adoptionStatus: "not-listed" },
    STAFF,
    db,
  );
  if (!res.ok) throw new Error("createAnimal failed");
  return res.animal;
}

async function pair() {
  const survivor = await seedHousehold("Owner family", {
    address: "The Bottom",
  });
  const retired = await seedHousehold("Owner family", {
    address: "The Bottom",
  });
  return { survivor, retired };
}

async function merge(
  survivorId: string,
  retiredId: string,
  extra: Partial<Parameters<typeof executeHouseholdMerge>[0]> = {},
) {
  const preview = await previewHouseholdMerge(survivorId, retiredId, db);
  if (!preview.ok) throw new Error(`preview failed: ${preview.message}`);
  const fieldChoices = Object.fromEntries(
    preview.preview.fieldConflicts.map((c) => [c.field, "survivor" as const]),
  );
  return executeHouseholdMerge(
    {
      survivorId,
      retiredId,
      fieldChoices,
      fingerprint: preview.preview.fingerprint,
      actorLabel: STAFF,
      ...extra,
    },
    db,
  );
}

describe("household merge preview", () => {
  test("rejects self-merge and unknown ids", async () => {
    const h = await seedHousehold();
    expect((await previewHouseholdMerge(h.id, h.id, db)).ok).toBe(false);
    expect(
      (await previewHouseholdMerge(h.id, crypto.randomUUID(), db)).ok,
    ).toBe(false);
  });

  test("address disagreement is a staff-choice conflict", async () => {
    const survivor = await seedHousehold("Owner family", { address: "The Bottom" });
    const retired = await seedHousehold("Owner family", { address: "Windwardside" });
    const r = await previewHouseholdMerge(survivor.id, retired.id, db);
    if (!r.ok) throw new Error("preview failed");
    expect(r.preview.fieldConflicts).toHaveLength(1);
    expect(r.preview.fieldConflicts[0].field).toBe("address");
  });
});

describe("household merge execution", () => {
  test("simple merge: members and address move; lineage + audit written", async () => {
    const { survivor, retired } = await pair();
    const member = await seedPerson("Jane Owner");
    await db
      .insert(schema.householdMembers)
      .values({ householdId: retired.id, personId: member.id, role: "member" });

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const members = await db.select().from(schema.householdMembers);
    expect(members).toHaveLength(1);
    expect(members[0].householdId).toBe(survivor.id);

    const info = await getHouseholdMergeInfo(retired.id, db);
    expect(info?.status).toBe("merged");
    expect(info?.survivor?.id).toBe(survivor.id);
    expect(info?.survivor?.name).toBe("Owner family");

    const target = await resolveHouseholdMergeTarget(retired.id, db);
    expect(target?.canonicalId).toBe(survivor.id);
    expect(target?.wasMerged).toBe(true);

    const canonical = await getHouseholdMergeInfo(survivor.id, db);
    expect(canonical?.absorbed.map((a) => a.id)).toEqual([retired.id]);

    const review = await db.select().from(schema.dataQualityReviews);
    expect(review).toHaveLength(1);
    expect(review[0].detector).toBe("duplicate-household");

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, "household"));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "merge-absorb",
      "merge-retire",
    ]);
  });

  test("member in both households dedupes — primary survives", async () => {
    const { survivor, retired } = await pair();
    const member = await seedPerson("Jane Owner");
    const only = await seedPerson("Joe Partner");
    await db.insert(schema.householdMembers).values([
      { householdId: survivor.id, personId: member.id, role: "member" },
      { householdId: retired.id, personId: member.id, role: "primary" },
      { householdId: retired.id, personId: only.id, role: "member" },
    ]);

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);

    const members = await db
      .select()
      .from(schema.householdMembers)
      .where(eq(schema.householdMembers.householdId, survivor.id));
    expect(members).toHaveLength(2);
    const merged = members.find((m) => m.personId === member.id);
    expect(merged?.role).toBe("primary");
    const retiredMembers = await db
      .select()
      .from(schema.householdMembers)
      .where(eq(schema.householdMembers.householdId, retired.id));
    expect(retiredMembers).toHaveLength(0);
  });

  test("ownerships reparent; a duplicate open interval closes annotated", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    await createOwnership(
      { animalId: animal.id, householdId: survivor.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const dup = await createOwnership(
      { animalId: animal.id, householdId: retired.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );
    if (!dup.ok) throw new Error("ownership failed");

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, animal.id));
    const open = rows.filter((r) => r.validTo === null);
    expect(open).toHaveLength(1);
    expect(open[0].householdId).toBe(survivor.id);
    const closed = rows.find((r) => r.id === dup.ownership.id);
    expect(closed?.householdId).toBe(retired.id); // stays as lineage
    expect(closed?.validTo).toBe(todayIsoDate());
  });

  test("registration household link reparents; owner_label snapshot untouched", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    const reg = await createRegistration(
      { animalId: animal.id, year: 2025, amountDueCents: 1500 },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("registration failed");
    await db
      .update(schema.registrations)
      .set({ householdId: retired.id, ownerLabel: "Owner family (card)" })
      .where(eq(schema.registrations.id, reg.registration.id));

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);

    const [after] = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.id, reg.registration.id));
    expect(after.householdId).toBe(survivor.id);
    expect(after.ownerLabel).toBe("Owner family (card)");
  });

  test("staff-chosen address applies", async () => {
    const survivor = await seedHousehold("Owner family", { address: "The Bottom" });
    const retired = await seedHousehold("Owner family", { address: "Windwardside" });
    const preview = await previewHouseholdMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    const result = await executeHouseholdMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: { address: "retired" },
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(true);
    const [after] = await db
      .select()
      .from(schema.households)
      .where(eq(schema.households.id, survivor.id));
    expect(after.address).toBe("Windwardside");
  });
});

describe("retired household behavior", () => {
  test("retired household excluded from pickers, shown annotated when included", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);

    const listed = await listHouseholds(db);
    expect(listed.map((h) => h.id)).toEqual([survivor.id]);

    const withRetired = await listHouseholds(db, { includeRetired: true });
    const row = withRetired.find((h) => h.id === retired.id);
    expect(row?.mergedInto?.id).toBe(survivor.id);
  });

  test("retired household cannot be edited, gain members, or re-merge", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);

    const edit = await updateHousehold(
      retired.id,
      { name: "New name" },
      STAFF,
      db,
    );
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.reason).toBe("merged");

    const person = await seedPerson("Someone");
    const add = await setHouseholdMember(retired.id, person.id, "member", STAFF, db);
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.reason).toBe("merged");

    const again = await previewHouseholdMerge(retired.id, survivor.id, db);
    if (!again.ok) throw new Error("preview failed");
    expect(again.preview.blockers.map((b) => b.code)).toContain("already-merged");
  });

  test("retired household cannot take new ownership", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);
    const animal = await seedAnimal();
    const res = await createOwnership(
      { animalId: animal.id, householdId: retired.id, validFrom: "2026-01-01" },
      STAFF,
      db,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("merged");
  });
});

describe("concurrency safety", () => {
  test("a stale fingerprint refuses to apply", async () => {
    const { survivor, retired } = await pair();
    const preview = await previewHouseholdMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    // Membership changed after the preview.
    const person = await seedPerson("Late Member");
    await db
      .insert(schema.householdMembers)
      .values({ householdId: retired.id, personId: person.id });
    const result = await executeHouseholdMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale");
  });

  test("a merged survivor is no longer a valid merge input", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);
    const third = await seedHousehold("Another family");
    const r = await previewHouseholdMerge(retired.id, third.id, db);
    if (!r.ok) throw new Error("preview failed");
    expect(r.preview.blockers.map((b) => b.code)).toContain("already-merged");
  });
});
