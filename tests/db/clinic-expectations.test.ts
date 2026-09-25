// Clinic-expectation domain tests (#194), run against PGlite — real
// Postgres semantics for transactions, CHECK constraints, optimistic
// concurrency, the audit trail, and the veterinary queue integration.
// Pure state derivation is covered by tests/medical.test.ts.
//
// The suite fixes `asOf` explicitly everywhere so "today" never moves:
//   AS_OF = 2026-10-15. Dates are chosen relative to it.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  cancelClinicExpectation,
  createClinicExpectation,
  createEncounter,
  listClinicExpectationsForAnimal,
  markClinicExpectationNoShow,
  markClinicExpectationSeen,
  updateClinicExpectation,
} from "@/lib/registry/medical";
import {
  listVetQueue,
  vetQueueSummary,
  type VetQueueItem,
} from "@/lib/registry/vet-queue";

type ClinicItem = Extract<VetQueueItem, { kind: "clinic" }>;
const isClinicItem = (i: VetQueueItem): i is ClinicItem =>
  i.kind === "clinic";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

const AS_OF = "2026-10-15";
const ACTOR = "vet@test.dev";

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

async function seedOwnedAnimal(name: string) {
  const animal = await seedAnimal(name);
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName: `${name} Owner`, email: `${name.toLowerCase()}@ex.com` })
    .returning();
  await db.insert(schema.ownerships).values({
    animalId: animal.id,
    personId: person.id,
    validFrom: "2025-01-01",
  });
  return { animal, person };
}

async function seedExpectation(
  animalId: string,
  overrides: Partial<Parameters<typeof createClinicExpectation>[0]> = {},
) {
  const result = await createClinicExpectation(
    {
      animalId,
      expectedOn: "2026-11-01",
      reason: "Vaccination visit",
      ...overrides,
    },
    ACTOR,
    db,
  );
  if (!result.ok) throw new Error(`seed expectation failed: ${result.reason}`);
  return result.record;
}

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

