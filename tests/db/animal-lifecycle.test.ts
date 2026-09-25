// PGlite integration tests for the permanent animal registry (#167).
// Pins down the invariants the issue defines:
//   - durable identity + human-readable registry ref on creation;
//   - every lifecycle change goes through transitionAnimalLifecycle,
//     lands in animal_lifecycle_events + audit_events atomically, and
//     ownership-ending states close ALL open intervals (co-ownership
//     included) without deleting history;
//   - #166 owner-request approval applies the whole-animal lifecycle;
//   - sterilization: staff assertion OR procedure evidence reconciles
//     the animal-level summary without a second authority;
//   - registry independence: animals exist without owner/registration/
//     payment/vet/portal records;
//   - staff search across name/ref/chip/owner + lifecycle filtering;
//   - public visibility = adoption 'available' AND lifecycle 'active',
//     with private fields absent from public DTOs;
//   - portal past-animals view preserves closed associations.
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  createAnimal,
  deleteAnimal,
  getAdminAnimal,
  getAnimalRegistryContext,
  getAnimalSterilization,
  listLifecycleHistory,
  searchAnimals,
  transitionAnimalLifecycle,
  updateAnimal,
} from "@/lib/registry/animals";
import { createProcedure } from "@/lib/registry/medical";
import {
  getPublicAnimalById,
  listPublicAnimals,
} from "@/lib/registry/public-animals";
import {
  createOwnership,
  listCurrentOwnerships,
  listOwnershipHistory,
  listPortalAnimals,
  listPortalPastAnimals,
} from "@/lib/registry/ownership";
import {
  resolveOwnerRequest,
  submitOwnerRequest,
} from "@/lib/registry/owner-requests";

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
    sql`TRUNCATE owner_requests, ownership_confirmations, ownerships, household_members, households, auth_identities, persons, animal_lifecycle_events, microchip_records, payments, registrations, vet_procedures, vet_encounters, follow_ups, clinic_expectations, vet_documents, animals, audit_events CASCADE`,
  );
});

const STAFF = "staff@example.com";
const TODAY = "2026-09-20";

async function seedPerson(email = "owner@example.com", fullName = "Jane Owner") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName, email })
    .returning();
  return person;
}

async function seedIdentity(providerUid: string, personId: string | null, email: string) {
  const [identity] = await db
    .insert(schema.authIdentities)
    .values({ provider: "firebase", providerUid, email, personId })
    .returning();
  return identity;
}

async function auditActions(entityType: string) {
  const rows = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityType, entityType));
  return rows.map((r) => r.action);
}

const BASE = {
  name: "Rex",
  species: "dog",
  sex: "male",
  adoptionStatus: "not-listed",
};

