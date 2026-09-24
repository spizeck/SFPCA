// Communication ledger + delivery tests (#172), run against PGlite —
// real Postgres semantics for the idempotency unique index, the
// conditional-claim UPDATE, FK integrity, and the state machine.
// The email provider is a fake EmailSender — nothing here sends mail.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  deliverQueuedCommunications,
  insertCommunication,
  isOptedOut,
  listCommunicationExceptions,
  listCommunicationsForAnimal,
  communicationSummary,
  markCommunicationDelivered,
  markCommunicationFailed,
  reclaimStaleSends,
  requeueCommunication,
  resolveAnimalOwner,
  setCommunicationPreference,
  MAX_SEND_ATTEMPTS,
  STALE_SENDING_MS,
} from "@/lib/registry/communications";
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

// The drain and the exception/summary reads operate on the whole
// ledger — a clean slate per test keeps their counts deterministic.
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE communications, communication_preferences, vaccinations, ownerships, household_members, households, persons, animals, audit_events CASCADE`,
  );
});

async function seedPerson(email: string | null = "owner@example.com") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName: "Jane Owner", email })
    .returning();
  return person;
}

async function seedAnimal(name = "Rex") {
  const [animal] = await db
    .insert(schema.animals)
    .values({ name, species: "dog", sex: "male", lifecycleStatus: "adopted" })
    .returning();
  return animal;
}

const QUEUED_INSERT = {
  personId: null as string | null,
  channel: "email",
  kind: "vaccination-reminder",
  status: "queued" as const,
  recipient: "owner@example.com",
  subject: "Vaccination reminder for Rex",
  bodyText: "Hello Jane, ...",
  bodyHtml: "<p>Hello Jane, ...</p>",
};

let keyCounter = 0;
function nextKey() {
  return `test-key:${++keyCounter}`;
}

function fakeSender(outcome: SendOutcome): EmailSender & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    provider: "fake",
    calls,
    send: async (message, idempotencyKey) => {
      calls.push([message, idempotencyKey]);
      return outcome;
    },
  };
}

describe("insertCommunication", () => {
  test("idempotency key makes concurrent/repeated inserts collapse to one row", async () => {
    const person = await seedPerson();
    const input = {
      ...QUEUED_INSERT,
      personId: person.id,
      idempotencyKey: nextKey(),
    };
    // Sequential duplicate — a retried evaluator.
    expect(await insertCommunication(input, db)).toBe("inserted");
    expect(await insertCommunication(input, db)).toBe("duplicate");
    // Concurrent claim of the same logical send — the unique index
    // guarantees exactly one winner. PGlite serializes onto one
    // connection, so this exercises the conflict path rather than a
    // true race — but the outcome is what callers rely on.
    const raced = { ...input, idempotencyKey: nextKey() };
    const [a, b] = await Promise.all([
      insertCommunication(raced, db),
      insertCommunication(raced, db),
    ]);
    expect([a, b].sort()).toEqual(["duplicate", "inserted"]);
  });

  test("a dangling person reference is reported, not thrown", async () => {
    const outcome = await insertCommunication(
      {
        ...QUEUED_INSERT,
        personId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: nextKey(),
      },
      db,
    );
    expect(outcome).toBe("invalid-person");
  });
});

describe("deliverQueuedCommunications", () => {
  test("queued → sent: provider acceptance stamps sent_at + message id", async () => {
    const person = await seedPerson();
    await insertCommunication(
      { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
      db,
    );
    const sender = fakeSender({ ok: true, providerMessageId: "msg_1" });

    const counts = await deliverQueuedCommunications({ sender }, db);
    expect(counts.sent).toBe(1);

    const [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    expect(row).toMatchObject({
      status: "sent",
      provider: "fake",
      providerMessageId: "msg_1",
      attempts: 1,
      detail: null,
    });
    expect(row.sentAt).not.toBeNull();
    // The row uuid is the provider idempotency key — a provider-side
    // duplicate of THIS row can never double-send.
    expect(sender.calls[0][1]).toBe(row.id);
  });

  test("a queued row missing its message is 'malformed', never sent", async () => {
    const person = await seedPerson();
    // Bypass insertCommunication defaults — a legacy queued row without
    // a rendered body simulates malformed intent.
    await db.insert(schema.communications).values({
      personId: person.id,
      channel: "email",
      kind: "vaccination-reminder",
      status: "queued",
      idempotencyKey: nextKey(),
      recipient: "owner@example.com",
      subject: "x",
      // no body_text / body_html
    });
    const sender = fakeSender({ ok: true, providerMessageId: "m" });
    const counts = await deliverQueuedCommunications({ sender }, db);
    expect(counts.malformed).toBe(1);
    expect(sender.calls).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    expect(row).toMatchObject({ status: "failed", detail: "malformed" });
  });

  test("provider-unavailable requeues; the attempt cap turns it terminal", async () => {
    const person = await seedPerson();
    await insertCommunication(
      { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
      db,
    );
    const sender = fakeSender({
      ok: false,
      failure: "unavailable",
      detail: "application_error",
    });

    const first = await deliverQueuedCommunications({ sender }, db);
    expect(first.requeued).toBe(1);
    let [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    expect(row).toMatchObject({
      status: "queued",
      attempts: 1,
      detail: "provider-unavailable",
    });

    // Simulate near-cap history — the next failure is terminal.
    await db
      .update(schema.communications)
      .set({ attempts: MAX_SEND_ATTEMPTS - 1 })
      .where(eq(schema.communications.id, row.id));
    const second = await deliverQueuedCommunications({ sender }, db);
    expect(second.failed).toBe(1);
    [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.id, row.id));
    expect(row).toMatchObject({ status: "failed", detail: "retry-exhausted" });
  });

  test("rejected and uncertain outcomes are terminal — automation never resends them", async () => {
    const person = await seedPerson();
    for (const [failure, detail] of [
      ["rejected", "provider-rejected"],
      ["uncertain", "interrupted"],
    ] as const) {
      await insertCommunication(
        { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
        db,
      );
      const counts = await deliverQueuedCommunications(
        { sender: fakeSender({ ok: false, failure, detail: "x" }) },
        db,
      );
      expect(counts.failed).toBe(1);
    }
    const rows = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    expect(rows.map((r) => r.detail).sort()).toEqual([
      "interrupted",
      "provider-rejected",
    ]);
  });

  test("a row already 'sending' is not re-sent by a second drain", async () => {
    const person = await seedPerson();
    await insertCommunication(
      { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
      db,
    );
    await db
      .update(schema.communications)
      .set({ status: "sending", lastAttemptAt: new Date() })
      .where(eq(schema.communications.personId, person.id));
    const sender = fakeSender({ ok: true, providerMessageId: "m" });
    const counts = await deliverQueuedCommunications({ sender }, db);
    expect(sender.calls).toHaveLength(0);
    expect(counts.claimed).toBe(0);
  });

  test("a stale 'sending' row is reclaimed as an interrupted exception", async () => {
    const person = await seedPerson();
    await insertCommunication(
      { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
      db,
    );
    await db
      .update(schema.communications)
      .set({
        status: "sending",
        lastAttemptAt: new Date(Date.now() - STALE_SENDING_MS - 1000),
      })
      .where(eq(schema.communications.personId, person.id));
    const reclaimed = await reclaimStaleSends({}, db);
    expect(reclaimed).toBe(1);
    const [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    expect(row).toMatchObject({ status: "failed", detail: "interrupted" });
  });
});

describe("provider outcome ingestion", () => {
  async function seedSentRow() {
    const person = await seedPerson();
    await insertCommunication(
      { ...QUEUED_INSERT, personId: person.id, idempotencyKey: nextKey() },
      db,
    );
    const sender = fakeSender({ ok: true, providerMessageId: "msg_x" });
    await deliverQueuedCommunications({ sender }, db);
    const [row] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.personId, person.id));
    return row;
  }

  test("delivered refines sent exactly once — duplicate webhooks are no-ops", async () => {
    const row = await seedSentRow();
    expect(await markCommunicationDelivered("msg_x", new Date(), db)).toBe(1);
    const [after] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.id, row.id));
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).not.toBeNull();
    // Idempotent — a redelivered event changes nothing.
    expect(await markCommunicationDelivered("msg_x", new Date(), db)).toBe(0);
    // Unknown message ids match nothing.
    expect(await markCommunicationDelivered("msg_other", new Date(), db)).toBe(0);
  });

  test("bounced/failed events move sent or delivered rows to failed", async () => {
    const row = await seedSentRow();
    expect(await markCommunicationFailed("msg_x", "bounced", new Date(), db)).toBe(1);
    const [after] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.id, row.id));
    expect(after).toMatchObject({ status: "failed", detail: "bounced" });
    // A queued row that never sent cannot be failed by a webhook.
    const [queued] = await db
      .insert(schema.communications)
      .values({
        personId: row.personId,
        channel: "email",
        kind: "vaccination-reminder",
        status: "queued",
        idempotencyKey: nextKey(),
        providerMessageId: "msg_q",
      })
      .returning();
    expect(await markCommunicationFailed("msg_q", "bounced", new Date(), db)).toBe(0);
    const [still] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.id, queued.id));
    expect(still.status).toBe("queued");
  });
});

describe("preferences and requeue", () => {
  test("preference upsert toggles opt-out and writes an audit row", async () => {
    const person = await seedPerson();
    expect(await isOptedOut(person.id, "email", "vaccination-reminder", db)).toBe(false);
    expect(
      await setCommunicationPreference(
        {
          personId: person.id,
          channel: "email",
          kind: "vaccination-reminder",
          optedOut: true,
        },
        "staff@test.dev",
        db,
      ),
    ).toEqual({ ok: true });
    expect(await isOptedOut(person.id, "email", "vaccination-reminder", db)).toBe(true);
    // Opt back in — the same row flips, no duplicate.
    await setCommunicationPreference(
      {
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        optedOut: false,
      },
      "staff@test.dev",
      db,
    );
    expect(await isOptedOut(person.id, "email", "vaccination-reminder", db)).toBe(false);
    const prefs = await db
      .select()
      .from(schema.communicationPreferences)
      .where(eq(schema.communicationPreferences.personId, person.id));
    expect(prefs).toHaveLength(1);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, person.id));
    expect(audit.map((a) => a.action)).toEqual([
      "communication-preference",
      "communication-preference",
    ]);
  });

  test("requeue returns a failed row to queued once; other states refuse", async () => {
    const person = await seedPerson();
    const [row] = await db
      .insert(schema.communications)
      .values({
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "failed",
        detail: "interrupted",
        idempotencyKey: nextKey(),
      })
      .returning();
    expect(await requeueCommunication(row.id, "staff@test.dev", db)).toEqual({
      ok: true,
    });
    const [after] = await db
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.id, row.id));
    expect(after).toMatchObject({ status: "queued", detail: null });
    // Now queued — a second requeue is a refusal, not a state change.
    expect(await requeueCommunication(row.id, "staff@test.dev", db)).toEqual({
      ok: false,
      reason: "not-failed",
    });
    expect(
      await requeueCommunication(
        "00000000-0000-4000-8000-000000000000",
        "staff@test.dev",
        db,
      ),
    ).toEqual({ ok: false, reason: "not-found" });
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, row.id));
    expect(audit.map((a) => a.action)).toEqual(["requeue"]);
  });
});

describe("staff reads", () => {
  test("exceptions list contains failed+skipped only, with names joined", async () => {
    const person = await seedPerson();
    const animal = await seedAnimal("Except");
    await db.insert(schema.communications).values([
      {
        personId: person.id,
        animalId: animal.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "failed",
        detail: "bounced",
        idempotencyKey: nextKey(),
      },
      {
        personId: person.id,
        animalId: animal.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "skipped",
        detail: "missing-email",
        idempotencyKey: nextKey(),
      },
      {
        personId: person.id,
        animalId: animal.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "sent",
        sentAt: new Date(),
        idempotencyKey: nextKey(),
      },
    ]);
    const exceptions = (await listCommunicationExceptions({}, db)).filter(
      (e) => e.personId === person.id,
    );
    expect(exceptions.map((e) => e.status).sort()).toEqual(["failed", "skipped"]);
    expect(exceptions[0].personName).toBe("Jane Owner");
    expect(exceptions[0].animalName).toBe("Except");

    const history = await listCommunicationsForAnimal(animal.id, {}, db);
    expect(history).toHaveLength(3);
  });

  test("summary counts needsAction = failures + fixable skips", async () => {
    const person = await seedPerson();
    const before = await communicationSummary(db);
    await db.insert(schema.communications).values([
      {
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "failed",
        detail: "bounced",
        idempotencyKey: nextKey(),
      },
      {
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "skipped",
        detail: "no-owner",
        idempotencyKey: nextKey(),
      },
      {
        personId: person.id,
        channel: "email",
        kind: "vaccination-reminder",
        status: "skipped",
        detail: "opted-out",
        idempotencyKey: nextKey(),
      },
    ]);
    const after = await communicationSummary(db);
    expect(after.failed - before.failed).toBe(1);
    expect(after.skipped - before.skipped).toBe(2);
    // Opt-out is a recipient's choice, not an exception to fix.
    expect(after.needsAction - before.needsAction).toBe(2);
  });
});

describe("resolveAnimalOwner", () => {
  test("person owner resolves; missing/ambiguous/household all skip closed", async () => {
    const asOf = "2026-09-23";
    const person = await seedPerson();
    const animal = await seedAnimal("Owned");
    await db.insert(schema.ownerships).values({
      animalId: animal.id,
      personId: person.id,
      validFrom: "2025-01-01",
    });
    const resolved = await resolveAnimalOwner(animal.id, asOf, db);
    expect(resolved).toMatchObject({
      status: "ok",
      personId: person.id,
      email: "owner@example.com",
    });

    const stray = await seedAnimal("Stray");
    expect(await resolveAnimalOwner(stray.id, asOf, db)).toEqual({
      status: "skip",
      detail: "no-owner",
      personId: null,
    });

    // Two simultaneously-valid ownerships = ambiguous data, never a guess.
    const second = await seedPerson("second@example.com");
    const contested = await seedAnimal("Contested");
    await db.insert(schema.ownerships).values([
      { animalId: contested.id, personId: person.id, validFrom: "2025-01-01" },
      { animalId: contested.id, personId: second.id, validFrom: "2025-01-01" },
    ]);
    expect(await resolveAnimalOwner(contested.id, asOf, db)).toEqual({
      status: "skip",
      detail: "ambiguous-ownership",
      personId: null,
    });

    const [household] = await db
      .insert(schema.households)
      .values({ name: "Smith Family" })
      .returning();
    const householdAnimal = await seedAnimal("Household");
    await db.insert(schema.ownerships).values({
      animalId: householdAnimal.id,
      householdId: household.id,
      validFrom: "2025-01-01",
    });
    expect(await resolveAnimalOwner(householdAnimal.id, asOf, db)).toEqual({
      status: "skip",
      detail: "household-no-contact",
      personId: null,
    });

    // Closed ownership leaves the animal ownerless at asOf.
    const former = await seedAnimal("Former");
    await db.insert(schema.ownerships).values({
      animalId: former.id,
      personId: person.id,
      validFrom: "2024-01-01",
      validTo: "2026-01-01",
    });
    expect(await resolveAnimalOwner(former.id, asOf, db)).toEqual({
      status: "skip",
      detail: "no-owner",
      personId: null,
    });
  });
});
