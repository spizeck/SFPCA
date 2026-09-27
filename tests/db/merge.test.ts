// Animal merge tests (#178), run against PGlite so real Postgres
// semantics apply: row locks, unique constraints, restrictive FKs.
//
// The properties under test are the issue's safety contract:
//   - a merge is one transaction — history reparents, nothing is
//     deleted, and the retired identity persists as 'merged' lineage;
//   - preview is authoritative: execute re-analyzes under locks and a
//     stale fingerprint refuses to blind-apply;
//   - hard conflicts (two current chips, two open same-type lost/found
//     cases) block rather than guess;
//   - same-year registration collisions never violate (animal, year)
//     uniqueness — the retired row keeps its cancelled registration and
//     its payment history;
//   - retired identifiers still resolve for staff search, and merged
//     rows never appear as ordinary animals;
//   - deleteAnimal can no longer bypass the history-preservation
//     contract.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  createAnimal,
  deleteAnimal,
  listAdminAnimals,
  searchAnimals,
} from "@/lib/registry/animals";
import {
  executeAnimalMerge,
  getAnimalMergeInfo,
  getMergePair,
  previewAnimalMerge,
  resolveAnimalMergeTarget,
} from "@/lib/registry/merge";
import { createOwnership, listOwnershipHistory } from "@/lib/registry/ownership";
import {
  createRegistration,
  recordRegistrationPayment,
} from "@/lib/registry/registrations";
import { assignMicrochip } from "@/lib/registry/microchips";
import { openMissingCase } from "@/lib/registry/lost-found";
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
  // Wipe every animal-referencing table so each test starts empty.
  await db.execute(
    sql`TRUNCATE animal_merges, data_quality_reviews, payments, registrations, microchip_conflicts, microchip_records, lost_found_cases, vaccinations, vet_encounters, vet_procedures, vet_medications, medical_alerts, weight_records, vet_documents, follow_ups, clinic_expectations, communications, owner_requests, ownership_confirmations, ownerships, animal_lifecycle_events, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

async function seedAnimal(
  opts: Partial<typeof schema.animals.$inferInsert> = {},
) {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: "Bella",
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      adoptionStatus: "not-listed",
      ...opts,
    })
    .returning();
  return animal;
}

async function seedPerson(
  fullName = "Jane Owner",
  extra: Partial<typeof schema.persons.$inferInsert> = {},
) {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName, ...extra })
    .returning();
  return person;
}

async function pair() {
  const survivor = await seedAnimal({ name: "Bella" });
  const retired = await seedAnimal({ name: "Bella" });
  return { survivor, retired };
}

async function merge(
  survivorId: string,
  retiredId: string,
  extra: Partial<Parameters<typeof executeAnimalMerge>[0]> = {},
) {
  const preview = await previewAnimalMerge(survivorId, retiredId, db);
  if (!preview.ok) throw new Error(`preview failed: ${preview.message}`);
  const fieldChoices = Object.fromEntries(
    preview.preview.fieldConflicts.map((c) => [c.field, "survivor" as const]),
  );
  return executeAnimalMerge(
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

describe("merge preview", () => {
  test("rejects self-merge before any work", async () => {
    const a = await seedAnimal();
    const r = await previewAnimalMerge(a.id, a.id, db);
    expect(r.ok).toBe(false);
  });

  test("shows field conflicts when records disagree", async () => {
    const survivor = await seedAnimal({ name: "Bella", species: "dog" });
    const retired = await seedAnimal({
      name: "Bella",
      species: "cat",
      birthDate: "2020-01-01",
    });
    const r = await previewAnimalMerge(survivor.id, retired.id, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.preview.fieldConflicts.map((c) => c.field);
    expect(fields).toContain("species");
    // One-sided values auto-fill rather than conflict.
    expect(fields).not.toContain("birthDate");
    expect(
      r.preview.autoNotes.some((n) => n.includes("Birth date filled")),
    ).toBe(true);
  });

  test("blocks when both records hold a different current microchip", async () => {
    const survivor = await seedAnimal();
    const retired = await seedAnimal();
    await assignMicrochip(
      { animalId: survivor.id, chipNumber: "111111111111111" },
      STAFF,
      db,
    );
    await assignMicrochip(
      { animalId: retired.id, chipNumber: "222222222222222" },
      STAFF,
      db,
    );
    const r = await previewAnimalMerge(survivor.id, retired.id, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.blockers.map((b) => b.code)).toContain(
      "incompatible-chips",
    );
    const m = await merge(survivor.id, retired.id);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toBe("blocked");
  });

  test("blocks when both records hold an open missing case", async () => {
    const survivor = await seedAnimal();
    const retired = await seedAnimal();
    await openMissingCase(
      { animalId: survivor.id, lastSeenOn: "2026-01-01" },
      STAFF,
      db,
    );
    await openMissingCase(
      { animalId: retired.id, lastSeenOn: "2026-01-02" },
      STAFF,
      db,
    );
    const r = await previewAnimalMerge(survivor.id, retired.id, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.blockers.map((b) => b.code)).toContain(
      "open-missing-cases",
    );
  });
});

describe("merge execution", () => {
  test("happy path retires the duplicate and moves all history", async () => {
    const person = await seedPerson();
    // Created through the service so each record carries a real
    // "entered the registry" lifecycle event — its move is what the
    // history-reparenting assertion checks.
    const mk = async () => {
      const r = await createAnimal(
        {
          name: "Bella",
          species: "dog",
          sex: "female",
          adoptionStatus: "not-listed",
        },
        STAFF,
        db,
      );
      if (!r.ok) throw new Error("seed failed");
      return r.animal;
    };
    const survivor = await mk();
    const retired = await mk();
    await createOwnership(
      { animalId: retired.id, personId: person.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );
    await assignMicrochip(
      { animalId: retired.id, chipNumber: "985113000000001" },
      STAFF,
      db,
    );
    const reg = await createRegistration(
      { animalId: retired.id, year: 2025, amountDueCents: 1500 },
      STAFF,
      db,
    );
    expect(reg.ok).toBe(true);
    await db.insert(schema.vaccinations).values({
      animalId: retired.id,
      vaccineName: "Rabies",
      administeredOn: "2025-06-15",
    });

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Retired identity persists as 'merged' lineage.
    const [retiredRow] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, retired.id));
    expect(retiredRow.lifecycleStatus).toBe("merged");
    expect(retiredRow.adoptionStatus).toBe("not-listed");

    const [mergeRow] = await db
      .select()
      .from(schema.animalMerges)
      .where(eq(schema.animalMerges.retiredAnimalId, retired.id));
    expect(mergeRow.survivorAnimalId).toBe(survivor.id);
    expect(mergeRow.retiredRegistryRef).toBe(retired.registryRef);
    expect(mergeRow.mergedByLabel).toBe(STAFF);

    // History reparented to the survivor.
    const survivorOwnerships = await listOwnershipHistory(survivor.id, db);
    expect(survivorOwnerships.length).toBe(1);
    expect(survivorOwnerships[0].ownerName).toBe("Jane Owner");
    const retiredOwnerships = await listOwnershipHistory(retired.id, db);
    expect(retiredOwnerships.length).toBe(0);

    const chips = await db
      .select()
      .from(schema.microchipRecords)
      .where(eq(schema.microchipRecords.animalId, survivor.id));
    expect(chips.length).toBe(1);
    expect(chips[0].chipNumber).toBe("985113000000001");

    const regs = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.animalId, survivor.id));
    expect(regs.length).toBe(1);

    const vax = await db
      .select()
      .from(schema.vaccinations)
      .where(eq(schema.vaccinations.animalId, survivor.id));
    expect(vax.length).toBe(1);

    // Terminal lifecycle event recorded on the retired record, source
    // 'merge' — and the retired record's prior history moved too.
    const events = await db
      .select()
      .from(schema.animalLifecycleEvents)
      .where(eq(schema.animalLifecycleEvents.animalId, retired.id));
    expect(events.some((e) => e.toStatus === "merged")).toBe(true);
    const survivorEvents = await db
      .select()
      .from(schema.animalLifecycleEvents)
      .where(eq(schema.animalLifecycleEvents.animalId, survivor.id));
    // Survivor keeps its own history AND inherits the retired record's.
    expect(survivorEvents.length).toBeGreaterThanOrEqual(2);

    // Audit: one retire event + one absorb event.
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, "animal"));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("merge-retire");
    expect(actions).toContain("merge-absorb");

    // The pair's duplicate review is recorded as confirmed.
    const [a, b] = [survivor.id, retired.id].sort();
    const [review] = await db
      .select()
      .from(schema.dataQualityReviews)
      .where(
        and(
          eq(schema.dataQualityReviews.detector, "duplicate-animal"),
          eq(schema.dataQualityReviews.entityA, a),
          eq(schema.dataQualityReviews.entityB, b),
        ),
      );
    expect(review.decision).toBe("confirmed");
  });

  test("a merge cannot target itself", async () => {
    const a = await seedAnimal();
    const r = await executeAnimalMerge(
      {
        survivorId: a.id,
        retiredId: a.id,
        fieldChoices: {},
        fingerprint: "x",
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(false);
  });

  test("an already-merged record cannot merge again (no chains)", async () => {
    const canonical = await seedAnimal({ name: "Bella" });
    const dup = await seedAnimal({ name: "Bella" });
    const third = await seedAnimal({ name: "Bella" });
    const first = await merge(canonical.id, dup.id);
    expect(first.ok).toBe(true);
    // Retired record as survivor OR as retired — both refused.
    const asSurvivor = await previewAnimalMerge(dup.id, third.id, db);
    expect(asSurvivor.ok).toBe(true);
    if (asSurvivor.ok) {
      expect(
        asSurvivor.preview.blockers.map((b) => b.code),
      ).toContain("already-merged");
    }
    const asRetired = await previewAnimalMerge(third.id, dup.id, db);
    expect(asRetired.ok).toBe(true);
    if (asRetired.ok) {
      expect(
        asRetired.preview.blockers.map((b) => b.code),
      ).toContain("already-merged");
    }
  });

  test("a stale preview fingerprint refuses to apply", async () => {
    const { survivor, retired } = await pair();
    const r = await executeAnimalMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: "not-the-real-fingerprint",
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
  });

  test("changing the records after preview makes the fingerprint stale", async () => {
    const { survivor, retired } = await pair();
    const preview = await previewAnimalMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    // Something changed between preview and execute — a new ownership.
    const person = await seedPerson();
    await createOwnership(
      { animalId: retired.id, personId: person.id, validFrom: todayIsoDate() },
      STAFF,
      db,
    );
    const r = await executeAnimalMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
    const [row] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, retired.id));
    expect(row.lifecycleStatus).not.toBe("merged");
  });

  test("missing field choices are rejected before mutating", async () => {
    const survivor = await seedAnimal({ species: "dog" });
    const retired = await seedAnimal({ species: "cat" });
    const preview = await previewAnimalMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    const r = await executeAnimalMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid");
      expect(r.missingFields).toContain("species");
    }
  });
});

describe("registration collisions", () => {
  test("same-year registrations: survivor keeps authority, retired keeps cancelled history + payments", async () => {
    const { survivor, retired } = await pair();
    for (const animal of [survivor, retired]) {
      const reg = await createRegistration(
        { animalId: animal.id, year: 2026, amountDueCents: 1500 },
        STAFF,
        db,
      );
      if (!reg.ok) throw new Error("registration failed");
      await recordRegistrationPayment(
        reg.registration.id,
        { amountCents: 1500, method: "cash" },
        STAFF,
        db,
      );
    }
    // A non-colliding year on the retired record reparents cleanly.
    const older = await createRegistration(
      { animalId: retired.id, year: 2025, amountDueCents: 1500 },
      STAFF,
      db,
    );
    expect(older.ok).toBe(true);

    const preview = await previewAnimalMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    expect(preview.preview.registrationCollisions.map((c) => c.year)).toEqual([
      2026,
    ]);

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Survivor: its own 2026 + the reparented 2025.
    const survivorRegs = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.animalId, survivor.id));
    expect(
      survivorRegs
        .map((r) => `${r.year}:${r.status}`)
        .sort(),
    ).toEqual(["2025:active", "2026:active"]);

    // Retired: its 2026 stays, cancelled as a correction — the payment
    // rows are still attached to that registration.
    const retiredRegs = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.animalId, retired.id));
    expect(retiredRegs.length).toBe(1);
    expect(retiredRegs[0].year).toBe(2026);
    expect(retiredRegs[0].status).toBe("cancelled");
    expect(retiredRegs[0].cancellationReason).toBe("correction");
    const orphanCheck = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM payments p
      LEFT JOIN registrations r ON r.id = p.registration_id
      WHERE r.id IS NULL
    `);
    expect(orphanCheck.rows[0].n).toBe(0);
    const retiredPayments = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.registrationId, retiredRegs[0].id));
    expect(retiredPayments.length).toBeGreaterThan(0);
  });
});