describe("permanent identity + creation", () => {
  test("create assigns uuid + sequential registry ref and records the entry event", async () => {
    const a = await createAnimal(BASE, STAFF, db);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.animal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.animal.registryRef).toMatch(/^SFPCA-\d{6}$/);
    expect(a.animal.lifecycleStatus).toBe("active");

    const b = await createAnimal({ ...BASE, name: "Mochi" }, STAFF, db);
    if (!b.ok) throw new Error("setup");
    // Sequential, monotonically increasing refs — stable, human-readable.
    expect(Number(b.animal.registryRef.slice(6))).toBe(
      Number(a.animal.registryRef.slice(6)) + 1,
    );

    // The first lifecycle event documents entry into the registry.
    const history = await listLifecycleHistory(a.animal.id, db);
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBeNull();
    expect(history[0].toStatus).toBe("active");
    expect(history[0].source).toBe("staff");
  });

  test("identity is stable across name, owner, and lifecycle changes", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;
    const ref = created.animal.registryRef;

    const owner = await seedPerson();
    await createOwnership(
      { animalId: id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await updateAnimal(
      id,
      { ...BASE, name: "Rex II" },
      created.animal.updatedAt,
      STAFF,
      db,
    );
    await transitionAnimalLifecycle(
      id,
      { toStatus: "moved-off-saba", source: "staff", actorLabel: STAFF },
      db,
    );

    const after = await getAdminAnimal(id, db);
    expect(after?.id).toBe(id);
    expect(after?.registryRef).toBe(ref);
    expect(after?.name).toBe("Rex II");
  });

  test("known vs estimated birth date semantics validate", async () => {
    // Estimated birth without a date is contradictory — rejected.
    expect(
      await createAnimal({ ...BASE, birthDateEstimated: true }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "invalid" });
    // Malformed date rejected.
    expect(
      await createAnimal(
        { ...BASE, birthDate: "sometime in 2020" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });

    const known = await createAnimal(
      { ...BASE, birthDate: "2020-05-01" },
      STAFF,
      db,
    );
    if (!known.ok) throw new Error("setup");
    expect(known.animal.birthDate).toBe("2020-05-01");
    expect(known.animal.birthDateEstimated).toBe(false);

    const estimated = await createAnimal(
      { ...BASE, name: "Stray", birthDate: "2019-01-01", birthDateEstimated: true },
      STAFF,
      db,
    );
    if (!estimated.ok) throw new Error("setup");
    expect(estimated.animal.birthDateEstimated).toBe(true);
  });
});

describe("lifecycle transitions", () => {
  test("transition updates current state, writes history + audit atomically", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;

    const result = await transitionAnimalLifecycle(
      id,
      {
        toStatus: "deceased",
        effectiveOn: "2026-02-20",
        reason: "Confirmed by owner",
        source: "staff",
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(true);

    const animal = await getAdminAnimal(id, db);
    expect(animal?.lifecycleStatus).toBe("deceased");
    expect(animal?.lifecycleEffectiveOn).toBe("2026-02-20");

    const history = await listLifecycleHistory(id, db);
    expect(history).toHaveLength(2); // entry event + transition
    const transition = history.find((h) => h.toStatus === "deceased");
    expect(transition).toMatchObject({
      fromStatus: "active",
      effectiveOn: "2026-02-20",
      source: "staff",
      reason: "Confirmed by owner",
    });
    expect(await auditActions("animal")).toContain("lifecycle-transition");
  });

  test("same-state and unrecognized transitions are rejected", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;

    expect(
      await transitionAnimalLifecycle(
        id,
        { toStatus: "active", source: "staff", actorLabel: STAFF },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await transitionAnimalLifecycle(
        id,
        { toStatus: "adopted", source: "staff", actorLabel: STAFF },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await transitionAnimalLifecycle(
        "not-a-uuid",
        { toStatus: "deceased", source: "staff", actorLabel: STAFF },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
    // No phantom history was written.
    expect(await listLifecycleHistory(id, db)).toHaveLength(1);
  });

  test("corrections are allowed — deceased can return to active", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;
    await transitionAnimalLifecycle(
      id,
      { toStatus: "deceased", source: "staff", actorLabel: STAFF },
      db,
    );
    const restored = await transitionAnimalLifecycle(
      id,
      {
        toStatus: "active",
        reason: "Report was mistaken — different animal",
        source: "staff",
        actorLabel: STAFF,
      },
      db,
    );
    expect(restored.ok).toBe(true);
    const history = await listLifecycleHistory(id, db);
    expect(history.map((h) => h.toStatus)).toEqual([
      "active",
      "deceased",
      "active",
    ]);
  });

  test("deceased/moved-off-saba closes ALL open ownerships, keeps history", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;
    const a = await seedPerson("a@example.com", "Owner A");
    const b = await seedPerson("b@example.com", "Owner B");
    await createOwnership(
      { animalId: id, personId: a.id, validFrom: "2024-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: id, personId: b.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );
    expect(await listCurrentOwnerships(id, TODAY, db)).toHaveLength(2);

    const result = await transitionAnimalLifecycle(
      id,
      {
        toStatus: "deceased",
        effectiveOn: "2026-03-01",
        source: "staff",
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(true);

    // Both co-owners' intervals closed — neither is deleted.
    expect(await listCurrentOwnerships(id, TODAY, db)).toHaveLength(0);
    const history = await listOwnershipHistory(id, db);
    expect(history).toHaveLength(2);
    for (const h of history) expect(h.validTo).toBe("2026-03-01");

    // Former owners see it as a past association, not a current animal.
    expect(await listPortalAnimals(a.id, "2026-03-02", db)).toEqual([]);
    const past = await listPortalPastAnimals(a.id, "2026-03-02", db);
    expect(past).toHaveLength(1);
    expect(past[0].lifecycleStatus).toBe("deceased");
  });

  test("ownership-ending transitions cancel open clinical work", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;
    await db.insert(schema.followUps).values({
      animalId: id,
      dueOn: "2026-12-01",
      reason: "Recheck",
      kind: "recheck",
    });
    await db.insert(schema.clinicExpectations).values({
      animalId: id,
      expectedOn: "2026-12-01",
      reason: "Vaccination",
    });

    await transitionAnimalLifecycle(
      id,
      { toStatus: "moved-off-saba", source: "staff", actorLabel: STAFF },
      db,
    );

    const [fu] = await db
      .select({ status: schema.followUps.status })
      .from(schema.followUps)
      .where(eq(schema.followUps.animalId, id));
    const [ex] = await db
      .select({ status: schema.clinicExpectations.status })
      .from(schema.clinicExpectations)
      .where(eq(schema.clinicExpectations.animalId, id));
    expect(fu.status).toBe("cancelled");
    expect(ex.status).toBe("cancelled");
  });

  test("'unknown' does NOT close ownership — unconfirmed ≠ gone", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;
    const owner = await seedPerson();
    await createOwnership(
      { animalId: id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );

    await transitionAnimalLifecycle(
      id,
      { toStatus: "unknown", source: "staff", actorLabel: STAFF },
      db,
    );
    expect(await listCurrentOwnerships(id, TODAY, db)).toHaveLength(1);
    expect(await listPortalAnimals(owner.id, TODAY, db)).toHaveLength(1);
  });
});

describe("#166 owner-request seam", () => {
  let uidSeq = 0;
  async function ownedSetup() {
    const owner = await seedPerson();
    const identity = await seedIdentity(
      `uid-life-${++uidSeq}`,
      owner.id,
      owner.email!,
    );
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const osh = await createOwnership(
      { animalId: created.animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!osh.ok) throw new Error("setup");
    return { owner, identity, animal: created.animal, ownership: osh.ownership };
  }

  test("approving lifecycle-deceased transitions the animal + closes reporting interval", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();
    const submitted = await submitOwnerRequest(
      {
        kind: "lifecycle-deceased",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
        detail: "Passed away",
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");

    const resolved = await resolveOwnerRequest(
      submitted.request.id,
      { decision: "approved", effectiveOn: "2026-02-20" },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const after = await getAdminAnimal(animal.id, db);
    expect(after?.lifecycleStatus).toBe("deceased");
    expect(after?.lifecycleEffectiveOn).toBe("2026-02-20");

    // History carries the request provenance.
    const history = await listLifecycleHistory(animal.id, db);
    const transition = history.find((h) => h.toStatus === "deceased");
    expect(transition?.source).toBe("owner-request");
    expect(transition?.sourceRef).toBe(submitted.request.id);

    // Ownership closed; animal record preserved.
    expect(await listCurrentOwnerships(animal.id, TODAY, db)).toHaveLength(0);
    expect(await listOwnershipHistory(animal.id, db)).toHaveLength(1);
  });

  test("moved-off-saba approval closes co-owner intervals too — whole-animal fact", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();
    const co = await seedPerson("co@example.com", "Co Owner");
    await createOwnership(
      { animalId: animal.id, personId: co.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );

    const submitted = await submitOwnerRequest(
      {
        kind: "lifecycle-moved-off-saba",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");
    const resolved = await resolveOwnerRequest(
      submitted.request.id,
      { decision: "approved", effectiveOn: "2026-03-01" },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const after = await getAdminAnimal(animal.id, db);
    expect(after?.lifecycleStatus).toBe("moved-off-saba");
    // Co-owner's interval closed by the animal-level transition — the
    // animal left Saba, so nobody owns it on-island anymore.
    expect(await listCurrentOwnerships(animal.id, TODAY, db)).toHaveLength(0);
    expect(await listOwnershipHistory(animal.id, db)).toHaveLength(2);
    // Co-owner keeps it as a past association.
    const past = await listPortalPastAnimals(co.id, "2026-03-02", db);
    expect(past[0]?.lifecycleStatus).toBe("moved-off-saba");
  });

  test("rejecting a lifecycle report changes nothing", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();
    const submitted = await submitOwnerRequest(
      {
        kind: "lifecycle-deceased",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");
    await resolveOwnerRequest(
      submitted.request.id,
      { decision: "rejected", resolutionNote: "Owner mistaken" },
      STAFF,
      db,
    );
    const after = await getAdminAnimal(animal.id, db);
    expect(after?.lifecycleStatus).toBe("active");
    expect(await listCurrentOwnerships(animal.id, TODAY, db)).toHaveLength(1);
    expect(await listLifecycleHistory(animal.id, db)).toHaveLength(1);
  });
});

describe("sterilization authority", () => {
  test("staff can assert historical sterilization without a fake procedure", async () => {
    const created = await createAnimal(
      {
        ...BASE,
        sterilizationStatus: "sterilized",
        sterilizedBy: "Previous vet",
      },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    expect(created.animal.sterilizationStatus).toBe("sterilized");
    expect(created.animal.sterilizedBy).toBe("Previous vet");
  });

  test("details against 'intact'/'unknown' are contradictory — nulled at write", async () => {
    const created = await createAnimal(
      {
        ...BASE,
        sterilizationStatus: "intact",
        sterilizedOn: "2020-01-01",
        sterilizedBy: "Dr. X",
      },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    expect(created.animal.sterilizedOn).toBeNull();
    expect(created.animal.sterilizedBy).toBeNull();
  });

  test("a spay procedure marks the animal sterilized and fills empty fields", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const proc = await createProcedure(
      {
        animalId: created.animal.id,
        kind: "spay",
        performedOn: "2026-01-15",
        provider: "Dr. Vet",
        description: "Routine spay",
      },
      STAFF,
      db,
    );
    expect(proc.ok).toBe(true);

    const s = await getAnimalSterilization(created.animal.id, db);
    expect(s?.status).toBe("sterilized");
    expect(s?.sterilizedOn).toBe("2026-01-15");
    expect(s?.sterilizedBy).toBe("Dr. Vet");
    expect(s?.evidence).toHaveLength(1);
    expect(await auditActions("animal")).toContain("sterilization-sync");
  });

  test("procedure evidence never overwrites an asserted fact", async () => {
    const created = await createAnimal(
      {
        ...BASE,
        sterilizationStatus: "sterilized",
        sterilizedOn: "2019-06-01",
        sterilizedBy: "Off-island vet",
      },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    await createProcedure(
      {
        animalId: created.animal.id,
        kind: "neuter",
        performedOn: "2026-01-15",
        provider: "Dr. Vet",
        description: "Records show prior neuter",
      },
      STAFF,
      db,
    );
    const s = await getAnimalSterilization(created.animal.id, db);
    // Earlier asserted date/provider wins; the procedure is evidence,
    // not an overwrite.
    expect(s?.sterilizedOn).toBe("2019-06-01");
    expect(s?.sterilizedBy).toBe("Off-island vet");
    expect(s?.evidence).toHaveLength(1);
  });

  test("non-spay/neuter procedures do not touch the summary", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    await createProcedure(
      {
        animalId: created.animal.id,
        kind: "dental",
        performedOn: "2026-01-15",
        description: "Cleaning",
      },
      STAFF,
      db,
    );
    const s = await getAnimalSterilization(created.animal.id, db);
    expect(s?.status).toBe("unknown");
    expect(s?.evidence).toHaveLength(0);
  });
});

describe("registry independence", () => {
  test("an animal with no owner/registration/vet/portal records exists and is findable", async () => {
    const created = await createAnimal(
      { ...BASE, name: "Lone Cat", species: "cat", sex: "female" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    const hits = await searchAnimals("Lone Cat", {}, db);
    expect(hits.map((h) => h.animal.id)).toContain(created.animal.id);
  });

  test("a lapsed registration never removes the animal", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    await db.insert(schema.registrations).values({
      animalId: created.animal.id,
      year: 2024,
      status: "approved",
    });
    const ctx = await getAnimalRegistryContext(created.animal.id, db);
    expect(ctx?.registrations).toHaveLength(1);
    // No 2025 registration — the animal is still in the registry.
    const hits = await searchAnimals(BASE.name, {}, db);
    expect(hits.map((h) => h.animal.id)).toContain(created.animal.id);
  });

  test("deleting an animal with registry history is refused by FK", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    const owner = await seedPerson();
    await createOwnership(
      { animalId: created.animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await transitionAnimalLifecycle(
      created.animal.id,
      { toStatus: "deceased", source: "staff", actorLabel: STAFF },
      db,
    );
    // Restrictive FKs on ownerships + lifecycle events make hard delete
    // fail loudly — history cannot be orphaned.
    await expect(deleteAnimal(created.animal.id, STAFF, db)).rejects.toThrow();
    expect(await getAdminAnimal(created.animal.id, db)).not.toBeNull();
  });
});

describe("staff search", () => {
  test("matches name, registry ref, owner, chip, and filters by lifecycle", async () => {
    const created = await createAnimal(
      { ...BASE, name: "Whiskers" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    const id = created.animal.id;

    const owner = await seedPerson("w@example.com", "Wanda Whiskers");
    await createOwnership(
      { animalId: id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await db.insert(schema.microchipRecords).values({
      animalId: id,
      chipNumber: "985113001234567",
      assignedFrom: "2025-01-01",
    });

    const byName = await searchAnimals("whiskers", {}, db);
    expect(byName.map((h) => h.animal.id)).toContain(id);
    // Name match is ambiguous (owner name also matches) — but hit
    // carries owner + chip labels.
    const hit = byName.find((h) => h.animal.id === id)!;
    expect(hit.owners).toContain("Wanda Whiskers");
    expect(hit.microchips).toContain("985113001234567");

    const byRef = await searchAnimals(created.animal.registryRef, {}, db);
    expect(byRef.map((h) => h.animal.id)).toContain(id);

    const byChip = await searchAnimals("985-113-001-234-567", {}, db);
    expect(byChip.map((h) => h.animal.id)).toContain(id);

    const byUuid = await searchAnimals(id, {}, db);
    expect(byUuid.map((h) => h.animal.id)).toContain(id);

    // Lifecycle filter.
    await transitionAnimalLifecycle(
      id,
      { toStatus: "deceased", source: "staff", actorLabel: STAFF },
      db,
    );
    expect(
      await searchAnimals("Whiskers", { lifecycleStatus: "active" }, db),
    ).toHaveLength(0);
    const deceased = await searchAnimals(
      "Whiskers",
      { lifecycleStatus: "deceased" },
      db,
    );
    expect(deceased.map((h) => h.animal.id)).toContain(id);
    // Unfiltered search still finds non-active animals — they never
    // disappear from the registry.
    expect(
      (await searchAnimals("Whiskers", {}, db)).map((h) => h.animal.id),
    ).toContain(id);
  });

  test("a closed chip assignment is not reported as active in results", async () => {
    const created = await createAnimal(BASE, STAFF, db);
    if (!created.ok) throw new Error("setup");
    await db.insert(schema.microchipRecords).values({
      animalId: created.animal.id,
      chipNumber: "111222333444555",
      assignedFrom: "2020-01-01",
      assignedTo: "2024-01-01", // reassigned away — closed assignment
      closedReason: "removed",
    });
    const hits = await searchAnimals(BASE.name, {}, db);
    const hit = hits.find((h) => h.animal.id === created.animal.id);
    expect(hit?.microchips).toEqual([]);
  });
});

describe("public/adoption separation", () => {
  test("public listing requires adoption 'available' AND lifecycle 'active'", async () => {
    const mk = async (name: string, extra = {}) => {
      const c = await createAnimal(
        { ...BASE, name, adoptionStatus: "available", ...extra },
        STAFF,
        db,
      );
      if (!c.ok) throw new Error("setup");
      return c.animal;
    };
    const listed = await mk("Listed");
    const notListed = await createAnimal(
      { ...BASE, name: "Private", adoptionStatus: "not-listed" },
      STAFF,
      db,
    );
    if (!notListed.ok) throw new Error("setup");
    const adopted = await mk("Homed", { adoptionStatus: "adopted" });
    const deceased = await mk("Gone");
    await transitionAnimalLifecycle(
      deceased.id,
      { toStatus: "deceased", source: "staff", actorLabel: STAFF },
      db,
    );

    const publicList = await listPublicAnimals(db);
    const ids = publicList.map((a) => a.id);
    expect(ids).toContain(listed.id);
    expect(ids).not.toContain(notListed.animal.id);
    expect(ids).not.toContain(adopted.id);
    expect(ids).not.toContain(deceased.id);

    // Detail-by-id fails closed for anything not public — even though
    // the uuid resolves to a real registry row.
    expect(await getPublicAnimalById(db, deceased.id)).toBeNull();
    expect(await getPublicAnimalById(db, listed.id)).not.toBeNull();
  });

  test("public DTO carries no registry internals", async () => {
    const created = await createAnimal(
      {
        ...BASE,
        adoptionStatus: "available",
        identifyingNotes: "INTERNAL: bite history",
        sterilizationStatus: "sterilized",
      },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    const dto = await getPublicAnimalById(db, created.animal.id);
    expect(dto).not.toBeNull();
    const keys = Object.keys(dto!).sort();
    expect(keys).toEqual(
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
});
