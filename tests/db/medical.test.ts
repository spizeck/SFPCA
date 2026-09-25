// Veterinary continuity domain tests (#174), run against PGlite — real
// Postgres semantics for transactions, CHECK constraints, FK integrity,
// optimistic concurrency, and the audit trail. Pure helpers are covered
// by tests/medical.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import { deleteAnimal } from "@/lib/registry/animals";
import { createVaccination } from "@/lib/registry/vaccinations";
import {
  createAlert,
  createEncounter,
  createMedication,
  createProcedure,
  createWeightRecord,
  listEncountersForAnimal,
  listFollowUpsForAnimal,
  listMedicalTimeline,
  updateAlert,
  updateEncounter,
  updateMedication,
  updateProcedure,
} from "@/lib/registry/medical";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

// All clinical dates are safely in the past — clinical events describe
// what happened, so the service rejects future dates.
const VISIT = {
  kind: "visit",
  occurredOn: "2026-06-01",
  reason: "Limping",
  provider: "Dr. Rotating",
};

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

async function seedOwnedAnimal(name = "Owned") {
  const animal = await seedAnimal(name);
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName: "Jane Owner", email: "jane@example.com" })
    .returning();
  await db.insert(schema.ownerships).values({
    animalId: animal.id,
    personId: person.id,
    validFrom: "2025-01-01",
  });
  return { animal, person };
}

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("encounters", () => {
  test("create + list round-trips fields, newest first, and audits", async () => {
    const animal = await seedAnimal("Bella");

    const older = await createEncounter(
      {
        animalId: animal.id,
        kind: "history",
        occurredOn: "2025-01-15",
        reason: "Reported: hit by car (unverified)",
      },
      "volunteer@test.dev",
      db,
    );
    expect(older.ok).toBe(true);

    const newer = await createEncounter(
      {
        animalId: animal.id,
        ...VISIT,
        complaint: "Hind-limb lameness, 2 days",
        findings: "Pain on hip extension",
        assessment: "Suspect soft-tissue injury",
        plan: "Rest, NSAID, recheck 2 weeks",
      },
      "vet@test.dev",
      db,
    );
    if (!newer.ok) throw new Error("setup failed");

    const list = await listEncountersForAnimal(animal.id, db);
    expect(list).toHaveLength(2);
    expect(list[0].reason).toBe("Limping");
    expect(list[0]).toMatchObject({
      kind: "visit",
      provider: "Dr. Rotating",
      assessment: "Suspect soft-tissue injury",
    });
    // Provider attribution is a recorded fact — free text, not a login.
    expect(list[1].provider).toBeNull();

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, newer.record.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      entityType: "vet_encounter",
      actorLabel: "vet@test.dev",
    });
  });

  test("a visit requires a reason; history and notes do not", async () => {
    const animal = await seedAnimal("Reasonless");
    const noReason = await createEncounter(
      { animalId: animal.id, kind: "visit", occurredOn: "2026-06-01" },
      "vet@test.dev",
      db,
    );
    expect(noReason).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "reason",
    });

    const history = await createEncounter(
      {
        animalId: animal.id,
        kind: "history",
        occurredOn: "2026-06-01",
        notes: "Owner reports prior ear infection",
      },
      "vet@test.dev",
      db,
    );
    expect(history.ok).toBe(true);
  });

  test("rejects an invalid kind and a future date", async () => {
    const animal = await seedAnimal("BadInput");
    expect(
      await createEncounter(
        { animalId: animal.id, kind: "surgery", occurredOn: "2026-06-01" },
        "vet@test.dev",
        db,
      ),
    ).toMatchObject({ ok: false, field: "kind" });
    expect(
      await createEncounter(
        {
          animalId: animal.id,
          kind: "note",
          occurredOn: "2999-01-01",
        },
        "vet@test.dev",
        db,
      ),
    ).toMatchObject({ ok: false, field: "occurredOn" });
  });

  test("update corrects fields, guards stale updatedAt, and audits", async () => {
    const animal = await seedAnimal("Corrections");
    const created = await createEncounter(
      { animalId: animal.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    const before = created.record;

    const stale = await updateEncounter(
      before.id,
      { animalId: animal.id, ...VISIT, assessment: "Stale write" },
      "1999-01-01T00:00:00.000Z",
      "vet2@test.dev",
      db,
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });

    const updated = await updateEncounter(
      before.id,
      { animalId: animal.id, ...VISIT, assessment: "Confirmed sprain" },
      before.updatedAt,
      "vet2@test.dev",
      db,
    );
    if (!updated.ok) throw new Error("update failed");
    expect(updated.record.assessment).toBe("Confirmed sprain");

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, before.id));
    expect(audit.map((a) => a.action)).toEqual(["create", "update"]);
    expect(audit[1].actorLabel).toBe("vet2@test.dev");
  });

  test("create can atomically record a weight and schedule a recheck", async () => {
    const { animal, person } = await seedOwnedAnimal("Convenience");
    const created = await createEncounter(
      {
        animalId: animal.id,
        ...VISIT,
        weightGrams: 12400,
        followUp: { dueOn: "2026-07-01", reason: "Recheck limp" },
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");

    const timeline = await listMedicalTimeline(animal.id, db);
    const weight = timeline.find((i) => i.kind === "weight");
    expect(weight).toMatchObject({
      kind: "weight",
      date: "2026-06-01",
      record: { weightGrams: 12400, encounterId: created.record.id },
    });

    const followUps = await listFollowUpsForAnimal(animal.id, db);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      kind: "recheck",
      dueOn: "2026-07-01",
      reason: "Recheck limp",
      status: "open",
      encounterId: created.record.id,
      // The owner valid today is snapshotted so #175 doesn't re-derive.
      personId: person.id,
    });
  });
});