describe("ownership merge", () => {
  test("same-owner duplicate open intervals close instead of doubling", async () => {
    const person = await seedPerson();
    const { survivor, retired } = await pair();
    await createOwnership(
      { animalId: survivor.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: retired.id, personId: person.id, validFrom: "2025-02-01" },
      STAFF,
      db,
    );
    const r = await merge(survivor.id, retired.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The survivor keeps exactly one open interval to that person; the
    // duplicate closed on the retired record.
    const survivorOwn = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, survivor.id));
    const open = survivorOwn.filter((o) => o.validTo === null);
    expect(open.length).toBe(1);
    const retiredOwn = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, retired.id));
    expect(retiredOwn.length).toBe(1);
    expect(retiredOwn[0].validTo).not.toBeNull();
  });

  test("distinct owners both carry forward", async () => {
    const p1 = await seedPerson("Owner One");
    const p2 = await seedPerson("Owner Two");
    const { survivor, retired } = await pair();
    await createOwnership(
      { animalId: survivor.id, personId: p1.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: retired.id, personId: p2.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const r = await merge(survivor.id, retired.id);
    expect(r.ok).toBe(true);
    const survivorOwn = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, survivor.id));
    expect(survivorOwn.length).toBe(2);
  });
});

describe("microchip merge", () => {
  test("retired chip history moves; corrected rows stay", async () => {
    const { survivor, retired } = await pair();
    const assign = await assignMicrochip(
      { animalId: retired.id, chipNumber: "985113000000002" },
      STAFF,
      db,
    );
    expect(assign.ok).toBe(true);
    // Mark a typo'd row corrected — it must NOT move.
    await db.insert(schema.microchipRecords).values({
      animalId: retired.id,
      chipNumber: "999900000000004",
      chipDisplay: "9999 0000 0000 0004",
      assignedFrom: "2024-01-01",
      assignedTo: "2024-01-02",
      closedReason: "corrected",
    });
    const r = await merge(survivor.id, retired.id);
    expect(r.ok).toBe(true);
    const survivorChips = await db
      .select()
      .from(schema.microchipRecords)
      .where(eq(schema.microchipRecords.animalId, survivor.id));
    expect(survivorChips.map((c) => c.chipNumber)).toEqual([
      "985113000000002",
    ]);
    const retiredChips = await db
      .select()
      .from(schema.microchipRecords)
      .where(eq(schema.microchipRecords.animalId, retired.id));
    expect(retiredChips.map((c) => c.chipNumber)).toEqual([
      "999900000000004",
    ]);
  });

  test("a chip conflict between the two merged records self-resolves", async () => {
    const { survivor, retired } = await pair();
    // Direct insert: the conflict row is #168's evidence trail.
    await db.insert(schema.microchipConflicts).values({
      chipNumber: "985113000000009",
      claimedAnimalId: retired.id,
      existingAnimalId: survivor.id,
      source: "staff",
      detail: "scan collision",
    });
    const r = await merge(survivor.id, retired.id);
    expect(r.ok).toBe(true);
    const conflicts = await db
      .select()
      .from(schema.microchipConflicts);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].status).toBe("resolved");
    expect(conflicts[0].claimedAnimalId).toBe(survivor.id);
    expect(conflicts[0].existingAnimalId).toBe(survivor.id);
  });
});

