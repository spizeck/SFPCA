// Dashboard gather tests (#177) — getDashboardWork against PGlite so
// every domain's canonical summary is exercised against real Postgres
// semantics. Composition presentation is covered by
// tests/dashboard.test.ts; here we prove the SOURCES feed it:
//   - an empty registry is a true all-clear (zero rows, not failures);
//   - each seeded exception surfaces as the right item + destination;
//   - pending ledger money, open conflicts, pending requests, comms
//     exceptions, confirmations due, and open cases all land.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import { getDashboardWork } from "@/lib/registry/dashboard";
import { openMissingCase } from "@/lib/registry/lost-found";

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
    sql`TRUNCATE lost_found_updates, lost_found_cases, communications, payments, registrations, registration_submissions, microchip_conflicts, microchip_records, ownership_confirmations, owner_requests, ownerships, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

let seq = 0;
async function seedAnimal(lifecycleStatus = "active") {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: `Animal-${++seq}`,
      species: "dog",
      sex: "female",
      lifecycleStatus,
    })
    .returning();
  return animal;
}

async function seedPerson() {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName: `Owner ${++seq}` })
    .returning();
  return person;
}

describe("getDashboardWork", () => {
  test("an empty registry is a genuine all-clear — zero rows, zero failures", async () => {
    const work = await getDashboardWork("admin", db);
    expect(work.needsAttention).toHaveLength(0);
    expect(work.comingUp).toHaveLength(0);
    expect(work.failures).toHaveLength(0);
    // Every domain loaded and reported empty — all 8 in the clear.
    expect(work.allClear).toHaveLength(8);
  });

  test("an unregistered active animal surfaces in needs attention", async () => {
    await seedAnimal();
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find(
      (i) => i.key === "registrations-unregistered",
    );
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/registrations#unregistered");
  });

  test("a pending bank transfer is reconciliation work, not noise", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    const [reg] = await db
      .insert(schema.registrations)
      .values({
        animalId: animal.id,
        year: new Date().getFullYear(),
        status: "active",
        personId: person.id,
        ownerLabel: "Owner",
        amountDueCents: 10000,
      })
      .returning();
    await db.insert(schema.payments).values({
      registrationId: reg.id,
      personId: person.id,
      amountCents: 10000,
      kind: "payment",
      status: "pending",
      method: "bank-transfer",
      source: "staff",
      recordedBy: "volunteer",
    });
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find((i) => i.key === "payments-pending");
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/registrations#awaiting-confirmation");
    // The registration itself is still outstanding — declared intent
    // never settles a balance.
    expect(
      work.needsAttention.find((i) => i.key === "registrations-outstanding")
        ?.count,
    ).toBe(1);
  });

  test("an overdue ownership confirmation surfaces as dated work", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: person.id,
      validFrom: "2020-01-01", // never confirmed — well past the period
    });
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find((i) => i.key === "confirmations-due");
    expect(item?.count).toBe(1);
    expect(item?.urgency).toBe("overdue");
  });

  test("a failed delivery is actionable; an opted-out skip is not", async () => {
    const person = await seedPerson();
    const base = {
      personId: person.id,
      channel: "email",
      kind: "vaccination-reminder",
    };
    await db.insert(schema.communications).values([
      { ...base, status: "failed", detail: "bounced" },
      { ...base, status: "skipped", detail: "opted-out" },
    ]);
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find(
      (i) => i.key === "communications-exceptions",
    );
    // Only the genuine failure counts — the opt-out is a choice, not
    // work.
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/communications#exceptions");
  });

  test("an open chip conflict surfaces for staff resolution", async () => {
    const a = await seedAnimal();
    const b = await seedAnimal();
    await db.insert(schema.microchipConflicts).values({
      chipNumber: "999000111222",
      claimedAnimalId: a.id,
      existingAnimalId: b.id,
      source: "staff",
    });
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find((i) => i.key === "chip-conflicts");
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/chip-lookup#conflicts");
  });

  test("a pending owner request surfaces for staff review", async () => {
    const person = await seedPerson();
    await db.insert(schema.ownerRequests).values({
      kind: "account-claim",
      personId: person.id,
      detail: "I think this is my animal",
    });
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find(
      (i) => i.key === "owner-requests-pending",
    );
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/requests#pending");
  });

  test("an open missing case surfaces in the lost/found queue", async () => {
    const animal = await seedAnimal();
    const opened = await openMissingCase(
      { animalId: animal.id },
      "volunteer@sfpca.example",
      db,
    );
    expect(opened.ok).toBe(true);
    const work = await getDashboardWork("admin", db);
    const item = work.needsAttention.find(
      (i) => i.key === "lost-found-missing",
    );
    expect(item?.count).toBe(1);
    expect(item?.href).toBe("/admin/lost-found#missing");
  });

  test("no dashboard item ever carries contact data", async () => {
    const animal = await seedAnimal();
    const [person] = await db
      .insert(schema.persons)
      .values({
        fullName: "Jane Private",
        email: "jane.private@example.com",
        phone: "+599 416 9999",
      })
      .returning();
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: person.id,
      validFrom: "2020-01-01",
    });
    await openMissingCase(
      { animalId: animal.id, reporterContact: "jane.private@example.com" },
      "staff",
      db,
    );
    const work = await getDashboardWork("admin", db);
    // The composition emits counts + destinations only — names, emails,
    // phone numbers, and reporter contact must never ride along in a
    // dashboard row.
    const serialized = JSON.stringify(work);
    expect(serialized).not.toContain("Jane Private");
    expect(serialized).not.toContain("jane.private@example.com");
    expect(serialized).not.toContain("416 9999");
    expect(serialized).not.toContain(animal.name);
  });
});