describe("clinic expectation lifecycle", () => {
  test("create validates, audits, and snapshots the current owner", async () => {
    const { animal, person } = await seedOwnedAnimal("CreateEx");
    const created = await createClinicExpectation(
      {
        animalId: animal.id,
        expectedOn: "2026-11-01",
        sessionLabel: "Saturday AM",
        reason: "Vaccination visit",
        notes: "booster due",
      },
      ACTOR,
      db,
    );
    if (!created.ok) throw new Error("create failed");
    expect(created.record).toMatchObject({
      animalId: animal.id,
      personId: person.id,
      status: "expected",
      expectedOn: "2026-11-01",
      sessionLabel: "Saturday AM",
      reason: "Vaccination visit",
      notes: "booster due",
      encounterId: null,
      resolvedAt: null,
    });

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.record.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      entityType: "clinic_expectation",
      actorLabel: ACTOR,
    });
  });

  test("invalid input is rejected before any write", async () => {
    const animal = await seedAnimal("InvalidEx");
    for (const [input, field] of [
      [
        { animalId: "nope", expectedOn: "2026-11-01", reason: "x" },
        "animalId",
      ],
      [
        { animalId: animal.id, expectedOn: "not-a-date", reason: "x" },
        "expectedOn",
      ],
      [
        { animalId: animal.id, expectedOn: "2026-11-01", reason: " " },
        "reason",
      ],
      [
        {
          animalId: animal.id,
          expectedOn: "2026-11-01",
          reason: "x",
          sessionLabel: "s".repeat(201),
        },
        "sessionLabel",
      ],
      [
        {
          animalId: animal.id,
          expectedOn: "2026-11-01",
          reason: "x",
          notes: "n".repeat(2001),
        },
        "notes",
      ],
    ] as const) {
      const result = await createClinicExpectation(input, ACTOR, db);
      expect(result).toMatchObject({ ok: false, reason: "invalid", field });
    }
    const missing = await createClinicExpectation(
      {
        animalId: "00000000-0000-4000-8000-000000000000",
        expectedOn: "2026-11-01",
        reason: "x",
      },
      ACTOR,
      db,
    );
    expect(missing).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("update reschedules a live expectation; resolved items refuse edits", async () => {
    const animal = await seedAnimal("EditEx");
    const ex = await seedExpectation(animal.id, { reason: "Checkup" });

    const stale = await updateClinicExpectation(
      ex.id,
      { animalId: animal.id, expectedOn: "2026-12-01", reason: "Checkup" },
      "1999-01-01T00:00:00.000Z",
      ACTOR,
      db,
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });

    const moved = await updateClinicExpectation(
      ex.id,
      {
        animalId: animal.id,
        expectedOn: "2026-12-01",
        sessionLabel: "PM session",
        reason: "Checkup",
        notes: "owner asked to push out",
      },
      ex.updatedAt,
      ACTOR,
      db,
    );
    if (!moved.ok) throw new Error("update failed");
    expect(moved.record).toMatchObject({
      expectedOn: "2026-12-01",
      sessionLabel: "PM session",
      notes: "owner asked to push out",
    });

    const seen = await markClinicExpectationSeen(
      ex.id,
      moved.record.updatedAt,
      ACTOR,
      null,
      db,
    );
    if (!seen.ok) throw new Error("seen failed");
    const editResolved = await updateClinicExpectation(
      ex.id,
      { animalId: animal.id, expectedOn: "2027-01-01", reason: "Nope" },
      seen.record.updatedAt,
      ACTOR,
      db,
    );
    expect(editResolved).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("mark seen preserves the record, audits 'seen', and works without an encounter", async () => {
    const animal = await seedAnimal("SeenEx");
    const ex = await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      reason: "Post-op check",
    });

    const seen = await markClinicExpectationSeen(
      ex.id,
      ex.updatedAt,
      "vet2@test.dev",
      null,
      db,
    );
    if (!seen.ok) throw new Error("seen failed");
    // The animal arrived but no visit was logged — seen with a null
    // encounter, no clinical facts manufactured.
    expect(seen.record).toMatchObject({
      status: "seen",
      reason: "Post-op check",
      expectedOn: AS_OF,
      encounterId: null,
      animalId: animal.id,
    });
    expect(seen.record.resolvedAt).not.toBeNull();

    const all = await listClinicExpectationsForAnimal(animal.id, db);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("seen");

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, ex.id));
    expect(audit.map((a) => a.action)).toEqual(["create", "seen"]);
    expect(audit[1].actorLabel).toBe("vet2@test.dev");
    expect(audit[1].before).toMatchObject({ status: "expected" });
    expect(audit[1].after).toMatchObject({ status: "seen" });
  });

  test("mark seen can link the real encounter that fulfilled it — same-animal only", async () => {
    const animal = await seedAnimal("LinkedEx");
    const other = await seedAnimal("OtherEx");
    const enc = await createEncounter(
      {
        animalId: animal.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Rabies booster",
      },
      ACTOR,
      db,
    );
    const foreign = await createEncounter(
      {
        animalId: other.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Unrelated",
      },
      ACTOR,
      db,
    );
    if (!enc.ok || !foreign.ok) throw new Error("setup failed");
    const ex = await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      reason: "Rabies booster",
    });

    const cross = await markClinicExpectationSeen(
      ex.id,
      ex.updatedAt,
      ACTOR,
      foreign.record.id,
      db,
    );
    expect(cross).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "encounterId",
    });

    const seen = await markClinicExpectationSeen(
      ex.id,
      ex.updatedAt,
      ACTOR,
      enc.record.id,
      db,
    );
    if (!seen.ok) throw new Error("seen failed");
    expect(seen.record).toMatchObject({
      status: "seen",
      encounterId: enc.record.id,
    });
  });

  test("no-show and cancelled are terminal, audited, and preserve history", async () => {
    const animal = await seedAnimal("TerminalEx");
    const noShow = await seedExpectation(animal.id, { reason: "Vaccines" });
    const cancelled = await seedExpectation(animal.id, {
      reason: "Nail trim",
    });

    const ns = await markClinicExpectationNoShow(
      noShow.id,
      noShow.updatedAt,
      ACTOR,
      db,
    );
    const cx = await cancelClinicExpectation(
      cancelled.id,
      cancelled.updatedAt,
      ACTOR,
      db,
    );
    if (!ns.ok || !cx.ok) throw new Error("transition failed");
    expect(ns.record.status).toBe("no_show");
    expect(cx.record.status).toBe("cancelled");
    expect(ns.record.resolvedAt).not.toBeNull();
    expect(cx.record.resolvedAt).not.toBeNull();

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, noShow.id));
    expect(audit.map((a) => a.action)).toEqual(["create", "no-show"]);

    const all = await listClinicExpectationsForAnimal(animal.id, db);
    expect(all.map((e) => e.status).sort()).toEqual([
      "cancelled",
      "no_show",
    ]);
  });

  test("a second resolution conflicts — terminal states are not re-writable", async () => {
    const animal = await seedAnimal("TwiceEx");
    const ex = await seedExpectation(animal.id);

    const seen = await markClinicExpectationSeen(
      ex.id,
      ex.updatedAt,
      ACTOR,
      null,
      db,
    );
    if (!seen.ok) throw new Error("setup failed");

    // Stale token → conflict.
    const stale = await markClinicExpectationNoShow(
      ex.id,
      ex.updatedAt,
      ACTOR,
      db,
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });
    // Fresh token on a terminal row → still a conflict: no
    // seen → no_show transition exists.
    const reNoShow = await markClinicExpectationNoShow(
      ex.id,
      seen.record.updatedAt,
      ACTOR,
      db,
    );
    expect(reNoShow).toMatchObject({ ok: false, reason: "conflict" });
    const reCancel = await cancelClinicExpectation(
      ex.id,
      seen.record.updatedAt,
      ACTOR,
      db,
    );
    expect(reCancel).toMatchObject({ ok: false, reason: "conflict" });

    const all = await listClinicExpectationsForAnimal(animal.id, db);
    expect(all[0].status).toBe("seen");
  });

  test("the resolved_at consistency CHECK rejects terminal rows without a stamp", async () => {
    const animal = await seedAnimal("CheckEx");
    await expect(
      db.insert(schema.clinicExpectations).values({
        animalId: animal.id,
        expectedOn: "2026-11-01",
        reason: "x",
        status: "seen",
      }),
    ).rejects.toThrow();
    // And the reverse: a live row may not carry a resolved stamp.
    await expect(
      db.insert(schema.clinicExpectations).values({
        animalId: animal.id,
        expectedOn: "2026-11-01",
        reason: "x",
        status: "expected",
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  test("an ownership change keeps the snapshot but the queue resolves the current owner", async () => {
    const { animal, person } = await seedOwnedAnimal("HandoverEx");
    const ex = await seedExpectation(animal.id);
    expect(ex.personId).toBe(person.id);

    const [newOwner] = await db
      .insert(schema.persons)
      .values({ fullName: "New Clinic Owner" })
      .returning();
    await db
      .update(schema.ownerships)
      .set({ validTo: AS_OF })
      .where(eq(schema.ownerships.personId, person.id));
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: newOwner.id,
      validFrom: AS_OF,
    });

    const [reloaded] = await listClinicExpectationsForAnimal(animal.id, db);
    expect(reloaded.personId).toBe(person.id);

    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 60 }, db);
    const item = queue.find((i) => i.kind === "clinic" && i.id === ex.id);
    expect(item?.kind === "clinic" && item.currentOwnerName).toBe(
      "New Clinic Owner",
    );
  });
});

