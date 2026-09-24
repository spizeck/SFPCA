// Reminder cycle tests (#172), run against PGlite. The evaluator is the
// seam under test: eligibility boundaries, deterministic asOf, cooldown
// and touch caps, recipient resolution, opt-outs, idempotent reruns,
// and the dry-run path that must never write or send.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import { createVaccination } from "@/lib/registry/vaccinations";
import { runReminderCycle } from "@/lib/registry/reminders";
import { setCommunicationPreference } from "@/lib/registry/communications";
import { REMINDER_POLICIES, sendTouch } from "@/lib/reminders/policy";
import type { EmailSender, SendOutcome } from "@/lib/email";

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

// Cycle counts are global — a clean slate per test keeps them
// deterministic (an earlier test's overdue vaccination would otherwise
// keep evaluating forever).
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE communications, communication_preferences, vaccinations, ownerships, household_members, households, persons, animals, audit_events CASCADE`,
  );
});

const AS_OF = "2026-09-23";
const DUE_ON = "2026-10-10"; // inside the 30-day due-soon window

async function seedOwner(email: string | null, name = "Jane Owner") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName: name, email })
    .returning();
  return person;
}

async function seedAnimal(name: string) {
  const [animal] = await db
    .insert(schema.animals)
    .values({ name, species: "dog", sex: "male", lifecycleStatus: "adopted" })
    .returning();
  return animal;
}

// One animal with a person owner and a dose due on DUE_ON.
async function seedDueVaccination({
  animalName,
  email = "owner@example.com",
  dueOn = DUE_ON,
}: {
  animalName: string;
  email?: string | null;
  dueOn?: string;
}) {
  const person = await seedOwner(email);
  const animal = await seedAnimal(animalName);
  await db.insert(schema.ownerships).values({
    animalId: animal.id,
    personId: person.id,
    validFrom: "2025-01-01",
  });
  const created = await createVaccination(
    {
      animalId: animal.id,
      vaccineName: "Rabies",
      administeredOn: "2025-10-01",
      dueOn,
    },
    "vet@test.dev",
    db,
  );
  if (!created.ok) throw new Error("setup failed");
  return { person, animal, vaccination: created.vaccination };
}

function commsFor(relatedId: string) {
  return db
    .select()
    .from(schema.communications)
    .where(eq(schema.communications.relatedId, relatedId));
}

function fakeSender(outcome: SendOutcome): EmailSender & { calls: number } {
  const f = {
    provider: "fake",
    calls: 0,
    send: async () => {
      f.calls++;
      return outcome;
    },
  };
  return f;
}

describe("vaccination reminder evaluation + queueing", () => {
  test("a due dose queues a reminder with a send-time snapshot", async () => {
    const { person, animal, vaccination } = await seedDueVaccination({
      animalName: "DueRex",
    });
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.delivery).toBe("not-configured");
    expect(result.queued).toBe(1);

    const [row] = await commsFor(vaccination.id);
    expect(row).toMatchObject({
      personId: person.id,
      animalId: animal.id,
      kind: "vaccination-reminder",
      status: "queued",
      cycleKey: DUE_ON,
      touch: "reminder-1",
      recipient: "owner@example.com",
      channel: "email",
    });
    // The #173 key shape is preserved: prefix:vaccinationId:dueDate:touch.
    expect(row.idempotencyKey).toBe(
      `vax-reminder:${vaccination.id}:${DUE_ON}:reminder-1`,
    );
    expect(row.subject).toContain(animal.name);
    expect(row.bodyText).toContain("Rabies");
    expect(row.bodyHtml).toContain("Rabies");
  });

  test("a repeated run is fully suppressed — cron can re-evaluate freely", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "Idempotent",
    });
    await runReminderCycle({ asOf: AS_OF }, db);
    const second = await runReminderCycle({ asOf: AS_OF }, db);
    expect(second.queued).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(await commsFor(vaccination.id)).toHaveLength(1);
  });

  test("the due window boundary is deterministic for a fixed asOf", async () => {
    // due exactly at asOf+30 → inside the window; asOf+31 → outside.
    const inside = await seedDueVaccination({
      animalName: "BoundaryIn",
      dueOn: "2026-10-23",
    });
    const outside = await seedDueVaccination({
      animalName: "BoundaryOut",
      dueOn: "2026-10-24",
    });
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.evaluated).toBe(1);
    expect(await commsFor(inside.vaccination.id)).toHaveLength(1);
    expect(await commsFor(outside.vaccination.id)).toHaveLength(0);
  });

  test("cooldown gates the second touch; after the window it queues reminder-2", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "Cooldown",
    });
    await runReminderCycle({ asOf: AS_OF }, db);
    const cooldown = REMINDER_POLICIES["vaccination-reminder"].cooldownDays;

    // A day later — still inside the cooldown.
    const soon = await runReminderCycle({ asOf: "2026-09-24" }, db);
    expect(soon.queued).toBe(0);
    expect(soon.suppressedByReason.cooldown).toBe(1);

    // Backdate the first touch past the cooldown — now the next touch
    // is a distinct send, never a duplicate of the first.
    await db
      .update(schema.communications)
      .set({ createdAt: new Date("2026-08-01T00:00:00Z") })
      .where(eq(schema.communications.relatedId, vaccination.id));
    const later = await runReminderCycle({ asOf: AS_OF }, db);
    expect(later.queued).toBe(1);
    const rows = await commsFor(vaccination.id);
    expect(rows.map((r) => r.touch).sort()).toEqual([
      "reminder-1",
      "reminder-2",
    ]);
    expect(cooldown).toBeGreaterThan(1); // the test setup means something
  });

  test("the touch cap exhausts the cycle — it never sends forever", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "Exhausted",
    });
    const max = REMINDER_POLICIES["vaccination-reminder"].maxTouches;
    for (let n = 1; n <= max; n++) {
      await db.insert(schema.communications).values({
        channel: "email",
        kind: "vaccination-reminder",
        status: "sent",
        sentAt: new Date("2026-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        idempotencyKey: `vax-reminder:${vaccination.id}:${DUE_ON}:${sendTouch(n)}`,
        relatedType: "vaccination",
        relatedId: vaccination.id,
        cycleKey: DUE_ON,
        touch: sendTouch(n),
      });
    }
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.queued).toBe(0);
    expect(result.suppressedByReason.exhausted).toBe(1);
  });
});

describe("recipient resolution — every ambiguous shape skips closed", () => {
  test.each([
    {
      label: "no owner at all",
      setup: async () => {
        const animal = await seedAnimal("Ownerless");
        const created = await createVaccination(
          {
            animalId: animal.id,
            vaccineName: "Rabies",
            administeredOn: "2025-10-01",
            dueOn: DUE_ON,
          },
          "vet@test.dev",
          db,
        );
        if (!created.ok) throw new Error("setup failed");
        return created.vaccination;
      },
      detail: "no-owner",
    },
    {
      label: "household ownership has no contactable person",
      setup: async () => {
        const [household] = await db
          .insert(schema.households)
          .values({ name: "Smith Family" })
          .returning();
        const animal = await seedAnimal("HouseholdPet");
        await db.insert(schema.ownerships).values({
          animalId: animal.id,
          householdId: household.id,
          validFrom: "2025-01-01",
        });
        const created = await createVaccination(
          {
            animalId: animal.id,
            vaccineName: "Rabies",
            administeredOn: "2025-10-01",
            dueOn: DUE_ON,
          },
          "vet@test.dev",
          db,
        );
        if (!created.ok) throw new Error("setup failed");
        return created.vaccination;
      },
      detail: "household-no-contact",
    },
    {
      label: "owner has no email",
      setup: async () => {
        const { vaccination } = await seedDueVaccination({
          animalName: "NoEmail",
          email: null,
        });
        return vaccination;
      },
      detail: "missing-email",
    },
    {
      label: "owner email is unusable",
      setup: async () => {
        const { vaccination } = await seedDueVaccination({
          animalName: "BadEmail",
          email: "not-an-email",
        });
        return vaccination;
      },
      detail: "invalid-email",
    },
    {
      label: "two simultaneously-valid ownerships are ambiguous",
      setup: async () => {
        const { animal, vaccination } = await seedDueVaccination({
          animalName: "TwoOwners",
        });
        const second = await seedOwner("second@example.com", "Second Owner");
        await db.insert(schema.ownerships).values({
          animalId: animal.id,
          personId: second.id,
          validFrom: "2025-06-01",
        });
        return vaccination;
      },
      detail: "ambiguous-ownership",
    },
  ])("$label → skipped '$detail'", async ({ setup, detail }) => {
    const vaccination = await setup();
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const rows = await commsFor(vaccination.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "skipped",
      detail,
      touch: `skip:${detail}`,
    });
    // A skip row is idempotent too — re-runs suppress it.
    const second = await runReminderCycle({ asOf: AS_OF }, db);
    expect(await commsFor(vaccination.id)).toHaveLength(1);
    expect(second.skipped).toBe(0);
  });

  test("a recorded skip does not consume a send touch", async () => {
    const { person, vaccination } = await seedDueVaccination({
      animalName: "LateEmail",
      email: null,
    });
    await runReminderCycle({ asOf: AS_OF }, db);
    const [skipRow] = await commsFor(vaccination.id);
    expect(skipRow.detail).toBe("missing-email");

    // Staff fix the record — the next run sends reminder-1, not -2.
    await db
      .update(schema.persons)
      .set({ email: "fixed@example.com" })
      .where(eq(schema.persons.id, person.id));
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.queued).toBe(1);
    const rows = await commsFor(vaccination.id);
    expect(rows).toHaveLength(2);
    const queued = rows.find((r) => r.status === "queued")!;
    expect(queued.touch).toBe("reminder-1");
    expect(queued.recipient).toBe("fixed@example.com");
  });

  test("an opted-out recipient is skipped, and preference changes stick", async () => {
    const { person, vaccination } = await seedDueVaccination({
      animalName: "OptOut",
    });
    await setCommunicationPreference(
      {
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        optedOut: true,
      },
      "staff@test.dev",
      db,
    );
    const result = await runReminderCycle({ asOf: AS_OF }, db);
    expect(result.skippedByReason["opted-out"]).toBe(1);
    const [row] = await commsFor(vaccination.id);
    expect(row).toMatchObject({
      status: "skipped",
      detail: "opted-out",
      personId: person.id,
    });
  });

  test("ownership change redirects the NEXT touch — history keeps the old recipient", async () => {
    const { person: first, animal, vaccination } = await seedDueVaccination({
      animalName: "Rehomed",
    });
    await runReminderCycle({ asOf: AS_OF }, db);

    // Ownership transfers — the old row's recipient snapshot must remain.
    await db
      .update(schema.ownerships)
      .set({ validTo: "2026-09-24" })
      .where(eq(schema.ownerships.personId, first.id));
    const second = await seedOwner("new-owner@example.com", "New Owner");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: second.id,
      validFrom: "2026-09-24",
    });
    // Push past the cooldown so the next touch is eligible.
    await db
      .update(schema.communications)
      .set({ createdAt: new Date("2026-08-01T00:00:00Z") })
      .where(eq(schema.communications.relatedId, vaccination.id));

    const result = await runReminderCycle({ asOf: "2026-09-25" }, db);
    expect(result.queued).toBe(1);
    const rows = await commsFor(vaccination.id);
    const firstRow = rows.find((r) => r.touch === "reminder-1")!;
    const nextRow = rows.find((r) => r.touch === "reminder-2")!;
    expect(firstRow.recipient).toBe("owner@example.com");
    expect(firstRow.personId).toBe(first.id);
    expect(nextRow.recipient).toBe("new-owner@example.com");
    expect(nextRow.personId).toBe(second.id);
  });
});

describe("delivery + dry-run", () => {
  test("a live cycle drains the queue through the injected sender", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "LiveSend",
    });
    const sender = fakeSender({ ok: true, providerMessageId: "msg_live" });
    const result = await runReminderCycle(
      { asOf: AS_OF, sender },
      db,
    );
    expect(result.queued).toBe(1);
    expect(result.delivery).not.toBe("dry-run");
    expect(result.delivery).not.toBe("not-configured");
    if (typeof result.delivery === "object") {
      expect(result.delivery.sent).toBe(1);
    }
    const [row] = await commsFor(vaccination.id);
    expect(row).toMatchObject({
      status: "sent",
      provider: "fake",
      providerMessageId: "msg_live",
    });
  });

  test("dry-run reports identical eligibility but writes nothing and cannot send", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "DryRun",
    });
    const sender = fakeSender({ ok: true, providerMessageId: "never" });
    const result = await runReminderCycle(
      { asOf: AS_OF, dryRun: true, sender },
      db,
    );
    expect(result).toMatchObject({
      dryRun: true,
      evaluated: 1,
      queued: 1,
      delivery: "dry-run",
    });
    expect(sender.calls).toBe(0);
    expect(await commsFor(vaccination.id)).toHaveLength(0);

    // A second dry-run is still honest — and a real run then queues.
    const again = await runReminderCycle({ asOf: AS_OF, dryRun: true }, db);
    expect(again.queued).toBe(1);
    const live = await runReminderCycle({ asOf: AS_OF }, db);
    expect(live.queued).toBe(1);
    expect(await commsFor(vaccination.id)).toHaveLength(1);
  });

  test("dry-run counts existing rows as suppressed, not queued", async () => {
    const { vaccination } = await seedDueVaccination({
      animalName: "DryRunExisting",
    });
    await runReminderCycle({ asOf: AS_OF }, db); // live: queues reminder-1
    const preview = await runReminderCycle(
      { asOf: AS_OF, dryRun: true },
      db,
    );
    expect(preview.queued).toBe(0);
    expect(preview.suppressed).toBe(1);
    expect(await commsFor(vaccination.id)).toHaveLength(1);
  });
});