describe("retired-identity resolution", () => {
  test("merge lineage resolves the retired uuid and registry ref", async () => {
    const { survivor, retired } = await pair();
    const retiredRef = retired.registryRef;
    await merge(survivor.id, retired.id);

    const info = await getAnimalMergeInfo(retired.id, db);
    expect(info?.status).toBe("merged");
    expect(info?.survivor?.id).toBe(survivor.id);

    const target = await resolveAnimalMergeTarget(retired.id, db);
    expect(target?.canonicalId).toBe(survivor.id);
    expect(target?.wasMerged).toBe(true);

    // Search by retired registry ref finds the retired record annotated
    // with its survivor — not as an ordinary animal.
    const hits = await searchAnimals(retiredRef, {}, db);
    expect(hits.length).toBe(1);
    expect(hits[0].animal.id).toBe(retired.id);
    expect(hits[0].mergedInto?.id).toBe(survivor.id);
    expect(hits[0].mergedInto?.registryRef).toBe(survivor.registryRef);

    // Searching the retired uuid behaves the same.
    const uuidHits = await searchAnimals(retired.id, {}, db);
    expect(uuidHits.length).toBe(1);
    expect(uuidHits[0].mergedInto?.id).toBe(survivor.id);
  });

  test("merged records never appear in browse or fuzzy-name search", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);

    const all = await listAdminAnimals(db);
    expect(all.map((a) => a.id)).not.toContain(retired.id);
    expect(all.map((a) => a.id)).toContain(survivor.id);

    const browse = await searchAnimals("", {}, db);
    expect(browse.map((h) => h.animal.id)).not.toContain(retired.id);

    // Name-only search must not revive the retired duplicate.
    const byName = await searchAnimals("Bella", {}, db);
    expect(byName.map((h) => h.animal.id)).not.toContain(retired.id);
    expect(byName.map((h) => h.animal.id)).toContain(survivor.id);
  });
});

