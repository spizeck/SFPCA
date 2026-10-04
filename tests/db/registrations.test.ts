// Authoritative annual registration tests (#169), run against PGlite so
// real Postgres semantics apply: unique(animal_id, year), CHECK
// constraints, transactions, and CASCADE truncates.
//
// The properties under test are the issue's invariants:
//   - one registration per animal per year — a new year never
//     overwrites the permanent animal or last year's record;
//   - the registration-time owner/amount snapshot survives later
//     ownership changes;
//   - payment state is DERIVED from the payments ledger, never stored;
//   - waiver/complimentary/cancellation are explicit audited
//     resolutions — no fake $0 payments;
//   - lifecycle gates the exception queue without touching history;
//   - every mutation leaves an audit_events row.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  cancelRegistration,
  correctRegistrationAmount,
  createPortalRegistrationRequest,
  createRegistration,
  createRegistrationSubmission,
  getRegistrationQueues,
  getSubmissionLinkTarget,
  listRegistrationsForAnimal,
  listUnregisteredAnimals,
  recordRegistrationPayment,
  resolveRegistrationFee,
  updateSubmissionStatus,
} from "@/lib/registry/registrations";
import { confirmedPaidByRegistration } from "@/lib/registry/payments";
import { createOwnership } from "@/lib/registry/ownership";
import {
  REGISTRATION_FEE_FIXED,
  REGISTRATION_FEE_NOT_FIXED,
} from "@/lib/animal-registration";
import { derivePaymentState } from "@/lib/registrations";

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
    sql`TRUNCATE payments, registration_submissions, registrations, ownerships, household_members, households, persons, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";
const YEAR = 2026;

async function seedAnimal(
  opts: { name?: string; lifecycleStatus?: string; sterilization?: string } = {},
) {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: opts.name ?? "Rex",
      species: "dog",
      sex: "female",
      lifecycleStatus: opts.lifecycleStatus ?? "active",
      sterilizationStatus: opts.sterilization ?? "intact",
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

async function seedOwnedAnimal(opts: Parameters<typeof seedAnimal>[0] = {}) {
  const animal = await seedAnimal(opts);
  const person = await seedPerson();
  const own = await createOwnership(
    { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
    STAFF,
    db,
  );
  if (!own.ok) throw new Error("setup");
  return { animal, person, ownership: own.ownership };
}

async function auditActions(entityType: string) {
  const rows = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityType, entityType));
  return rows.map((r) => r.action);
}

async function paidCentsFor(registrationId: string) {
  const map = await confirmedPaidByRegistration(db, [registrationId]);
  return map.get(registrationId) ?? 0;
}

describe("createRegistration — assessment + snapshot", () => {
  test("fee is assessed from sterilization status and frozen on the row", async () => {
    const intact = await seedOwnedAnimal({ sterilization: "intact" });
    const fixed = await seedOwnedAnimal({ sterilization: "sterilized" });

    const r1 = await createRegistration(
      { animalId: intact.animal.id, year: YEAR },
      STAFF,
      db,
    );
    const r2 = await createRegistration(
      { animalId: fixed.animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r1.ok || !r2.ok) throw new Error("setup");

    expect(r1.registration.amountDueCents).toBe(REGISTRATION_FEE_NOT_FIXED * 100);
    expect(r2.registration.amountDueCents).toBe(REGISTRATION_FEE_FIXED * 100);
    expect(r1.registration.currency).toBe("USD");
    expect(r1.registration.status).toBe("active");
    expect(r1.registration.paymentState).toBe("unpaid");
    expect(r1.registration.registeredAt).not.toBeNull();
    expect(await auditActions("registration")).toContain("create");
  });

  test("an explicit amountDue override wins over the assessed fee", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR, amountDueCents: 0 },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration.amountDueCents).toBe(0);
    expect(r.registration.paymentState).toBe("no-fee");
  });

  test("owner snapshot survives a later ownership transfer", async () => {
    const { animal, person, ownership } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration.personId).toBe(person.id);
    expect(r.registration.ownershipId).toBe(ownership.id);
    expect(r.registration.ownerLabel).toBe("Jane Owner");

    // Ownership transfers — the registration still names Jane Owner.
    const next = await seedPerson("New Owner");
    await db
      .update(schema.ownerships)
      .set({ validTo: "2026-06-01" })
      .where(eq(schema.ownerships.id, ownership.id));
    const own2 = await createOwnership(
      { animalId: animal.id, personId: next.id, validFrom: "2026-06-01" },
      STAFF,
      db,
    );
    if (!own2.ok) throw new Error("setup");

    const history = await listRegistrationsForAnimal(animal.id, db);
    expect(history[0].ownerLabel).toBe("Jane Owner");
    expect(history[0].personId).toBe(person.id);
  });

  test("household ownership snapshots the household name", async () => {
    const animal = await seedAnimal();
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Fort Bay Family" })
      .returning();
    const own = await createOwnership(
      {
        animalId: animal.id,
        householdId: household.id,
        validFrom: "2025-01-01",
      },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");

    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration.householdId).toBe(household.id);
    expect(r.registration.ownerLabel).toBe("Fort Bay Family");
  });

  test("an unowned animal registers with a null snapshot — never a guess", async () => {
    const animal = await seedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration.ownerLabel).toBeNull();
    expect(r.registration.personId).toBeNull();
    expect(r.registration.householdId).toBeNull();
  });

  test("one registration per animal per year — a second create conflicts", async () => {
    const { animal } = await seedOwnedAnimal();
    const first = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    const dup = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    expect(first.ok).toBe(true);
    expect(dup).toMatchObject({ ok: false, reason: "conflict" });

    // A different year is a NEW obligation — the permanent animal and
    // last year's row are untouched.
    const next = await createRegistration(
      { animalId: animal.id, year: YEAR + 1 },
      STAFF,
      db,
    );
    expect(next.ok).toBe(true);
    const all = await listRegistrationsForAnimal(animal.id, db);
    expect(all.map((r) => r.year).sort()).toEqual([YEAR, YEAR + 1]);
  });

  test("submission linkage stamps submitted_at from the intake row", async () => {
    const sub = await createRegistrationSubmission(
      {
        submissionId: "11111111-2222-3333-4444-555555555555",
        receiptRequested: false,
        ownerName: "Submitter",
        ownerAddress: "The Bottom",
        ownerPhone: "+5994161234",
        ownerEmail: "sub@example.com",
        animals: [
          { name: "SubDog", type: "dog", sex: "male", isFixed: "yes" },
        ],
      },
      db,
    );
    if (!sub.ok) throw new Error("setup");

    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR, submissionId: sub.submissionId },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    expect(r.registration.submissionId).toBe(sub.submissionId);
    expect(r.registration.submittedAt).not.toBeNull();
  });

  test("unknown animal / bad year / negative amount are rejected", async () => {
    const { animal } = await seedOwnedAnimal();
    expect(
      await createRegistration(
        { animalId: "11111111-2222-3333-4444-555555555555", year: YEAR },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
    expect(
      await createRegistration(
        { animalId: animal.id, year: 1999 },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await createRegistration(
        { animalId: animal.id, year: YEAR, amountDueCents: -5 },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("payment derivation — the ledger decides, never a flag", () => {
  test("unpaid → partial → paid as confirmed payments land", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    const due = r.registration.amountDueCents;
    expect(await paidCentsFor(r.registration.id)).toBe(0);

    const half = await recordRegistrationPayment(
      r.registration.id,
      { amountCents: due / 2, method: "cash" },
      STAFF,
      db,
    );
    if (!half.ok) throw new Error("setup");
    expect(half.registration.paymentState).toBe("partial");

    const rest = await recordRegistrationPayment(
      r.registration.id,
      { amountCents: due / 2, method: "bank-transfer" },
      STAFF,
      db,
    );
    if (!rest.ok) throw new Error("setup");
    expect(rest.registration.paymentState).toBe("paid");
    expect(rest.registration.paidCents).toBe(due);

    // The stored status is still 'active' — paid is derived.
    const history = await listRegistrationsForAnimal(animal.id, db);
    expect(history[0].status).toBe("active");
    expect(history[0].paymentState).toBe("paid");
    // #170: money mutations audit under the 'payment' entity — the
    // ledger owns its own privileged-action trail.
    expect(await auditActions("payment")).toContain("record-payment");
  });

  test("refunds subtract; void rows never count", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    const due = r.registration.amountDueCents;
    await recordRegistrationPayment(
      r.registration.id,
      { amountCents: due, method: "cash" },
      STAFF,
      db,
    );
    // A refund and a voided payment — ledger history, written directly
    // because manual refund entry is a #170 workflow, not #169's.
    await db.insert(schema.payments).values([
      {
        registrationId: r.registration.id,
        amountCents: 2000,
        currency: "USD",
        kind: "refund",
        status: "confirmed",
      },
      {
        registrationId: r.registration.id,
        amountCents: 5000,
        currency: "USD",
        kind: "payment",
        status: "void",
      },
    ]);
    const paid = await paidCentsFor(r.registration.id);
    expect(paid).toBe(due - 2000);
    expect(derivePaymentState(due, paid, null)).toBe("partial");
  });

  test("a cancelled registration refuses new payments", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    await cancelRegistration(
      r.registration.id,
      { reason: "withdrawn" },
      STAFF,
      db,
    );
    const pay = await recordRegistrationPayment(
      r.registration.id,
      { amountCents: 100, method: "cash" },
      STAFF,
      db,
    );
    expect(pay).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("registration status never encodes payment — no 'paid' status exists", async () => {
    // The CHECK constraint is the enforcement: 'paid'/'unpaid' are not
    // registration statuses, so no code path can fake payment truth.
    const { animal } = await seedOwnedAnimal();
    await expect(
      db.insert(schema.registrations).values({
        animalId: animal.id,
        year: YEAR,
        status: "paid",
      }),
    ).rejects.toThrow();
  });
});

describe("resolutions — waiver / complimentary / cancellation / correction", () => {
  test("waive resolves the obligation without a payment row", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");

    const w = await resolveRegistrationFee(
      r.registration.id,
      { resolution: "waived" },
      STAFF,
      db,
    );
    if (!w.ok) throw new Error("setup");
    expect(w.registration.resolution).toBe("waived");
    expect(w.registration.paymentState).toBe("waived");
    expect(w.registration.resolvedBy).toBe(STAFF);

    // No fake $0 payment was inserted.
    const payments = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.registrationId, r.registration.id));
    expect(payments).toHaveLength(0);
    expect(await auditActions("registration")).toContain("resolve-fee");
  });

  test("waiving after payment is allowed — the resolution wins, ledger intact", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR, amountDueCents: 1000 },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    await recordRegistrationPayment(
      r.registration.id,
      { amountCents: 1000, method: "cash" },
      STAFF,
      db,
    );
    const w = await resolveRegistrationFee(
      r.registration.id,
      { resolution: "waived" },
      STAFF,
      db,
    );
    if (!w.ok) throw new Error("setup");
    // The money still shows — waiver doesn't erase the ledger.
    expect(w.registration.paymentState).toBe("waived");
    expect(w.registration.paidCents).toBe(1000);
  });

  test("cancel preserves the row; the animal returns to the unregistered set", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");

    // A correction MUST say what was wrong.
    const silent = await cancelRegistration(
      r.registration.id,
      { reason: "correction" },
      STAFF,
      db,
    );
    expect(silent).toMatchObject({ ok: false, reason: "invalid" });

    const c = await cancelRegistration(
      r.registration.id,
      { reason: "correction", note: "Wrong animal selected" },
      STAFF,
      db,
    );
    if (!c.ok) throw new Error("setup");
    expect(c.registration.status).toBe("cancelled");
    expect(c.registration.cancellationReason).toBe("correction");

    // History stays readable; the animal is due again.
    const history = await listRegistrationsForAnimal(animal.id, db);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("cancelled");
    const unregistered = await listUnregisteredAnimals({ year: YEAR }, db);
    expect(unregistered.some((a) => a.animalId === animal.id)).toBe(true);

    // The (animal, year) slot stays taken — re-creating conflicts;
    // staff must correct the cancelled row, not bury it.
    const re = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    expect(re).toMatchObject({ ok: false, reason: "conflict" });
    expect(await auditActions("registration")).toContain("cancel");
  });

  test("double-cancel conflicts", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    await cancelRegistration(
      r.registration.id,
      { reason: "withdrawn" },
      STAFF,
      db,
    );
    const again = await cancelRegistration(
      r.registration.id,
      { reason: "withdrawn" },
      STAFF,
      db,
    );
    expect(again).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("amount correction audits before/after — no silent edits", async () => {
    const { animal } = await seedOwnedAnimal();
    const r = await createRegistration(
      { animalId: animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");

    const c = await correctRegistrationAmount(
      r.registration.id,
      REGISTRATION_FEE_FIXED * 100,
      "Dog was already sterilized",
      STAFF,
      db,
    );
    if (!c.ok) throw new Error("setup");
    expect(c.registration.amountDueCents).toBe(REGISTRATION_FEE_FIXED * 100);

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, "registration"));
    const correct = audits.find((a) => a.action === "correct-amount");
    expect(correct?.before).toMatchObject({
      amountDueCents: REGISTRATION_FEE_NOT_FIXED * 100,
    });
    expect(correct?.after).toMatchObject({
      amountDueCents: REGISTRATION_FEE_FIXED * 100,
    });
  });
});

describe("current-period eligibility + staff queues", () => {
  test("active unregistered animals surface; registered + inactive do not", async () => {
    const due = await seedOwnedAnimal({ name: "NeedsReg" });
    const done = await seedOwnedAnimal({ name: "DoneReg" });
    await seedOwnedAnimal({ name: "Dead", lifecycleStatus: "deceased" });
    await seedOwnedAnimal({
      name: "Moved",
      lifecycleStatus: "moved-off-saba",
    });
    await createRegistration(
      { animalId: done.animal.id, year: YEAR },
      STAFF,
      db,
    );

    const rows = await listUnregisteredAnimals({ year: YEAR }, db);
    const names = rows.map((r) => r.name);
    expect(names).toContain("NeedsReg");
    expect(names).not.toContain("DoneReg");
    expect(names).not.toContain("Dead");
    expect(names).not.toContain("Moved");
    expect(rows.find((r) => r.animalId === due.animal.id)?.ownerLabel).toBe(
      "Jane Owner",
    );
  });

  test("queues fill the four buckets without conflation", async () => {
    const gap = await seedOwnedAnimal({ name: "Gap" });
    const owes = await seedOwnedAnimal({ name: "Owes" });
    const paidUp = await seedOwnedAnimal({ name: "Paid" });
    const free = await seedOwnedAnimal({ name: "Free" });
    const dead = await seedAnimal({
      name: "Gone",
      lifecycleStatus: "deceased",
    });

    const regOwes = await createRegistration(
      { animalId: owes.animal.id, year: YEAR },
      STAFF,
      db,
    );
    const regPaid = await createRegistration(
      { animalId: paidUp.animal.id, year: YEAR },
      STAFF,
      db,
    );
    const regFree = await createRegistration(
      { animalId: free.animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!regOwes.ok || !regPaid.ok || !regFree.ok) throw new Error("setup");
    await recordRegistrationPayment(
      regPaid.registration.id,
      { amountCents: regPaid.registration.amountDueCents, method: "cash" },
      STAFF,
      db,
    );
    await resolveRegistrationFee(
      regFree.registration.id,
      { resolution: "waived" },
      STAFF,
      db,
    );
    // A deceased animal's PRIOR-year registration is history, not a gap.
    await createRegistration({ animalId: dead.id, year: YEAR - 1 }, STAFF, db);
    // One pending submission sits in intake.
    await createRegistrationSubmission(
      {
        submissionId: "99999999-8888-7777-6666-555555555555",
        receiptRequested: false,
        ownerName: "Intake",
        ownerAddress: "Windwardside",
        ownerPhone: "+5994161234",
        ownerEmail: "intake@example.com",
        animals: [{ name: "NewDog", type: "dog", sex: "male", isFixed: "no" }],
      },
      db,
    );

    const q = await getRegistrationQueues({ year: YEAR }, db);
    expect(q.year).toBe(YEAR);
    expect(q.unregistered.map((a) => a.animalId)).toEqual([gap.animal.id]);
    expect(q.pendingSubmissions).toBe(1);
    expect(q.outstanding.map((i) => i.registrationId)).toEqual([
      regOwes.registration.id,
    ]);
    expect(q.outstanding[0].paymentState).toBe("unpaid");
    expect(q.completed.map((i) => i.registrationId).sort()).toEqual(
      [regPaid.registration.id, regFree.registration.id].sort(),
    );
    expect(q.completed.map((i) => i.paymentState).sort()).toEqual([
      "paid",
      "waived",
    ]);
  });

  test("year filtering keeps prior-period history out of current queues", async () => {
    const { animal } = await seedOwnedAnimal();
    await createRegistration({ animalId: animal.id, year: 2025 }, STAFF, db);
    const q = await getRegistrationQueues({ year: YEAR }, db);
    // Registered for 2025, not 2026 → the animal is a current gap.
    expect(q.unregistered.map((a) => a.animalId)).toEqual([animal.id]);
    expect(q.outstanding).toHaveLength(0);
    expect(q.completed).toHaveLength(0);
  });
});

describe("payments seam — set-based, never N+1", () => {
  test("confirmedPaidByRegistration aggregates a whole set in one pass", async () => {
    const a = await seedOwnedAnimal({ name: "A" });
    const b = await seedOwnedAnimal({ name: "B" });
    const ra = await createRegistration(
      { animalId: a.animal.id, year: YEAR },
      STAFF,
      db,
    );
    const rb = await createRegistration(
      { animalId: b.animal.id, year: YEAR, amountDueCents: 0 },
      STAFF,
      db,
    );
    if (!ra.ok || !rb.ok) throw new Error("setup");
    await recordRegistrationPayment(
      ra.registration.id,
      { amountCents: 500, method: "cash" },
      STAFF,
      db,
    );

    const map = await confirmedPaidByRegistration(db, [
      ra.registration.id,
      rb.registration.id,
      "11111111-2222-3333-4444-555555555555", // absent → not in map
    ]);
    expect(map.get(ra.registration.id)).toBe(500);
    // No confirmed rows → absent from the map (callers treat as 0).
    expect(map.has(rb.registration.id)).toBe(false);
    expect(map.size).toBe(1);
  });
});

// Portal-originated registration requests (#297): an authenticated
// owner asks staff to register THEIR animal for the current period.
// Same table + staff queue as public intake, but every canonical link
// is resolved server-side from the authorized ownership — a client id
// is never proof of anything.
describe("portal registration requests (#297)", () => {
  let subSeq = 0;
  const nextSubmissionId = () =>
    `00000000-0000-4000-8000-${String(++subSeq).padStart(12, "0")}`;

  async function seedIdentity(personId: string) {
    const [identity] = await db
      .insert(schema.authIdentities)
      .values({
        provider: "password",
        providerUid: `uid-${personId}`,
        email: "owner@example.com",
        personId,
      })
      .returning();
    return identity;
  }

  async function seedOwner(opts: Parameters<typeof seedAnimal>[0] = {}) {
    const owned = await seedOwnedAnimal(opts);
    const identity = await seedIdentity(owned.person.id);
    return { ...owned, identity };
  }

  function requestInput(
    owned: Awaited<ReturnType<typeof seedOwner>>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ownershipId: owned.ownership.id,
      personId: owned.person.id,
      authIdentityId: owned.identity.id,
      submissionId: nextSubmissionId(),
      year: YEAR,
      ...extra,
    };
  }

  async function submissionById(id: string) {
    const [row] = await db
      .select()
      .from(schema.registrationSubmissions)
      .where(eq(schema.registrationSubmissions.id, id));
    return row;
  }

  test("a linked owner's request lands with portal provenance and canonical links", async () => {
    const owned = await seedOwner({ name: "Captain", sterilization: "sterilized" });
    const r = await createPortalRegistrationRequest(
      requestInput(owned, { ownerNote: "Neutered in March" }),
      "owner@example.com",
      db,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = await submissionById(r.submissionId);
    expect(row.source).toBe("portal");
    expect(row.animalId).toBe(owned.animal.id);
    expect(row.ownershipId).toBe(owned.ownership.id);
    expect(row.personId).toBe(owned.person.id);
    expect(row.authIdentityId).toBe(owned.identity.id);
    expect(row.requestedYear).toBe(YEAR);
    expect(row.ownerNote).toBe("Neutered in March");
    expect(row.status).toBe("pending");
    // Canonical snapshots — same shape the public intake produces.
    expect(row.ownerName).toBe("Jane Owner");
    expect(row.animals).toEqual([
      { name: "Captain", type: "dog", sex: "female", isFixed: "yes" },
    ]);
    expect(row.totalFeeCents).toBe(REGISTRATION_FEE_FIXED * 100);
    expect(await auditActions("registration_submission")).toContain(
      "create",
    );
  });

  test("a household member can request for a household-owned animal", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    const identity = await seedIdentity(person.id);
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Bay Family" })
      .returning();
    await db.insert(schema.householdMembers).values({
      householdId: household.id,
      personId: person.id,
    });
    const own = await createOwnership(
      { animalId: animal.id, householdId: household.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");

    const r = await createPortalRegistrationRequest(
      {
        ownershipId: own.ownership.id,
        personId: person.id,
        authIdentityId: identity.id,
        submissionId: nextSubmissionId(),
        year: YEAR,
      },
      "owner@example.com",
      db,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await submissionById(r.submissionId);
    expect(row.animalId).toBe(animal.id);
    expect(row.personId).toBe(person.id);
  });

  test("a different owner cannot request for someone else's animal (IDOR)", async () => {
    const owned = await seedOwner();
    const stranger = await seedPerson("Stranger");
    const strangerId = await seedIdentity(stranger.id);

    const r = await createPortalRegistrationRequest(
      {
        ownershipId: owned.ownership.id,
        personId: stranger.id,
        authIdentityId: strangerId.id,
        submissionId: nextSubmissionId(),
        year: YEAR,
      },
      "stranger@example.com",
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "not-owner" });
  });

  test("a fabricated ownership id is rejected", async () => {
    const owned = await seedOwner();
    const r = await createPortalRegistrationRequest(
      requestInput(owned, {
        ownershipId: "11111111-2222-3333-4444-555555555555",
      }),
      "owner@example.com",
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "not-owner" });
  });

  test("an active current-year registration blocks the request", async () => {
    const owned = await seedOwner();
    const reg = await createRegistration(
      { animalId: owned.animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("setup");
    const r = await createPortalRegistrationRequest(
      requestInput(owned),
      "owner@example.com",
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("a cancelled current-year row still blocks the request — the slot is held", async () => {
    const owned = await seedOwner();
    const reg = await createRegistration(
      { animalId: owned.animal.id, year: YEAR },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("setup");
    await cancelRegistration(
      reg.registration.id,
      { reason: "correction", note: "Wrong year recorded" },
      STAFF,
      db,
    );
    const r = await createPortalRegistrationRequest(
      requestInput(owned),
      "owner@example.com",
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("an ineligible animal lifecycle is rejected", async () => {
    const owned = await seedOwner({ lifecycleStatus: "deceased" });
    const r = await createPortalRegistrationRequest(
      requestInput(owned),
      "owner@example.com",
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "not-eligible" });
  });

  test("a pending request blocks a second — and a simultaneous pair yields exactly one", async () => {
    const owned = await seedOwner();
    const first = await createPortalRegistrationRequest(
      requestInput(owned),
      "owner@example.com",
      db,
    );
    expect(first.ok).toBe(true);
    const second = await createPortalRegistrationRequest(
      requestInput(owned),
      "owner@example.com",
      db,
    );
    expect(second).toMatchObject({ ok: false, reason: "conflict" });

    // Concurrent submits for a different animal serialize on the
    // partial unique index — exactly one wins.
    const owned2 = await seedOwner({ name: "Twin" });
    const [a, b] = await Promise.all([
      createPortalRegistrationRequest(requestInput(owned2), "o@e.com", db),
      createPortalRegistrationRequest(requestInput(owned2), "o@e.com", db),
    ]);
    const results = [a, b].map((r) => (r.ok ? "ok" : r.reason));
    expect(results.sort()).toEqual(["conflict", "ok"]);
    const pending = await db
      .select()
      .from(schema.registrationSubmissions)
      .where(eq(schema.registrationSubmissions.animalId, owned2.animal.id));
    expect(pending).toHaveLength(1);
  });

  test("retrying with the same submission id is idempotent", async () => {
    const owned = await seedOwner();
    const input = requestInput(owned);
    const first = await createPortalRegistrationRequest(input, "o@e.com", db);
    const retry = await createPortalRegistrationRequest(input, "o@e.com", db);
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.submissionId).toBe(first.submissionId);
    }
  });

  test("a rejected request does not pin the slot — a fresh request is a new row", async () => {
    const owned = await seedOwner();
    const first = await createPortalRegistrationRequest(
      requestInput(owned),
      "o@e.com",
      db,
    );
    if (!first.ok) throw new Error("setup");
    const rej = await updateSubmissionStatus(
      first.submissionId,
      "rejected",
      STAFF,
      db,
    );
    if (!rej.ok) throw new Error("setup");

    // Staff declined is not 'pending' — the unique index only guards
    // in-flight work, so a deliberate re-request lands as a new row
    // for staff to review on its own merits.
    const again = await createPortalRegistrationRequest(
      requestInput(owned),
      "o@e.com",
      db,
    );
    expect(again.ok).toBe(true);
  });

  test("staff registration from a portal request keeps the submission link + requested year", async () => {
    const owned = await seedOwner();
    const req = await createPortalRegistrationRequest(
      requestInput(owned),
      "o@e.com",
      db,
    );
    if (!req.ok) throw new Error("setup");

    const target = await getSubmissionLinkTarget(req.submissionId, db);
    expect(target).toMatchObject({
      source: "portal",
      animalId: owned.animal.id,
      requestedYear: YEAR,
    });

    const reg = await createRegistration(
      {
        animalId: target!.animalId!,
        submissionId: req.submissionId,
        year: target!.requestedYear!,
      },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("setup");
    expect(reg.registration.submissionId).toBe(req.submissionId);
    expect(reg.registration.year).toBe(YEAR);
  });

  test("public submissions are untouched — no animal link, no dedup index participation", async () => {
    const pub = await createRegistrationSubmission(
      {
        submissionId: "99999999-8888-7777-6666-555555555555",
        receiptRequested: false,
        ownerName: "Public",
        ownerAddress: "Windwardside",
        ownerPhone: "+5994161234",
        ownerEmail: "pub@example.com",
        animals: [{ name: "Stray", type: "dog", sex: "male", isFixed: "no" }],
      },
      db,
    );
    expect(pub.ok).toBe(true);
    if (!pub.ok) throw new Error("public submission failed");
    const row = await submissionById(pub.submissionId);
    expect(row.source).toBe("public");
    expect(row.animalId).toBeNull();
    expect(row.requestedYear).toBeNull();
  });
});
