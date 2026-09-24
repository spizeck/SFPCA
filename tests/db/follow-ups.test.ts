// Follow-up + veterinary work queue domain tests (#175), run against
// PGlite — real Postgres semantics for transactions, CHECK constraints,
// optimistic concurrency, the audit trail, and the cross-animal queue
// query. Pure state derivation is covered by tests/medical.test.ts.
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
  cancelFollowUp,
  completeFollowUp,
  createEncounter,
  createFollowUp,
  listFollowUpsForAnimal,
  updateFollowUp,
} from "@/lib/registry/medical";
import { createVaccination } from "@/lib/registry/vaccinations";
import { createAlert } from "@/lib/registry/medical";
import {
  listVetQueue,
  vetQueueSummary,
  type VetQueueItem,
} from "@/lib/registry/vet-queue";

type FollowUpItem = Extract<VetQueueItem, { kind: "follow-up" }>;
const isFollowUpItem = (i: VetQueueItem): i is FollowUpItem =>
  i.kind === "follow-up";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

const AS_OF = "2026-10-15";

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

const ACTOR = "vet@test.dev";

async function seedFollowUp(
  animalId: string,
  overrides: Partial<Parameters<typeof createFollowUp>[0]> = {},
) {
  const result = await createFollowUp(
    {
      animalId,
      dueOn: "2026-11-01",
      reason: "Recheck",
      ...overrides,
    },
    ACTOR,
    db,
  );
  if (!result.ok) throw new Error(`seed follow-up failed: ${result.reason}`);
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

describe("follow-up lifecycle", () => {
  test("create validates and audits; the row starts open", async () => {
    const animal = await seedAnimal("CreateFu");
    const created = await createFollowUp(
      {
        animalId: animal.id,
        dueOn: "2026-11-01",
        reason: "Suture removal",
        notes: "10 days post-spay",
      },
      ACTOR,
      db,
    );
    if (!created.ok) throw new Error("create failed");
    expect(created.record).toMatchObject({
      animalId: animal.id,
      kind: "recheck",
      status: "open",
      dueOn: "2026-11-01",
      reason: "Suture removal",
      notes: "10 days post-spay",
      resolvedAt: null,
    });

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, created.record.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      entityType: "follow_up",
      actorLabel: ACTOR,
    });
  });

  test("invalid input is rejected before any write", async () => {
    const animal = await seedAnimal("InvalidFu");
    for (const [input, field] of [
      [{ animalId: "nope", dueOn: "2026-11-01", reason: "x" }, "animalId"],
      [
        { animalId: animal.id, dueOn: "not-a-date", reason: "x" },
        "dueOn",
      ],
      [{ animalId: animal.id, dueOn: "2026-11-01", reason: " " }, "reason"],
      [
        {
          animalId: animal.id,
          dueOn: "2026-11-01",
          reason: "x",
          encounterId: "nope",
        },
        "encounterId",
      ],
    ] as const) {
      const result = await createFollowUp(input, ACTOR, db);
      expect(result).toMatchObject({ ok: false, reason: "invalid", field });
    }
    const missing = await createFollowUp(
      {
        animalId: "00000000-0000-4000-8000-000000000000",
        dueOn: "2026-11-01",
        reason: "x",
      },
      ACTOR,
      db,
    );
    expect(missing).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("an encounter link must belong to the same animal", async () => {
    const mine = await seedAnimal("FuMine");
    const theirs = await seedAnimal("FuTheirs");
    const enc = await createEncounter(
      {
        animalId: theirs.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Checkup",
      },
      ACTOR,
      db,
    );
    if (!enc.ok) throw new Error("setup failed");

    const cross = await createFollowUp(
      {
        animalId: mine.id,
        encounterId: enc.record.id,
        dueOn: "2026-11-01",
        reason: "Recheck",
      },
      ACTOR,
      db,
    );
    expect(cross).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "encounterId",
    });

    const linked = await createFollowUp(
      {
        animalId: theirs.id,
        encounterId: enc.record.id,
        dueOn: "2026-11-01",
        reason: "Recheck",
      },
      ACTOR,
      db,
    );
    expect(linked.ok).toBe(true);
    if (linked.ok) expect(linked.record.encounterId).toBe(enc.record.id);
  });

  test("update reschedules an open item and audits; resolved items refuse edits", async () => {
    const animal = await seedAnimal("EditFu");
    const fu = await seedFollowUp(animal.id, { reason: "Recheck limp" });

    const stale = await updateFollowUp(
      fu.id,
      { animalId: animal.id, dueOn: "2026-12-01", reason: "Recheck limp" },
      "1999-01-01T00:00:00.000Z",
      ACTOR,
      db,
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });

    const moved = await updateFollowUp(
      fu.id,
      {
        animalId: animal.id,
        dueOn: "2026-12-01",
        reason: "Recheck limp",
        notes: "owner asked to push out",
      },
      fu.updatedAt,
      ACTOR,
      db,
    );
    if (!moved.ok) throw new Error("update failed");
    expect(moved.record).toMatchObject({
      dueOn: "2026-12-01",
      notes: "owner asked to push out",
    });

    const done = await completeFollowUp(fu.id, moved.record.updatedAt, ACTOR, db);
    if (!done.ok) throw new Error("complete failed");
    // A resolved item is history — not editable.
    const editResolved = await updateFollowUp(
      fu.id,
      { animalId: animal.id, dueOn: "2027-01-01", reason: "Nope" },
      done.record.updatedAt,
      ACTOR,
      db,
    );
    expect(editResolved).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("completion preserves the full record and audits the transition", async () => {
    const animal = await seedAnimal("CompleteFu");
    const enc = await createEncounter(
      {
        animalId: animal.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Post-op check",
      },
      ACTOR,
      db,
    );
    if (!enc.ok) throw new Error("setup failed");
    const fu = await seedFollowUp(animal.id, {
      encounterId: enc.record.id,
      dueOn: "2026-10-20",
      reason: "Suture removal",
    });

    const done = await completeFollowUp(fu.id, fu.updatedAt, "vet2@test.dev", db);
    if (!done.ok) throw new Error("complete failed");
    expect(done.record).toMatchObject({
      status: "completed",
      reason: "Suture removal",
      dueOn: "2026-10-20",
      encounterId: enc.record.id,
      animalId: animal.id,
    });
    expect(done.record.resolvedAt).not.toBeNull();

    // History: the resolved row still lists on the animal record.
    const all = await listFollowUpsForAnimal(animal.id, db);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("completed");

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, fu.id));
    expect(audit.map((a) => a.action)).toEqual(["create", "complete"]);
    expect(audit[1].actorLabel).toBe("vet2@test.dev");
    // before/after capture the transition — history is auditable.
    expect(audit[1].before).toMatchObject({ status: "open" });
    expect(audit[1].after).toMatchObject({ status: "completed" });
  });

  test("cancellation preserves history the same way", async () => {
    const animal = await seedAnimal("CancelFu");
    const fu = await seedFollowUp(animal.id, { reason: "Recheck wound" });

    const cancelled = await cancelFollowUp(fu.id, fu.updatedAt, ACTOR, db);
    if (!cancelled.ok) throw new Error("cancel failed");
    expect(cancelled.record).toMatchObject({
      status: "cancelled",
      reason: "Recheck wound",
    });
    expect(cancelled.record.resolvedAt).not.toBeNull();

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, fu.id));
    expect(audit.map((a) => a.action)).toEqual(["create", "cancel"]);
  });

  test("a second resolution conflicts — terminal states are not re-writable", async () => {
    const animal = await seedAnimal("TwiceFu");
    const fu = await seedFollowUp(animal.id);

    const done = await completeFollowUp(fu.id, fu.updatedAt, ACTOR, db);
    if (!done.ok) throw new Error("setup failed");

    // Stale token → conflict.
    const staleCancel = await cancelFollowUp(fu.id, fu.updatedAt, ACTOR, db);
    expect(staleCancel).toMatchObject({ ok: false, reason: "conflict" });
    // Fresh token on an already-terminal row → still a conflict: the
    // lifecycle has no completed → cancelled transition.
    const reCancel = await cancelFollowUp(
      fu.id,
      done.record.updatedAt,
      ACTOR,
      db,
    );
    expect(reCancel).toMatchObject({ ok: false, reason: "conflict" });

    const all = await listFollowUpsForAnimal(animal.id, db);
    expect(all[0].status).toBe("completed");
  });

  test("an ownership change keeps the historical snapshot but the queue resolves the current owner", async () => {
    const { animal, person } = await seedOwnedAnimal("Handover");
    const fu = await seedFollowUp(animal.id);
    expect(fu.personId).toBe(person.id);

    // Ownership moves: close the old row, open a new one.
    const [newOwner] = await db
      .insert(schema.persons)
      .values({ fullName: "New Owner" })
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

    // The stored snapshot is untouched — history is the animal's.
    const [reloaded] = await listFollowUpsForAnimal(animal.id, db);
    expect(reloaded.personId).toBe(person.id);

    // The queue resolves the CURRENT owner for context.
    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 60 }, db);
    const item = queue.find(
      (i) => i.kind === "follow-up" && i.id === fu.id,
    );
    expect(item?.kind === "follow-up" && item.currentOwnerName).toBe(
      "New Owner",
    );
  });
});

