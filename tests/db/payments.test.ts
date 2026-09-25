// Authoritative payment-ledger tests (#170), run against PGlite so real
// Postgres semantics apply: CHECK constraints, partial unique indexes,
// row locking, and transactional writes.
//
// The properties under test are the issue's invariants:
//   - payment initiation is not payment truth — only 'confirmed' rows
//     settle a balance; pending/failed/void never do;
//   - confirmed money is append-only — refunds/adjustments are new rows
//     linked to the original, never edits;
//   - external identity (provider, provider_ref) and caller
//     idempotency keys dedupe to the existing row;
//   - every staff mutation writes BOTH a payment_events reconciliation
//     row and an audit_events row;
//   - the unpaid-balance reminder reads the canonical projection only.

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  createRegistration,
  getRegistrationQueues,
  listUnpaidRegistrations,
  recordRegistrationPayment,
  resolveRegistrationFee,
  correctRegistrationAmount,
} from "@/lib/registry/registrations";
import {
  confirmPayment,
  initiateProviderPayment,
  listPaymentEvents,
  listPaymentsForRegistration,
  moneyByRegistration,
  reconcileProviderOutcome,
  recordAdjustment,
  recordManualPayment,
  refundPayment,
  registrationBalance,
  voidPayment,
} from "@/lib/registry/payments";
import { evaluateRegistrationPaymentReminders } from "@/lib/registry/reminders";
import { createOwnership } from "@/lib/registry/ownership";
import { REGISTRATION_FEE_NOT_FIXED } from "@/lib/animal-registration";

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
    sql`TRUNCATE payment_events, payments, registration_submissions, registrations, ownerships, household_members, households, persons, animals, audit_events, communications CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";
const YEAR = 2026;
const DUE = REGISTRATION_FEE_NOT_FIXED * 100;

async function seedAnimal(name = "Rex") {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name,
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      sterilizationStatus: "intact",
    })
    .returning();
  return animal;
}

async function seedPerson(
  fullName = "Jane Owner",
  email: string | null = "jane@example.com",
) {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName, email })
    .returning();
  return person;
}

async function seedRegistered(opts: { year?: number; due?: number } = {}) {
  const animal = await seedAnimal();
  const person = await seedPerson();
  const own = await createOwnership(
    { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
    STAFF,
    db,
  );
  if (!own.ok) throw new Error("setup");
  const reg = await createRegistration(
    {
      animalId: animal.id,
      year: opts.year ?? YEAR,
      ...(opts.due !== undefined ? { amountDueCents: opts.due } : {}),
    },
    STAFF,
    db,
  );
  if (!reg.ok) throw new Error("setup");
  return { animal, person, registration: reg.registration };
}

async function paymentRows(registrationId: string) {
  return db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.registrationId, registrationId));
}

async function paymentEventsFor(paymentId: string) {
  return db
    .select({ event: schema.paymentEvents.event })
    .from(schema.paymentEvents)
    .where(eq(schema.paymentEvents.paymentId, paymentId));
}

async function auditActions(entityType: string) {
  const rows = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityType, entityType));
  return rows.map((r) => r.action);
}

// --- Manual payments -----------------------------------------------------------

describe("recordManualPayment — staff money", () => {
  test("cash/bank/other all record as confirmed money that settles", async () => {
    const { registration } = await seedRegistered({ due: 3000 });
    for (const [i, method] of [
      "cash",
      "bank-transfer",
      "other",
    ].entries()) {
      const r = await recordManualPayment(
        registration.id,
        { amountCents: 1000, method: method as "cash" },
        STAFF,
        db,
      );
      expect(r.ok).toBe(true);
      if (r.ok && i === 2) {
        expect(r.balance.settledCents).toBe(3000);
        expect(r.balance.outstandingCents).toBe(0);
        expect(r.balance.paymentState).toBe("paid");
      }
    }
    const rows = await paymentRows(registration.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("confirmed");
      expect(row.source).toBe("staff");
      expect(row.recordedBy).toBe(STAFF);
      expect(row.currency).toBe("USD");
      expect(row.provider).toBeNull(); // manual money is not provider rows
    }
  });

  test("partial payment keeps the registration outstanding with the right remainder", async () => {
    const { registration } = await seedRegistered({ due: DUE });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 1000, method: "cash" },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.balance.paymentState).toBe("partial");
    expect(r.balance.outstandingCents).toBe(DUE - 1000);
  });

  test("the payment stamps the registration's currency — mismatches are impossible through the service", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 1000, method: "cash" },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    const [row] = await paymentRows(registration.id);
    expect(row.currency).toBe(registration.currency);
  });

  test("pending bank transfers do NOT settle until confirmed", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    // Declared intent only — the balance is unmoved.
    expect(r.balance.settledCents).toBe(0);
    expect(r.balance.pendingCents).toBe(2000);
    expect(r.balance.paymentState).toBe("unpaid");

    const confirmed = await confirmPayment(
      r.paymentId,
      { reference: "BANK-123" },
      STAFF,
      db,
    );
    if (!confirmed.ok) throw new Error("setup");
    expect(confirmed.balance.settledCents).toBe(2000);
    expect(confirmed.balance.paymentState).toBe("paid");

    const [row] = await paymentRows(registration.id);
    expect(row.reference).toBe("BANK-123");
    expect(await paymentEventsFor(r.paymentId)).toEqual(
      expect.arrayContaining([
        { event: "recorded" },
        { event: "confirmed" },
      ]),
    );
    expect(await auditActions("payment")).toEqual(
      expect.arrayContaining(["record-payment", "confirm-payment"]),
    );
  });

  test("a pending flag is only honest for bank transfers — cash/other are rejected", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    for (const method of ["cash", "other"] as const) {
      const r = await recordManualPayment(
        registration.id,
        { amountCents: 1000, method, pending: true },
        STAFF,
        db,
      );
      expect(r).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  test("idempotency key dedupes a retried submission to one row", async () => {
    const { registration } = await seedRegistered({ due: 5000 });
    const key = crypto.randomUUID();
    const args = {
      amountCents: 5000,
      method: "cash" as const,
      idempotencyKey: key,
    };
    const first = await recordManualPayment(registration.id, args, STAFF, db);
    const second = await recordManualPayment(registration.id, args, STAFF, db);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) {
      expect(second.paymentId).toBe(first.paymentId);
    }
    expect(await paymentRows(registration.id)).toHaveLength(1);
  });

  test("validation: positive integer amounts, known methods, real registration", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    expect(
      await recordManualPayment(
        registration.id,
        { amountCents: 0, method: "cash" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordManualPayment(
        registration.id,
        { amountCents: 10.5, method: "cash" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordManualPayment(
        registration.id,
        { amountCents: 100, method: "online" as "cash" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordManualPayment(
        "11111111-2222-3333-4444-555555555555",
        { amountCents: 100, method: "cash" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("overpayment is explicit — settled exceeds assessed, state stays paid", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 1500, method: "cash" },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.balance.settledCents).toBe(1500);
    expect(r.balance.overpaidCents).toBe(500);
    expect(r.balance.outstandingCents).toBe(0);
    expect(r.balance.paymentState).toBe("paid");
  });
});

// --- Pending lifecycle -----------------------------------------------------------

describe("confirm/void — deliberate reconciliation only", () => {
  test("confirming an already-confirmed or missing row conflicts", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 1000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect((await confirmPayment(r.paymentId, {}, STAFF, db)).ok).toBe(true);
    // Second confirm — the money is already truth; never re-transition.
    expect(await confirmPayment(r.paymentId, {}, STAFF, db)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(
      await confirmPayment(
        "11111111-2222-3333-4444-555555555555",
        {},
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("void requires a reason and only acts on pending rows", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    const r = await recordManualPayment(
      registration.id,
      { amountCents: 1000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(
      await voidPayment(r.paymentId, { reason: "  " }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "invalid" });

    const v = await voidPayment(
      r.paymentId,
      { reason: "Claimed transfer never arrived" },
      STAFF,
      db,
    );
    if (!v.ok) throw new Error("setup");
    const [row] = await paymentRows(registration.id);
    expect(row.status).toBe("void");
    expect(v.balance.settledCents).toBe(0);
    expect(await paymentEventsFor(r.paymentId)).toEqual(
      expect.arrayContaining([{ event: "recorded" }, { event: "voided" }]),
    );
    // Confirmed money can NEVER be voided — it leaves via refund only.
    const paid = await recordManualPayment(
      registration.id,
      { amountCents: 500, method: "cash" },
      STAFF,
      db,
    );
    if (!paid.ok) throw new Error("setup");
    expect(
      await voidPayment(paid.paymentId, { reason: "x" }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });
});

// --- Refunds ------------------------------------------------------------------------

describe("refundPayment — money out is a new row", () => {
  test("partial and full refunds; original payment is untouched", async () => {
    const { registration } = await seedRegistered({ due: 3000 });
    const pay = await recordManualPayment(
      registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");

    const partial = await refundPayment(
      pay.paymentId,
      { amountCents: 1000, reason: "Overcharged" },
      STAFF,
      db,
    );
    if (!partial.ok) throw new Error("setup");
    expect(partial.balance.settledCents).toBe(2000);
    expect(partial.balance.outstandingCents).toBe(1000);
    expect(partial.balance.paymentState).toBe("partial");

    const [original] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, pay.paymentId));
    expect(original.status).toBe("confirmed");
    expect(original.amountCents).toBe(3000); // never edited

    const [refund] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, partial.paymentId));
    expect(refund.kind).toBe("refund");
    expect(refund.relatedPaymentId).toBe(pay.paymentId);
    expect(refund.status).toBe("confirmed");

    // The parent's trail records the refund event.
    expect(await paymentEventsFor(pay.paymentId)).toEqual(
      expect.arrayContaining([{ event: "recorded" }, { event: "refunded" }]),
    );
    expect(await auditActions("payment")).toContain("refund-payment");

    // Full refund of the remainder returns the debt in full.
    const rest = await refundPayment(
      pay.paymentId,
      { amountCents: 2000, reason: "Registration withdrawn" },
      STAFF,
      db,
    );
    if (!rest.ok) throw new Error("setup");
    expect(rest.balance.settledCents).toBe(0);
    expect(rest.balance.paymentState).toBe("unpaid");
  });

  test("refund cannot exceed the refundable amount, even across partials", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const pay = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");
    await refundPayment(
      pay.paymentId,
      { amountCents: 1500, reason: "Partial" },
      STAFF,
      db,
    );
    expect(
      await refundPayment(
        pay.paymentId,
        { amountCents: 600, reason: "Too much" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "exceeds-refundable" });
    // Exactly the remaining refundable amount still works.
    expect(
      (
        await refundPayment(
          pay.paymentId,
          { amountCents: 500, reason: "Remainder" },
          STAFF,
          db,
        )
      ).ok,
    ).toBe(true);
  });

  test("refunds require a reason and a confirmed payment target", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const pending = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    if (!pending.ok) throw new Error("setup");
    // No money ever arrived — there is nothing to refund.
    expect(
      await refundPayment(
        pending.paymentId,
        { amountCents: 100, reason: "x" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });

    const pay = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");
    expect(
      await refundPayment(
        pay.paymentId,
        { amountCents: 100, reason: "" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

// --- Adjustments -----------------------------------------------------------------------

describe("recordAdjustment — bookkeeping corrections, not money", () => {
  test("signed adjustments move settled money and require a reason", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const pay = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");

    expect(
      await recordAdjustment(
        registration.id,
        { amountCents: -500, reason: "" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await recordAdjustment(
        registration.id,
        { amountCents: 0, reason: "zero" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });

    // The recorded amount was mis-keyed — correct it down.
    const adj = await recordAdjustment(
      registration.id,
      {
        amountCents: -500,
        reason: "Amount was 1500, keyed as 2000",
        relatedPaymentId: pay.paymentId,
      },
      STAFF,
      db,
    );
    if (!adj.ok) throw new Error("setup");
    expect(adj.balance.settledCents).toBe(1500);
    expect(adj.balance.outstandingCents).toBe(500);
    expect(adj.balance.paymentState).toBe("partial");

    // The linked parent's trail shows the adjustment.
    expect(await paymentEventsFor(pay.paymentId)).toEqual(
      expect.arrayContaining([{ event: "recorded" }, { event: "adjusted" }]),
    );
    expect(await auditActions("payment")).toContain("record-adjustment");
  });

  test("an adjustment unrelated to a payment still lands on the registration", async () => {
    const { registration } = await seedRegistered({ due: 1000 });
    const adj = await recordAdjustment(
      registration.id,
      { amountCents: 1000, reason: "Payment recorded on paper ledger only" },
      STAFF,
      db,
    );
    if (!adj.ok) throw new Error("setup");
    expect(adj.balance.paymentState).toBe("paid");
    const [row] = await paymentRows(registration.id);
    expect(row.kind).toBe("adjustment");
    expect(row.relatedPaymentId).toBeNull();
  });

  test("registration amount correction changes the assessment, not the ledger", async () => {
    const { registration } = await seedRegistered({ due: 3000 });
    await recordManualPayment(
      registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );
    // Obligation corrected UP — settled money is now short.
    const c = await correctRegistrationAmount(
      registration.id,
      4000,
      "Second animal on the same submission",
      STAFF,
      db,
    );
    if (!c.ok) throw new Error("setup");
    expect(c.registration.paidCents).toBe(3000);
    expect(c.registration.outstandingCents).toBe(1000);
    expect(c.registration.paymentState).toBe("partial");
  });
});

// --- Provider seam (#171) -------------------------------------------------------------

describe("provider seam — initiation is not truth", () => {
  test("a provider initiation creates a pending row that never settles", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const init = await initiateProviderPayment(
      {
        provider: "sentoo",
        providerRef: "checkout-abc",
        registrationId: registration.id,
        amountCents: 2000,
      },
      db,
    );
    expect(init).toMatchObject({ ok: true, created: true });

    const balance = await registrationBalance(
      {
        id: registration.id,
        amountDueCents: registration.amountDueCents,
        resolution: null,
      },
      db,
    );
    expect(balance.settledCents).toBe(0);
    expect(balance.pendingCents).toBe(2000);
    expect(balance.paymentState).toBe("unpaid");

    const [row] = await paymentRows(registration.id);
    expect(row.method).toBe("online");
    expect(row.source).toBe("provider");
    expect(row.provider).toBe("sentoo");
    expect(row.providerRef).toBe("checkout-abc");
  });

  test("duplicate external reference resolves to the same row", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const args = {
      provider: "sentoo",
      providerRef: "checkout-abc",
      registrationId: registration.id,
      amountCents: 2000,
    };
    const first = await initiateProviderPayment(args, db);
    const second = await initiateProviderPayment(args, db);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) {
      expect(second.paymentId).toBe(first.paymentId);
    }
    expect(await paymentRows(registration.id)).toHaveLength(1);
  });

  test("authoritative reconcile transitions pending; replays are no-ops; contradictions conflict", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const init = await initiateProviderPayment(
      {
        provider: "sentoo",
        providerRef: "checkout-abc",
        registrationId: registration.id,
        amountCents: 2000,
      },
      db,
    );
    if (!init.ok) throw new Error("setup");

    const applied = await reconcileProviderOutcome(
      { provider: "sentoo", providerRef: "checkout-abc", outcome: "confirmed" },
      db,
    );
    expect(applied).toMatchObject({ ok: true, applied: "transitioned" });
    if (applied.ok) {
      expect(applied.balance?.paymentState).toBe("paid");
    }

    // Webhook delivered again — the ledger already knows.
    const replay = await reconcileProviderOutcome(
      { provider: "sentoo", providerRef: "checkout-abc", outcome: "confirmed" },
      db,
    );
    expect(replay).toMatchObject({ ok: true, applied: "existing" });

    // A contradictory authoritative outcome never silently rewrites
    // confirmed money.
    const contradict = await reconcileProviderOutcome(
      { provider: "sentoo", providerRef: "checkout-abc", outcome: "failed" },
      db,
    );
    expect(contradict).toMatchObject({ ok: false, reason: "conflict" });
    const [row] = await paymentRows(registration.id);
    expect(row.status).toBe("confirmed");

    // Events preserve the full reconciliation trail.
    const events = await listPaymentEvents([init.paymentId], db);
    expect(events.map((e) => e.event)).toEqual(["recorded", "confirmed"]);
    expect(events[1].source).toBe("provider");
  });

  test("a failed provider outcome never counts as money", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    await initiateProviderPayment(
      {
        provider: "sentoo",
        providerRef: "checkout-xyz",
        registrationId: registration.id,
        amountCents: 2000,
      },
      db,
    );
    const res = await reconcileProviderOutcome(
      { provider: "sentoo", providerRef: "checkout-xyz", outcome: "failed" },
      db,
    );
    expect(res).toMatchObject({ ok: true, applied: "transitioned" });
    if (res.ok) {
      expect(res.balance?.settledCents).toBe(0);
      expect(res.balance?.paymentState).toBe("unpaid");
    }
  });

  test("reconcile on an unknown reference is not-found; staff cannot fake provider rows", async () => {
    expect(
      await reconcileProviderOutcome(
        { provider: "sentoo", providerRef: "nope", outcome: "confirmed" },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });

    const { registration } = await seedRegistered({ due: 2000 });
    // The provider-consistency CHECK: an 'online' row without a
    // provider identity can never exist — no path to fake truth.
    await expect(
      db.insert(schema.payments).values({
        registrationId: registration.id,
        amountCents: 2000,
        currency: "USD",
        kind: "payment",
        status: "confirmed",
        method: "online",
        source: "provider",
      }),
    ).rejects.toThrow();
  });
});

// --- Aggregate + queue projections ---------------------------------------------------

describe("projection + queues — one canonical formula", () => {
  test("moneyByRegistration splits confirmed/pending per registration", async () => {
    const a = await seedRegistered({ due: 2000 });
    const b = await seedRegistered({ due: 2000 });
    const p = await recordManualPayment(
      a.registration.id,
      { amountCents: 1500, method: "cash" },
      STAFF,
      db,
    );
    if (!p.ok) throw new Error("setup");
    await recordManualPayment(
      a.registration.id,
      { amountCents: 500, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    const map = await moneyByRegistration(db, [
      a.registration.id,
      b.registration.id,
    ]);
    expect(map.get(a.registration.id)).toMatchObject({
      receivedCents: 1500,
      pendingCents: 500,
    });
    expect(map.has(b.registration.id)).toBe(false);
  });

  test("queues: partial stays outstanding; refund returns a paid row to outstanding", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const pay = await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");
    let q = await getRegistrationQueues({ year: YEAR }, db);
    expect(q.completed.map((i) => i.registrationId)).toContain(
      registration.id,
    );
    expect(q.outstanding).toHaveLength(0);

    // Money went back — the debt is real again.
    await refundPayment(
      pay.paymentId,
      { amountCents: 1000, reason: "Duplicate payment" },
      STAFF,
      db,
    );
    q = await getRegistrationQueues({ year: YEAR }, db);
    const item = q.outstanding.find(
      (i) => i.registrationId === registration.id,
    );
    expect(item).toMatchObject({
      paymentState: "partial",
      outstandingCents: 1000,
      paidCents: 1000,
    });
  });

  test("a pending transaction never moves a registration off the outstanding queue", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    const q = await getRegistrationQueues({ year: YEAR }, db);
    expect(q.outstanding.map((i) => i.registrationId)).toEqual([
      registration.id,
    ]);
    expect(q.outstanding[0].outstandingCents).toBe(2000);
  });
});

// --- Unpaid-balance reminder eligibility (#172 activation) ------------------------------

describe("listUnpaidRegistrations + payment reminder — ledger truth only", () => {
  test("unpaid appears; paid/waived/no-fee/pending-only never do", async () => {
    const unpaid = await seedRegistered({ due: 2000 });
    const paid = await seedRegistered({ due: 2000 });
    const waived = await seedRegistered({ due: 2000 });
    const free = await seedRegistered({ due: 0 });
    const pendingOnly = await seedRegistered({ due: 2000 });
    await recordManualPayment(
      paid.registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    await resolveRegistrationFee(
      waived.registration.id,
      { resolution: "waived" },
      STAFF,
      db,
    );
    await recordManualPayment(
      pendingOnly.registration.id,
      { amountCents: 2000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );

    const rows = await listUnpaidRegistrations({ year: YEAR }, db);
    const ids = rows.map((r) => r.registrationId);
    expect(ids).toContain(unpaid.registration.id);
    expect(ids).toContain(pendingOnly.registration.id); // still owed!
    expect(ids).not.toContain(paid.registration.id);
    expect(ids).not.toContain(waived.registration.id);
    expect(ids).not.toContain(free.registration.id);
    expect(
      rows.find((r) => r.registrationId === unpaid.registration.id)
        ?.outstandingCents,
    ).toBe(2000);
  });

  test("the grace window excludes freshly recorded registrations", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    // registeredAt is now() — a registeredBefore cutoff in the past
    // excludes it; no cutoff includes it.
    const tooNew = await listUnpaidRegistrations(
      { year: YEAR, registeredBefore: "2020-01-01" },
      db,
    );
    expect(
      tooNew.some((r) => r.registrationId === registration.id),
    ).toBe(false);
    const all = await listUnpaidRegistrations({ year: YEAR }, db);
    expect(all.some((r) => r.registrationId === registration.id)).toBe(true);
  });

  test("evaluator queues the reminder and stops once settled", async () => {
    const { registration } = await seedRegistered({ due: 2000 });
    const ctx = { asOf: "2026-12-01", siteUrl: "https://example.test" };
    const items = await evaluateRegistrationPaymentReminders(ctx, db);
    const mine = items.find((i) => i.relatedId === registration.id);
    expect(mine?.decision.type).toBe("send");
    if (mine?.decision.type === "send") {
      expect(mine.decision.recipient).toBe("jane@example.com");
      expect(mine.decision.bodyText).toContain("20.00 USD");
    }

    // Settle the balance — eligibility disappears entirely.
    await recordManualPayment(
      registration.id,
      { amountCents: 2000, method: "cash" },
      STAFF,
      db,
    );
    const after = await evaluateRegistrationPaymentReminders(ctx, db);
    expect(
      after.find((i) => i.relatedId === registration.id),
    ).toBeUndefined();
  });
});

// --- RegistrationRecord DTO shape ------------------------------------------------------

describe("registration DTO — balance fields are derived, never stored", () => {
  test("paidCents/outstandingCents/pendingCents come from the projection", async () => {
    const { registration } = await seedRegistered({ due: 2500 });
    const r = await recordRegistrationPayment(
      registration.id,
      { amountCents: 1000, method: "cash" },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration).toMatchObject({
      paidCents: 1000,
      outstandingCents: 1500,
      pendingCents: 0,
      paymentState: "partial",
    });
    await recordManualPayment(
      registration.id,
      { amountCents: 1500, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    const balance = await registrationBalance(
      {
        id: registration.id,
        amountDueCents: registration.amountDueCents,
        resolution: null,
      },
      db,
    );
    expect(balance.pendingCents).toBe(1500);
  });
});