describe("getMergePair", () => {
  test("loads both records with owner and chip context", async () => {
    const person = await seedPerson("Pair Owner");
    const { survivor, retired } = await pair();
    await createOwnership(
      { animalId: retired.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await assignMicrochip(
      { animalId: survivor.id, chipNumber: "985113000000010" },
      STAFF,
      db,
    );
    const ctx = await getMergePair(survivor.id, retired.id, db);
    expect(ctx).not.toBeNull();
    expect(ctx!.a.animal.id).toBe(survivor.id);
    expect(ctx!.b.owners).toContain("Pair Owner");
    expect(ctx!.a.chips.length).toBe(1);
    expect(await getMergePair(survivor.id, survivor.id, db)).not.toBeNull();
    expect(
      await getMergePair("not-a-uuid", retired.id, db),
    ).toBeNull();
  });
});

describe("hard-delete policy", () => {
  test("unreferenced erroneous record deletes with an audit row", async () => {
    const animal = await seedAnimal({ name: "Typo" });
    const r = await deleteAnimal(animal.id, STAFF, db);
    expect(r.ok).toBe(true);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "delete"));
    expect(audits.length).toBe(1);
  });

  test("an animal with ANY registry history refuses deletion", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const r = await deleteAnimal(animal.id, STAFF, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("referenced");
    // The record is untouched.
    const [row] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, animal.id));
    expect(row).toBeDefined();
  });

  test("a merged record refuses deletion even if it looks empty", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);
    const r = await deleteAnimal(retired.id, STAFF, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("referenced");
  });
});