describe("veterinary work queue", () => {
  test("open items derive overdue/due/upcoming; resolved items are excluded", async () => {
    const animal = await seedAnimal("QueueStates");
    const overdue = await seedFollowUp(animal.id, {
      dueOn: "2026-10-10",
      reason: "Overdue item",
    });
    await seedFollowUp(animal.id, {
      dueOn: AS_OF,
      reason: "Due today item",
    });
    await seedFollowUp(animal.id, {
      dueOn: "2026-10-30",
      reason: "Upcoming item",
    });
    const done = await seedFollowUp(animal.id, {
      dueOn: "2026-10-05",
      reason: "Already done",
    });
    await completeFollowUp(done.id, done.updatedAt, ACTOR, db);
    const cancelled = await seedFollowUp(animal.id, {
      dueOn: "2026-10-06",
      reason: "Already cancelled",
    });
    await cancelFollowUp(cancelled.id, cancelled.updatedAt, ACTOR, db);

    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 30 }, db);
    const mine = queue
      .filter(isFollowUpItem)
      .filter((i) => i.animal.id === animal.id);
    const byReason = new Map(mine.map((i) => [i.reason, i.state]));
    expect(byReason.get("Overdue item")).toBe("overdue");
    // Due today is 'due' — NOT overdue.
    expect(byReason.get("Due today item")).toBe("due");
    expect(byReason.get("Upcoming item")).toBe("upcoming");
    expect(byReason.has("Already done")).toBe(false);
    expect(byReason.has("Already cancelled")).toBe(false);

    // Overdue sorts before due before upcoming.
    expect(mine.map((i) => i.reason)).toEqual([
      "Overdue item",
      "Due today item",
      "Upcoming item",
    ]);
    void overdue;
  });

  test("the queue joins animal, source encounter, and current owner", async () => {
    const { animal, person } = await seedOwnedAnimal("Joined");
    const enc = await createEncounter(
      {
        animalId: animal.id,
        kind: "visit",
        occurredOn: "2020-01-01",
        reason: "Limping",
      },
      ACTOR,
      db,
    );
    if (!enc.ok) throw new Error("setup failed");
    const fu = await seedFollowUp(animal.id, {
      encounterId: enc.record.id,
      dueOn: "2026-10-20",
      reason: "Recheck limp",
      notes: "watch gait",
    });

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const item = queue.find((i) => i.kind === "follow-up" && i.id === fu.id);
    if (!item || item.kind !== "follow-up") throw new Error("missing item");
    expect(item).toMatchObject({
      dueOn: "2026-10-20",
      reason: "Recheck limp",
      notes: "watch gait",
      encounterId: enc.record.id,
      encounterOn: "2020-01-01",
      state: "upcoming",
      currentOwnerName: `${"Joined"} Owner`,
      animal: { id: animal.id, name: "Joined", species: "dog" },
    });
    expect(person.id).toBeTruthy();
  });

  test("registration-linked and animal-less follow-ups stay out of the vet queue", async () => {
    const animal = await seedAnimal("RegFu");
    // A registration-scoped follow-up is operational work (#177), not
    // veterinary — even though it carries an animal link.
    await db.insert(schema.registrations).values({
      animalId: animal.id,
      year: 2026,
      status: "pending",
    });
    const [reg] = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.animalId, animal.id));
    await db.insert(schema.followUps).values({
      animalId: animal.id,
      registrationId: reg.id,
      kind: "registration",
      dueOn: "2026-10-10",
      reason: "Chase missing registration",
    });
    await db.insert(schema.followUps).values({
      kind: "other",
      dueOn: "2026-10-10",
      reason: "No animal attached",
    });

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const rows = queue.filter((i) => i.kind === "follow-up");
    expect(
      rows.find((i) => i.kind === "follow-up" && i.reason?.includes("Chase")),
    ).toBeUndefined();
    expect(
      rows.find(
        (i) => i.kind === "follow-up" && i.reason?.includes("No animal"),
      ),
    ).toBeUndefined();
  });

  test("vaccinations surface through the canonical service — superseded doses stay history", async () => {
    const animal = await seedAnimal("VaxQueue");
    // Old dose due long ago — superseded by the newer dose, so it must
    // never resurface in the queue.
    const old = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2024-01-01",
        dueOn: "2025-01-01",
      },
      ACTOR,
      db,
    );
    const newer = await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-01-01",
        dueOn: "2026-10-20",
      },
      ACTOR,
      db,
    );
    if (!old.ok || !newer.ok) throw new Error("setup failed");

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const vax = queue.filter(
      (i) => i.kind === "vaccination" && i.animal.id === animal.id,
    );
    expect(vax).toHaveLength(1);
    const item = vax[0];
    if (item.kind !== "vaccination") throw new Error("wrong kind");
    expect(item.id).toBe(newer.vaccination.id);
    expect(item.state).toBe("due-soon");
    expect(item.vaccineName).toBe("Rabies");
    expect(item.effectiveDate).toBe("2026-10-20");
  });

  test("active critical/important alerts queue; info and resolved do not", async () => {
    const animal = await seedAnimal("AlertQueue");
    for (const [severity, status, summary] of [
      ["critical", "active", "Penicillin allergy"],
      ["important", "active", "Heart murmur"],
      ["info", "active", "Mild anxiety"],
      ["critical", "resolved", "Old resolved allergy"],
    ] as const) {
      const r = await createAlert(
        {
          animalId: animal.id,
          kind: "allergy",
          severity,
          summary,
          recordedOn: "2026-09-01",
          status,
          resolvedOn: status === "resolved" ? "2026-09-15" : null,
        },
        ACTOR,
        db,
      );
      if (!r.ok) throw new Error("setup failed");
    }

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const alerts = queue.filter(
      (i) => i.kind === "alert" && i.animal.id === animal.id,
    );
    expect(
      alerts.map((a) => a.kind === "alert" && a.summary).sort(),
    ).toEqual(["Heart murmur", "Penicillin allergy"]);
    // Critical outranks important within the alert tail.
    expect(alerts[0].kind === "alert" && alerts[0].summary).toBe(
      "Penicillin allergy",
    );
  });

  test("dated work sorts ahead of alerts; summary counts agree with the list", async () => {
    const animal = await seedAnimal("Ordering");
    await seedFollowUp(animal.id, {
      dueOn: "2026-10-01",
      reason: "Old overdue",
    });
    await seedFollowUp(animal.id, {
      dueOn: "2026-10-12",
      reason: "Recent overdue",
    });
    await createAlert(
      {
        animalId: animal.id,
        kind: "condition",
        severity: "critical",
        summary: "Seizure history",
        recordedOn: "2026-01-01",
        status: "active",
      },
      ACTOR,
      db,
    );

    const queue = await listVetQueue({ asOf: AS_OF }, db);
    const mine = queue.filter((i) => i.animal.id === animal.id);
    const key = (i: VetQueueItem) =>
      i.kind === "follow-up"
        ? `fu:${i.reason}`
        : i.kind === "alert"
          ? `alert:${i.severity}`
          : `vax:${i.vaccineName}`;
    expect(mine.map(key)).toEqual([
      "fu:Old overdue",
      "fu:Recent overdue",
      "alert:critical",
    ]);

    const summary = await vetQueueSummary({ asOf: AS_OF }, db);
    // Counts derive from the same list — verify against a global count
    // computed from the queue, not a fixed expectation (other tests
    // share the database).
    const overdueFus = queue.filter(
      (i) => i.kind === "follow-up" && i.state === "overdue",
    ).length;
    const criticals = queue.filter(
      (i) => i.kind === "alert" && i.severity === "critical",
    ).length;
    expect(summary.overdueFollowUps).toBe(overdueFus);
    expect(summary.criticalAlerts).toBe(criticals);
    expect(summary.total).toBe(queue.length);
  });

  test("items beyond the window stay off the queue but remain open", async () => {
    const animal = await seedAnimal("Horizon");
    await seedFollowUp(animal.id, {
      dueOn: "2027-06-01",
      reason: "Far future",
    });

    const queue = await listVetQueue({ asOf: AS_OF, withinDays: 30 }, db);
    expect(
      queue.find(
        (i) => i.kind === "follow-up" && i.reason === "Far future",
      ),
    ).toBeUndefined();

    // A wider window picks it up — it was open, just not actionable yet.
    const wide = await listVetQueue({ asOf: AS_OF, withinDays: 300 }, db);
    expect(
      wide.find(
        (i) => i.kind === "follow-up" && i.reason === "Far future",
      ),
    ).toBeDefined();
  });

  test("a malformed asOf fails loudly instead of reporting an empty queue", async () => {
    await expect(
      listVetQueue({ asOf: "15-10-2026" }, db),
    ).rejects.toThrow("asOf");
  });
});
