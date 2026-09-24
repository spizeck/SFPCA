// Vaccination domain tests (#173), run against PGlite — real Postgres
// semantics for transactions, CHECK constraints, FK integrity, and the
// due/overdue query. Pure date-derivation rules live in
// tests/vaccinations.test.ts.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import { deleteAnimal } from "@/lib/registry/animals";
import {
  createVaccination,
  listDueVaccinations,
  listVaccinationsForAnimal,
  queueVaccinationReminder,
  updateVaccination,
} from "@/lib/registry/vaccinations";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

// All administered dates are safely in the past — createVaccination
// rejects future-dated doses.
const RABIES = {
  vaccineName: "Rabies",
  administeredOn: "2026-06-01",
  dueOn: "2027-06-01",
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

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("vaccination domain service", () => {
  test("create + list round-trips fields, newest first, and audits", async () => {
    const animal = await seedAnimal("Bella");

    const older = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "DHPP",
        administeredOn: "2025-06-01",
        dueOn: "2026-06-01",
        productName: "Nobivac DHPPi",
        lotNumber: "LOT-1",
        administeredBy: "Dr. A",
      },
      "vet@test.dev",
      db,
    );
    expect(older.ok).toBe(true);

    const newer = await createVaccination(
      { animalId: animal.id, ...RABIES, notes: "no reaction" },
      "vet@test.dev",
      db,
    );
    expect(newer.ok).toBe(true);
    if (!newer.ok) return;

    const history = await listVaccinationsForAnimal(animal.id, db);
    expect(history).toHaveLength(2);
    // Most recent first — the current dose is what a vet needs to see.
    expect(history[0].vaccineName).toBe("Rabies");
    expect(history[1].vaccineName).toBe("DHPP");
    expect(history[0]).toMatchObject({
      animalId: animal.id,
      administeredOn: "2026-06-01",
      dueOn: "2027-06-01",
      notes: "no reaction",
      lotNumber: null,
      documentPath: null,
    });

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, newer.vaccination.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      actorLabel: "vet@test.dev",
      entityType: "vaccination",
    });
  });

  test("update corrects fields, guards stale updatedAt, and audits", async () => {
    const animal = await seedAnimal("Corrections");
    const created = await createVaccination(
      { animalId: animal.id, ...RABIES },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    const before = created.vaccination;

    // A stale writer is rejected — no silent overwrite of a correction.
    const stale = await updateVaccination(
      before.id,
      { animalId: animal.id, ...RABIES, notes: "stale write" },
      "1999-01-01T00:00:00.000Z",
      "other@test.dev",
      db,
    );
    expect(stale).toEqual({ ok: false, reason: "conflict" });

    const updated = await updateVaccination(
      before.id,
      { animalId: animal.id, ...RABIES, lotNumber: "CORR-9" },
      before.updatedAt,
      "vet@test.dev",
      db,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.vaccination.lotNumber).toBe("CORR-9");
      // animalId is write-once — the update input carries it but the
      // record must stay attached to the same animal.
      expect(updated.vaccination.animalId).toBe(animal.id);
    }

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, before.id));
    expect(audit.map((a) => a.action).sort()).toEqual(["create", "update"]);
  });

  test("update of a missing vaccination returns not-found", async () => {
    const animal = await seedAnimal("Ghost");
    const result = await updateVaccination(
      "00000000-0000-4000-8000-000000000000",
      { animalId: animal.id, ...RABIES },
      "2026-01-01T00:00:00.000Z",
      "vet@test.dev",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("invalid input is rejected before any write", async () => {
    const animal = await seedAnimal("Valid");
    const bad = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "",
        administeredOn: "2026-06-01",
      },
      "vet@test.dev",
      db,
    );
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });

    const inverted = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
        dueOn: "2026-05-01",
      },
      "vet@test.dev",
      db,
    );
    expect(inverted).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "dueOn",
    });

    expect(await listVaccinationsForAnimal(animal.id, db)).toHaveLength(0);
  });

  test("a vaccination cannot be recorded for a missing animal", async () => {
    const result = await createVaccination(
      {
        animalId: "00000000-0000-4000-8000-000000000000",
        ...RABIES,
      },
      "vet@test.dev",
      db,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  test("deleting an animal with vaccination history fails loudly", async () => {
    const animal = await seedAnimal("History");
    const created = await createVaccination(
      { animalId: animal.id, ...RABIES },
      "vet@test.dev",
      db,
    );
    expect(created.ok).toBe(true);
    // The restrictive FK protects medical history — the delete errors
    // rather than silently erasing vaccinations.
    await expect(
      deleteAnimal(animal.id, "admin@test.dev", db),
    ).rejects.toThrow();
    const history = await listVaccinationsForAnimal(animal.id, db);
    expect(history).toHaveLength(1);
  });

  test("list for a malformed or unknown animal id is empty, not an error", async () => {
    expect(await listVaccinationsForAnimal("bogus", db)).toEqual([]);
    expect(
      await listVaccinationsForAnimal(
        "00000000-0000-4000-8000-000000000000",
        db,
      ),
    ).toEqual([]);
  });
});

describe("schema constraints", () => {
  test("due_on / valid_until cannot precede administered_on", async () => {
    const animal = await seedAnimal("Checks");
    await expect(
      db.insert(schema.vaccinations).values({
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
        dueOn: "2026-05-01",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.vaccinations).values({
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
        validUntil: "2026-05-01",
      }),
    ).rejects.toThrow();
  });

  test("animal_id is a real foreign key", async () => {
    await expect(
      db.insert(schema.vaccinations).values({
        animalId: "00000000-0000-4000-8000-000000000000",
        vaccineName: "Rabies",
        administeredOn: "2026-06-01",
      }),
    ).rejects.toThrow();
  });
});

describe("due/overdue query and reminder foundation", () => {
  test("listDueVaccinations surfaces due+overdue rows with the current owner", async () => {
    const asOf = "2026-09-23";

    const owner = (
      await db
        .insert(schema.persons)
        .values({
          fullName: "Jane Owner",
          email: "jane@example.com",
          phone: "+599 416 0000",
        })
        .returning()
    )[0];
    const animal = await seedAnimal("DueDog");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: owner.id,
      validFrom: "2025-01-01",
    });

    // Due within the window.
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-10-01",
        dueOn: "2026-10-10",
      },
      "vet@test.dev",
      db,
    );
    // Overdue (expired validity, no due date).
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "DHPP",
        administeredOn: "2025-08-01",
        validUntil: "2026-08-01",
      },
      "vet@test.dev",
      db,
    );
    // Current — beyond the window, must not appear.
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Lepto",
        administeredOn: "2026-06-01",
        dueOn: "2027-06-01",
      },
      "vet@test.dev",
      db,
    );
    // No dates at all — can never be due.
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Bordetella",
        administeredOn: "2025-01-01",
      },
      "vet@test.dev",
      db,
    );

    const due = await listDueVaccinations({ asOf, withinDays: 30 }, db);
    const mine = due.filter((r) => r.animal.id === animal.id);
    expect(mine).toHaveLength(2);

    // Ordered by effective date ascending — overdue first.
    expect(mine[0].vaccination.vaccineName).toBe("DHPP");
    expect(mine[0].effectiveDate).toBe("2026-08-01");
    expect(mine[0].state).toBe("overdue");
    expect(mine[1].vaccination.vaccineName).toBe("Rabies");
    expect(mine[1].state).toBe("due-soon");

    // The owner valid at asOf resolves with contact details for #172.
    expect(mine[0].currentOwner).toMatchObject({
      kind: "person",
      name: "Jane Owner",
      email: "jane@example.com",
    });
    expect(mine[0].remindersSent).toBe(0);
  });

  test("a closed ownership leaves the animal without a current owner", async () => {
    const asOf = "2026-09-23";
    const owner = (
      await db
        .insert(schema.persons)
        .values({ fullName: "Former Owner", email: "former@example.com" })
        .returning()
    )[0];
    const animal = await seedAnimal("Rehomed");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: owner.id,
      validFrom: "2024-01-01",
      validTo: "2026-01-01",
    });
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-09-01",
        dueOn: "2026-10-01",
      },
      "vet@test.dev",
      db,
    );

    const due = await listDueVaccinations({ asOf, withinDays: 30 }, db);
    const mine = due.filter((r) => r.animal.id === animal.id);
    expect(mine).toHaveLength(1);
    // History is intact; there is simply no current owner to notify.
    expect(mine[0].currentOwner).toBeNull();
  });

  test("a newer booster supersedes the old dose in the due projection", async () => {
    const asOf = "2026-09-23";
    const animal = await seedAnimal("Booster");

    // Dose A: administered 2025, was due 2026-06 — overdue at asOf.
    const oldDose = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-06-01",
        dueOn: "2026-06-01",
      },
      "vet@test.dev",
      db,
    );
    // Dose B: the booster that superseded it — due 2026-10-10.
    const booster = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-06-15",
        dueOn: "2026-10-10",
      },
      "vet@test.dev",
      db,
    );
    // An unrelated vaccine keeps its own independent due state.
    const dhpp = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "DHPP",
        administeredOn: "2025-09-01",
        dueOn: "2026-09-30",
      },
      "vet@test.dev",
      db,
    );
    if (!oldDose.ok || !booster.ok || !dhpp.ok) {
      throw new Error("setup failed");
    }

    // Medical history is untouched — all three doses remain visible,
    // ordered by administeredOn (booster 2026-06, DHPP 2025-09, the
    // old rabies dose 2025-06).
    const history = await listVaccinationsForAnimal(animal.id, db);
    expect(history.map((v) => v.id)).toEqual([
      booster.vaccination.id,
      dhpp.vaccination.id,
      oldDose.vaccination.id,
    ]);

    const due = await listDueVaccinations({ asOf, withinDays: 30 }, db);
    const mine = due.filter((r) => r.animal.id === animal.id);
    // Two rows — one per series — never three doses.
    expect(mine).toHaveLength(2);

    // The expired dose A is gone from the projection; the booster
    // controls the rabies series' next due date.
    const rabies = mine.find(
      (r) => r.vaccination.seriesKey === "rabies",
    );
    expect(rabies?.vaccination.id).toBe(booster.vaccination.id);
    expect(rabies?.effectiveDate).toBe("2026-10-10");
    expect(rabies?.state).toBe("due-soon");
    expect(
      mine.some((r) => r.vaccination.id === oldDose.vaccination.id),
    ).toBe(false);

    // DHPP is evaluated independently and is due-soon too.
    const dhppRow = mine.find((r) => r.vaccination.seriesKey === "dhpp");
    expect(dhppRow?.vaccination.id).toBe(dhpp.vaccination.id);
    expect(dhppRow?.state).toBe("due-soon");
  });

  test("casing/punctuation variants of a name share one series", async () => {
    const animal = await seedAnimal("SameSeries");
    // "Rabies" then "RABIES " — same series_key, so the newer row is
    // the series' current dose.
    const first = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-06-01",
        dueOn: "2026-06-01",
      },
      "vet@test.dev",
      db,
    );
    const second = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "RABIES ",
        administeredOn: "2026-06-10",
        dueOn: "2027-06-10",
      },
      "vet@test.dev",
      db,
    );
    if (!first.ok || !second.ok) throw new Error("setup failed");
    expect(first.vaccination.seriesKey).toBe("rabies");
    expect(second.vaccination.seriesKey).toBe("rabies");

    const due = await listDueVaccinations(
      { asOf: "2026-09-23", withinDays: 365 },
      db,
    );
    const mine = due.filter((r) => r.animal.id === animal.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].vaccination.id).toBe(second.vaccination.id);

    // Normalization strips punctuation/spacing too: "Rabies 1-Year"
    // and "rabies1year" are the same series.
    const [row] = await db
      .insert(schema.vaccinations)
      .values({
        animalId: animal.id,
        vaccineName: "Rabies 1-Year",
        administeredOn: "2026-07-01",
      })
      .returning();
    expect(row.seriesKey).toBe("rabies1year");
  });

  test("queueVaccinationReminder registers a queued row, idempotently", async () => {
    const owner = (
      await db
        .insert(schema.persons)
        .values({ fullName: "Reminder Target", email: "remind@example.com" })
        .returning()
    )[0];
    const animal = await seedAnimal("Reminded");
    const created = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-10-01",
        dueOn: "2026-10-10",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    const vaxId = created.vaccination.id;

    const input = {
      vaccinationId: vaxId,
      personId: owner.id,
      channel: "email" as const,
      touch: "due-30d",
    };
    const first = await queueVaccinationReminder(input, db);
    expect(first).toEqual({ ok: true, duplicate: false });
    // A retry for the same due date + touch writes no second row.
    const retry = await queueVaccinationReminder(input, db);
    expect(retry).toEqual({ ok: true, duplicate: true });

    const rows = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.relatedId, vaxId));
    expect(rows).toHaveLength(1);
    // Registration is NOT delivery — nothing here may claim a send.
    expect(rows[0]).toMatchObject({
      personId: owner.id,
      channel: "email",
      kind: "vaccination-reminder",
      status: "queued",
      relatedType: "vaccination",
      sentAt: null,
    });
    expect(rows[0].idempotencyKey).toContain(vaxId);

    // A queued row does not count as reminded — only #172's delivery
    // path can turn it 'sent'. Simulate that transition directly.
    expect(
      (
        await listDueVaccinations(
          { asOf: "2026-09-23", withinDays: 30 },
          db,
        )
      ).find((r) => r.vaccination.id === vaxId)?.remindersSent,
    ).toBe(0);
    await db
      .update(schema.communications)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(schema.communications.idempotencyKey, rows[0].idempotencyKey!));

    // A different touch (the 7-day notice) is a distinct reminder.
    const secondTouch = await queueVaccinationReminder(
      { ...input, touch: "due-7d" },
      db,
    );
    expect(secondTouch).toEqual({ ok: true, duplicate: false });
    const all = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.relatedId, vaxId));
    await db
      .update(schema.communications)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(schema.communications.id, all[1].id));

    // The due query's sent count reflects genuine deliveries only.
    const row = (
      await listDueVaccinations({ asOf: "2026-09-23", withinDays: 30 }, db)
    ).find((r) => r.vaccination.id === vaxId);
    expect(row?.remindersSent).toBe(2);
  });

  test("reminder queueing validates its inputs", async () => {
    const owner = (
      await db
        .insert(schema.persons)
        .values({ fullName: "X", email: "x@example.com" })
        .returning()
    )[0];
    const animal = await seedAnimal("NoDates");
    const created = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-01-01",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");

    // No due/expiry date → nothing to remind about.
    expect(
      await queueVaccinationReminder(
        {
          vaccinationId: created.vaccination.id,
          personId: owner.id,
          channel: "email",
          touch: "due-30d",
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });

    // Unknown vaccination / unknown person / bad ids.
    expect(
      await queueVaccinationReminder(
        {
          vaccinationId: "00000000-0000-4000-8000-000000000000",
          personId: owner.id,
          channel: "email",
          touch: "due-30d",
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(
      await queueVaccinationReminder(
        {
          vaccinationId: created.vaccination.id,
          personId: "not-a-uuid",
          channel: "email",
          touch: "due-30d",
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    // A 'sent'/'failed' status is not accepted here — delivery state
    // belongs to #172's send path.
    expect(
      await queueVaccinationReminder(
        {
          vaccinationId: created.vaccination.id,
          personId: owner.id,
          channel: "email",
          touch: "due-30d",
          status: "sent" as never,
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("ownership as-of resolution", () => {
  async function seedDueVaccination() {
    const animal = await seedAnimal("AsOfDog");
    const created = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2025-10-01",
        dueOn: "2026-10-10",
      },
      "vet@test.dev",
      db,
    );
    if (!created.ok) throw new Error("setup failed");
    return animal;
  }

  async function seedPerson(name: string) {
    const [person] = await db
      .insert(schema.persons)
      .values({ fullName: name, email: `${name}@example.com` })
      .returning();
    return person;
  }

  test("a future ownership is not yet current", async () => {
    const animal = await seedDueVaccination();
    const person = await seedPerson("future-owner");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: person.id,
      validFrom: "2027-01-01",
    });

    const due = await listDueVaccinations(
      { asOf: "2026-09-23", withinDays: 30 },
      db,
    );
    const mine = due.find((r) => r.animal.id === animal.id);
    expect(mine?.currentOwner).toBeNull();
    // But once the ownership begins, it is the owner.
    const future = await listDueVaccinations(
      { asOf: "2027-01-15", withinDays: 400 },
      db,
    );
    const later = future.find((r) => r.animal.id === animal.id);
    expect(later?.currentOwner).toMatchObject({
      kind: "person",
      name: "future-owner",
    });
  });

  test("a historical asOf inside a now-closed ownership resolves that owner", async () => {
    const animal = await seedDueVaccination();
    const person = await seedPerson("past-owner");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: person.id,
      validFrom: "2024-01-01",
      validTo: "2026-01-01",
    });

    // Evaluated while the ownership was open → owner resolves.
    const then = await listDueVaccinations(
      { asOf: "2025-06-01", withinDays: 600 },
      db,
    );
    const row = then.find((r) => r.animal.id === animal.id);
    expect(row?.currentOwner).toMatchObject({
      kind: "person",
      name: "past-owner",
    });

    // Evaluated after it closed → no owner (also covered above).
    const now = await listDueVaccinations(
      { asOf: "2026-09-23", withinDays: 30 },
      db,
    );
    expect(
      now.find((r) => r.animal.id === animal.id)?.currentOwner,
    ).toBeNull();
  });

  test("overlapping valid ownerships yield one deterministic owner row", async () => {
    const animal = await seedDueVaccination();
    const person = await seedPerson("preferred-owner");
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Shared Household" })
      .returning();
    // Inconsistent data: two rows simultaneously valid at asOf.
    await db.insert(schema.ownerships).values([
      {
        animalId: animal.id,
        householdId: household.id,
        validFrom: "2025-06-01",
      },
      {
        animalId: animal.id,
        personId: person.id,
        validFrom: "2025-01-01",
      },
    ]);

    const due = await listDueVaccinations(
      { asOf: "2026-09-23", withinDays: 30 },
      db,
    );
    // The vaccination appears exactly once — never duplicated per
    // ownership row.
    const mine = due.filter((r) => r.animal.id === animal.id);
    expect(mine).toHaveLength(1);
    // The deterministic pick prefers the person row (it carries the
    // contact details a sender needs).
    expect(mine[0].currentOwner).toMatchObject({
      kind: "person",
      name: "preferred-owner",
    });
  });
});
