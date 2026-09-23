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
  recordVaccinationReminder,
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
      lifecycleStatus: "adopted",
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

    // The current owner resolves with contact details for #172.
    expect(mine[0].owner).toMatchObject({
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
    expect(mine[0].owner).toBeNull();
  });

  test("recordVaccinationReminder is idempotent and logged in communications", async () => {
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
    const first = await recordVaccinationReminder(input, db);
    expect(first).toEqual({ ok: true, duplicate: false });
    // A retry for the same due date + touch can never double-send.
    const retry = await recordVaccinationReminder(input, db);
    expect(retry).toEqual({ ok: true, duplicate: true });

    const rows = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.relatedId, vaxId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      personId: owner.id,
      channel: "email",
      kind: "vaccination-reminder",
      status: "sent",
      relatedType: "vaccination",
    });
    expect(rows[0].idempotencyKey).toContain(vaxId);
    expect(rows[0].sentAt).not.toBeNull();

    // A different touch (the 7-day notice) is a distinct reminder.
    const secondTouch = await recordVaccinationReminder(
      { ...input, touch: "due-7d" },
      db,
    );
    expect(secondTouch).toEqual({ ok: true, duplicate: false });

    // The sent log shows up in the due query so staff can see reminders
    // already went out — both touches count.
    const due = await listDueVaccinations(
      { asOf: "2026-09-23", withinDays: 30 },
      db,
    );
    const row = due.find((r) => r.vaccination.id === vaxId);
    expect(row?.remindersSent).toBe(2);
  });

  test("reminder recording validates its inputs", async () => {
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
      await recordVaccinationReminder(
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
      await recordVaccinationReminder(
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
      await recordVaccinationReminder(
        {
          vaccinationId: created.vaccination.id,
          personId: "not-a-uuid",
          channel: "email",
          touch: "due-30d",
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