describe("veterinary queue integration", () => {
  test("expected items derive overdue/due/upcoming; terminal rows are excluded", async () => {
    const animal = await seedAnimal("ClinicQueue");
    await seedExpectation(animal.id, {
      expectedOn: "2026-10-10",
      reason: "Missed visit",
    });
    await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      reason: "Today visit",
    });
    await seedExpectation(animal.id, {
      expectedOn: "2026-10-30",
      reason: "Future visit",
    });
    const seen = await seedExpectation(animal.id, {
      expectedOn: "2026-10-05",
      reason: "Already seen",
    });
    await markClinicExpectationSeen(seen.id, seen.updatedAt, ACTOR, null, db);
    const noShow = await seedExpectation(animal.id, {
      expectedOn: "2026-10-06",
      reason: "Already no-show",
    });
    await markClinicExpectationNoShow(
      noShow.id,
      noShow.updatedAt,
      ACTOR,
      db,
    );

    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 30 }, db);
    const mine = queue
      .filter(isClinicItem)
      .filter((i) => i.animal.id === animal.id);
    const byReason = new Map(mine.map((i) => [i.reason, i.state]));
    expect(byReason.get("Missed visit")).toBe("overdue");
    expect(byReason.get("Today visit")).toBe("due");
    expect(byReason.get("Future visit")).toBe("upcoming");
    expect(byReason.has("Already seen")).toBe(false);
    expect(byReason.has("Already no-show")).toBe(false);

    // Overdue → due today → upcoming ordering holds for clinic items.
    expect(mine.map((i) => i.reason)).toEqual([
      "Missed visit",
      "Today visit",
      "Future visit",
    ]);
  });

  test("clinic items interleave with dated work by date — ordering semantics unchanged", async () => {
    const animal = await seedAnimal("ClinicOrder");
    await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      reason: "Expected today",
    });
    const fu = await createEncounter(
      {
        animalId: animal.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Setup visit",
        followUp: { dueOn: "2026-10-01", reason: "Old recheck" },
      },
      ACTOR,
      db,
    );
    if (!fu.ok) throw new Error("setup failed");

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const mine = queue.filter((i) => i.animal.id === animal.id);
    // The overdue recheck outranks today's expectation; both are dated
    // work so both sort ahead of any alert tail.
    expect(mine.map((i) => i.kind)).toEqual(["follow-up", "clinic"]);
  });

  test("the queue carries reason, session label, notes, owner, and the concurrency token", async () => {
    const { animal } = await seedOwnedAnimal("ClinicJoined");
    const ex = await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      sessionLabel: "AM session",
      reason: "Spay follow-up",
      notes: "bring paperwork",
    });

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const item = queue.find((i) => i.kind === "clinic" && i.id === ex.id);
    if (!item || item.kind !== "clinic") throw new Error("missing item");
    expect(item).toMatchObject({
      expectedOn: AS_OF,
      state: "due",
      reason: "Spay follow-up",
      sessionLabel: "AM session",
      notes: "bring paperwork",
      currentOwnerName: "ClinicJoined Owner",
      animal: { id: animal.id, name: "ClinicJoined", species: "dog" },
    });
    expect(item.updatedAt).toBe(ex.updatedAt);
  });

  test("vetQueueSummary counts expectations and still agrees with the list", async () => {
    const animal = await seedAnimal("ClinicSummary");
    await seedExpectation(animal.id, {
      expectedOn: "2026-10-01",
      reason: "Missed",
    });
    await seedExpectation(animal.id, {
      expectedOn: AS_OF,
      reason: "Today",
    });
    await seedExpectation(animal.id, {
      expectedOn: "2026-10-25",
      reason: "Future",
    });

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const summary = await vetQueueSummary({ asOf: AS_OF }, db);
    const count = (state: ClinicItem["state"]) =>
      queue.filter((i) => i.kind === "clinic" && i.state === state).length;
    expect(summary.overdueExpectations).toBe(count("overdue"));
    expect(summary.expectedToday).toBe(count("due"));
    expect(summary.upcomingExpectations).toBe(count("upcoming"));
    expect(summary.overdueExpectations).toBeGreaterThanOrEqual(1);
    expect(summary.expectedToday).toBeGreaterThanOrEqual(1);
    expect(summary.upcomingExpectations).toBeGreaterThanOrEqual(1);
    expect(summary.total).toBe(queue.length);
  });

  test("expectations beyond the window stay off the queue but remain live", async () => {
    const animal = await seedAnimal("ClinicHorizon");
    await seedExpectation(animal.id, {
      expectedOn: "2027-06-01",
      reason: "Far future",
    });

    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 30 }, db);
    expect(
      queue.find((i) => i.kind === "clinic" && i.reason === "Far future"),
    ).toBeUndefined();
    const all = await listClinicExpectationsForAnimal(animal.id, db);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("expected");
  });
});