describe("procedures, medications, alerts, weights", () => {
  test("procedures record sterilization and link to an encounter", async () => {
    const animal = await seedAnimal("Sterilize");
    const enc = await createEncounter(
      { animalId: animal.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");

    const spay = await createProcedure(
      {
        animalId: animal.id,
        encounterId: enc.record.id,
        kind: "spay",
        performedOn: "2026-06-01",
        provider: "Dr. Rotating",
        description: "Ovariohysterectomy, routine",
      },
      "vet@test.dev",
      db,
    );
    if (!spay.ok) throw new Error("spay failed");
    expect(spay.record).toMatchObject({
      kind: "spay",
      encounterId: enc.record.id,
    });

    // Unknown-date historical procedure — allowed, sorts last.
    const hist = await createProcedure(
      {
        animalId: animal.id,
        kind: "surgery",
        description: "Reported prior leg surgery",
      },
      "vet@test.dev",
      db,
    );
    expect(hist.ok).toBe(true);
    if (hist.ok) expect(hist.record.performedOn).toBeNull();

    expect(
      await createProcedure(
        {
          animalId: animal.id,
          kind: "acupuncture",
          description: "x",
        },
        "vet@test.dev",
        db,
      ),
    ).toMatchObject({ ok: false, field: "kind" });
  });

  test("medications record a course; endOn must not precede startOn", async () => {
    const animal = await seedAnimal("Meds");
    const created = await createMedication(
      {
        animalId: animal.id,
        medication: "Doxycycline",
        dose: "10 mg/kg",
        route: "oral",
        frequency: "BID",
        startOn: "2026-06-01",
        endOn: "2026-06-14",
        prescribedBy: "Dr. Rotating",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    expect(created.record).toMatchObject({
      medication: "Doxycycline",
      dose: "10 mg/kg",
      prescribedBy: "Dr. Rotating",
    });

    expect(
      await createMedication(
        {
          animalId: animal.id,
          medication: "x",
          startOn: "2026-06-10",
          endOn: "2026-06-01",
        },
        "vet@test.dev",
        db,
      ),
    ).toMatchObject({ ok: false, field: "endOn" });

    const updated = await updateMedication(
      created.record.id,
      {
        animalId: animal.id,
        medication: "Doxycycline",
        startOn: "2026-06-01",
        endOn: "2026-06-21", // course extended
      },
      created.record.updatedAt,
      "vet@test.dev",
      db,
    );
    if (!updated.ok) throw new Error("update failed");
    expect(updated.record.endOn).toBe("2026-06-21");
  });

  test("alerts support the active → resolved lifecycle", async () => {
    const animal = await seedAnimal("Alerted");
    const created = await createAlert(
      {
        animalId: animal.id,
        kind: "allergy",
        severity: "critical",
        summary: "Penicillin allergy",
        recordedOn: "2026-06-01",
        status: "active",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    expect(created.record.status).toBe("active");

    // resolved_on is required exactly when status is 'resolved'.
    expect(
      await createAlert(
        {
          animalId: animal.id,
          kind: "condition",
          severity: "info",
          summary: "Resolved without date",
          recordedOn: "2026-06-01",
          status: "resolved",
        },
        "vet@test.dev",
        db,
      ),
    ).toMatchObject({ ok: false, field: "resolvedOn" });

    const resolved = await updateAlert(
      created.record.id,
      {
        animalId: animal.id,
        kind: "allergy",
        severity: "critical",
        summary: "Penicillin allergy",
        recordedOn: "2026-06-01",
        status: "resolved",
        resolvedOn: "2026-09-01",
      },
      created.record.updatedAt,
      "vet@test.dev",
      db,
    );
    if (!resolved.ok) throw new Error("resolve failed");
    expect(resolved.record).toMatchObject({
      status: "resolved",
      resolvedOn: "2026-09-01",
    });
  });

  test("weights store unambiguous integer grams", async () => {
    const animal = await seedAnimal("Weighed");
    const created = await createWeightRecord(
      {
        animalId: animal.id,
        measuredOn: "2026-06-01",
        weightGrams: 12400,
        notes: "BCS 4/9",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    expect(created.record.weightGrams).toBe(12400);

    // Out-of-range and future dates are rejected before the CHECK fires.
    for (const input of [
      { weightGrams: 0, measuredOn: "2026-06-01" },
      { weightGrams: 999_999, measuredOn: "2026-06-01" },
      { weightGrams: 12400, measuredOn: "2999-01-01" },
    ]) {
      expect(
        await createWeightRecord(
          { animalId: animal.id, ...input },
          "vet@test.dev",
          db,
        ),
      ).toMatchObject({ ok: false });
    }
  });
});

describe("timeline and historical integrity", () => {
  test("the timeline interleaves all record types, newest first", async () => {
    const animal = await seedAnimal("Timeline");
    const enc = await createEncounter(
      { animalId: animal.id, ...VISIT, occurredOn: "2026-05-01" },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-05-15",
        dueOn: "2027-05-15",
        encounterId: enc.record.id,
      },
      "vet@test.dev",
      db,
    );
    await createMedication(
      {
        animalId: animal.id,
        medication: "Doxycycline",
        startOn: "2026-06-01",
      },
      "vet@test.dev",
      db,
    );
    await createProcedure(
      {
        animalId: animal.id,
        kind: "other",
        description: "Undated historical procedure",
      },
      "vet@test.dev",
      db,
    );

    const timeline = await listMedicalTimeline(animal.id, db);
    expect(timeline.map((i) => i.kind)).toEqual([
      "medication",
      "vaccination",
      "encounter",
      "procedure", // undated sinks last
    ]);
    const vax = timeline[1];
    expect(vax.kind === "vaccination" && vax.record.encounterId).toBe(
      enc.record.id,
    );
  });

  test("deleting an animal with clinical history fails loudly", async () => {
    const animal = await seedAnimal("Protected");
    const enc = await createEncounter(
      { animalId: animal.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");

    await expect(
      deleteAnimal(animal.id, "admin@test.dev", db),
    ).rejects.toThrow();
    expect(await listEncountersForAnimal(animal.id, db)).toHaveLength(1);
  });

  test("deleting an encounter with a linked vaccination fails loudly", async () => {
    const animal = await seedAnimal("Linked");
    const enc = await createEncounter(
      { animalId: animal.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");
    const vax = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
        encounterId: enc.record.id,
      },
      "vet@test.dev",
      db,
    );
    if (!vax.ok) throw new Error("setup failed");

    await expect(
      db
        .delete(schema.vetEncounters)
        .where(eq(schema.vetEncounters.id, enc.record.id)),
    ).rejects.toThrow();
  });

  test("a vaccination cannot link to another animal's encounter", async () => {
    const mine = await seedAnimal("Mine");
    const theirs = await seedAnimal("Theirs");
    const enc = await createEncounter(
      { animalId: theirs.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");

    const result = await createVaccination(
      {
        animalId: mine.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
        encounterId: enc.record.id, // belongs to a different animal
      },
      "vet@test.dev",
      db,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "encounterId",
    });
  });

  test("an update cannot sneak a cross-animal encounter link via a stale animalId", async () => {
    const mine = await seedAnimal("Mine2");
    const theirs = await seedAnimal("Theirs2");
    const enc = await createEncounter(
      { animalId: theirs.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    const proc = await createProcedure(
      { animalId: mine.id, kind: "dental", description: "Cleaning" },
      "vet@test.dev",
      db,
    );
    if (!enc.ok || !proc.ok) throw new Error("setup failed");

    // animalId is write-once — a caller passing the WRONG animalId must
    // not be able to link the row to that animal's encounter. The check
    // runs against the locked row's animalId.
    const result = await updateProcedure(
      proc.record.id,
      {
        animalId: theirs.id, // stale/forged — the row belongs to `mine`
        encounterId: enc.record.id,
        kind: "dental",
        description: "Cleaning",
      },
      proc.record.updatedAt,
      "vet@test.dev",
      db,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "encounterId",
    });
  });

  test("a linked vaccination still appears in the due projection", async () => {
    const animal = await seedAnimal("DueLinked");
    const enc = await createEncounter(
      { animalId: animal.id, ...VISIT },
      "vet@test.dev",
      db,
    );
    if (!enc.ok) throw new Error("setup failed");
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-10-01",
        dueOn: "2026-10-10",
        encounterId: enc.record.id,
      },
      "vet@test.dev",
      db,
    );

    // Encounter linkage must not disturb #173's series semantics.
    const { listDueVaccinations } = await import(
      "@/lib/registry/vaccinations"
    );
    const due = await listDueVaccinations({ asOf: "2026-10-05" }, db);
    const mine = due.filter((d) => d.vaccination.animalId === animal.id);
    expect(mine).toHaveLength(1);
  });
});
