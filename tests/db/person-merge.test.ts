// Person merge tests (#211), run against PGlite so real Postgres
// semantics apply: row locks, unique constraints, restrictive FKs.
//
// The release-blocking invariants under test:
//   - two authenticated identities are NEVER silently fused — dual-auth
//     and wrong-direction merges block before any mutation;
//   - a retired person never holds a login, is excluded from pickers,
//     and resolves to the canonical survivor via person_merges;
//   - ownership/confirmation/registration/payment/communication
//     history reparents — nothing is deleted, ledger projections are
//     identical, snapshot columns keep their original truth;
//   - preview is authoritative: execute re-analyzes under locks and a
//     stale fingerprint refuses to blind-apply.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  executePersonMerge,
  getPersonMergeInfo,
  previewPersonMerge,
  resolvePersonMergeTarget,
} from "@/lib/registry/person-merge";
import {
  linkIdentityToPerson,
  listPersons,
  searchPersons,
  updatePerson,
} from "@/lib/registry/persons";
import {
  createOwnership,
  recordOwnershipConfirmation,
} from "@/lib/registry/ownership";
import {
  createRegistration,
  recordRegistrationPayment,
} from "@/lib/registry/registrations";
import { createAnimal } from "@/lib/registry/animals";
import { todayIsoDate } from "@/lib/vaccinations";

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
    sql`TRUNCATE person_merges, household_merges, animal_merges, data_quality_reviews, payments, registrations, registration_submissions, microchip_conflicts, microchip_records, lost_found_cases, vaccinations, vet_encounters, vet_procedures, vet_medications, medical_alerts, weight_records, vet_documents, follow_ups, clinic_expectations, communications, communication_preferences, owner_requests, ownership_confirmations, ownerships, animal_lifecycle_events, household_members, households, admin_users, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

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

async function seedIdentity(personId: string, uid?: string) {
  const [identity] = await db
    .insert(schema.authIdentities)
    .values({
      provider: "firebase",
      providerUid: uid ?? `uid-${Math.random().toString(36).slice(2)}`,
      personId,
    })
    .returning();
  return identity;
}

async function seedAnimal(name = "Bella") {
  const res = await createAnimal(
    { name, species: "dog", sex: "female", adoptionStatus: "not-listed" },
    STAFF,
    db,
  );
  if (!res.ok) throw new Error("createAnimal failed");
  return res.animal;
}

async function pair() {
  const survivor = await seedPerson("Jane Owner", { email: "jane@example.com" });
  const retired = await seedPerson("Jane Owner", { email: "jane@example.com" });
  return { survivor, retired };
}

async function merge(
  survivorId: string,
  retiredId: string,
  extra: Partial<Parameters<typeof executePersonMerge>[0]> = {},
) {
  const preview = await previewPersonMerge(survivorId, retiredId, db);
  if (!preview.ok) throw new Error(`preview failed: ${preview.message}`);
  const fieldChoices = Object.fromEntries(
    preview.preview.fieldConflicts.map((c) => [c.field, "survivor" as const]),
  );
  return executePersonMerge(
    {
      survivorId,
      retiredId,
      fieldChoices,
      fingerprint: preview.preview.fingerprint,
      actorLabel: STAFF,
      ...extra,
    },
    db,
  );
}

describe("person merge preview", () => {
  test("rejects self-merge before any work", async () => {
    const p = await seedPerson();
    const r = await previewPersonMerge(p.id, p.id, db);
    expect(r.ok).toBe(false);
  });

  test("shows field conflicts when contact details disagree", async () => {
    const survivor = await seedPerson("Jane Owner", {
      email: "jane@example.com",
      phone: "555-0100",
    });
    const retired = await seedPerson("Jane Owner", {
      email: "jane@example.com",
      phone: "555-9999",
      address: "Windwardside",
    });
    const r = await previewPersonMerge(survivor.id, retired.id, db);
    if (!r.ok) throw new Error("preview failed");
    expect(r.preview.fieldConflicts.map((c) => c.field)).toEqual(["phone"]);
    expect(r.preview.autoNotes.join(" ")).toMatch(/address/i);
  });

  test("blocks a retired identity as input on either side", async () => {
    const { survivor, retired } = await pair();
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const again = await previewPersonMerge(retired.id, survivor.id, db);
    if (!again.ok) throw new Error("preview failed");
    expect(again.preview.blockers.map((b) => b.code)).toContain("already-merged");
  });
});

describe("authentication safety", () => {
  test("neither side authenticated merges cleanly", async () => {
    const { survivor, retired } = await pair();
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
  });

  test("survivor authenticated / retired not — allowed, identity untouched", async () => {
    const { survivor, retired } = await pair();
    const identity = await seedIdentity(survivor.id);
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    const [stillLinked] = await db
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.id, identity.id));
    expect(stillLinked.personId).toBe(survivor.id);
  });

  test("retired authenticated / survivor not — blocked, direction must keep the login", async () => {
    const { survivor, retired } = await pair();
    await seedIdentity(retired.id);
    const r = await previewPersonMerge(survivor.id, retired.id, db);
    if (!r.ok) throw new Error("preview failed");
    expect(r.preview.blockers.map((b) => b.code)).toContain("auth-direction");

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("blocked");
  });

  test("both authenticated — blocked, no records mutated", async () => {
    const { survivor, retired } = await pair();
    const i1 = await seedIdentity(survivor.id);
    const i2 = await seedIdentity(retired.id);

    const r = await previewPersonMerge(survivor.id, retired.id, db);
    if (!r.ok) throw new Error("preview failed");
    expect(r.preview.blockers.map((b) => b.code)).toContain("dual-auth");

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(false);

    // Neither identity moved; no merge lineage was written.
    const ids = await db.select().from(schema.authIdentities);
    expect(ids.find((i) => i.id === i1.id)?.personId).toBe(survivor.id);
    expect(ids.find((i) => i.id === i2.id)?.personId).toBe(retired.id);
    expect(await db.select().from(schema.personMerges)).toHaveLength(0);
  });

  test("identity linked after the preview makes the preview stale", async () => {
    const { survivor, retired } = await pair();
    const preview = await previewPersonMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    await seedIdentity(retired.id); // a login appeared after preview
    const result = await executePersonMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    // The new identity turns the direction into a hard blocker, and
    // either way the merge must not proceed on the stale plan.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["stale", "blocked"]).toContain(result.reason);
  });

  test("admin link reparents as bookkeeping — role and identity untouched", async () => {
    const { survivor, retired } = await pair();
    const [adminRow] = await db
      .insert(schema.adminUsers)
      .values({ email: "admin@sfpca.example", role: "admin", personId: retired.id })
      .returning();
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    const [after] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminRow.id));
    expect(after.personId).toBe(survivor.id);
    expect(after.role).toBe("admin");
    expect(after.authIdentityId).toBeNull();
  });
});

describe("history preservation", () => {
  test("ownership history reparents; duplicate open interval closes annotated", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    // Survivor already owns it open; retired holds an older closed
    // interval and a duplicate open one.
    const sOpen = await createOwnership(
      { animalId: animal.id, personId: survivor.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!sOpen.ok) throw new Error("ownership failed");
    await createOwnership(
      {
        animalId: animal.id,
        personId: retired.id,
        validFrom: "2023-01-01",
        validTo: "2024-01-01",
      },
      STAFF,
      db,
    );
    const dupOpen = await createOwnership(
      { animalId: animal.id, personId: retired.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );
    if (!dupOpen.ok) throw new Error("ownership failed");

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, animal.id));
    // The closed-historical interval reparents; the duplicate open
    // interval stays on the retired person, closed today.
    const open = rows.filter((r) => r.validTo === null);
    expect(open).toHaveLength(1);
    expect(open[0].personId).toBe(survivor.id);
    const dup = rows.find((r) => r.id === dupOpen.ownership.id);
    expect(dup?.personId).toBe(retired.id);
    expect(dup?.validTo).toBe(todayIsoDate());
    expect(dup?.note).toMatch(/merge/i);
    const historical = rows.filter(
      (r) => r.personId === survivor.id && r.validTo === "2024-01-01",
    );
    expect(historical).toHaveLength(1);
  });

  test("co-ownership with a genuinely different person stays intact", async () => {
    const { survivor, retired } = await pair();
    const other = await seedPerson("Other Owner");
    const animal = await seedAnimal();
    await createOwnership(
      { animalId: animal.id, personId: survivor.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: animal.id, personId: other.id, validFrom: "2025-02-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: animal.id, personId: retired.id, validFrom: "2025-03-01" },
      STAFF,
      db,
    );
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    const open = await db
      .select()
      .from(schema.ownerships)
      .where(
        and(eq(schema.ownerships.animalId, animal.id), isNull(schema.ownerships.validTo)),
      );
    const openOwners = new Set(open.map((o) => o.personId));
    expect(openOwners.has(survivor.id)).toBe(true);
    expect(openOwners.has(other.id)).toBe(true);
    expect(openOwners.has(retired.id)).toBe(false);
  });

  test("confirmation history reparents with its events intact", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    const own = await createOwnership(
      { animalId: animal.id, personId: retired.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("ownership failed");
    const conf = await recordOwnershipConfirmation(
      {
        ownershipId: own.ownership.id,
        personId: retired.id,
        method: "staff",
        actorLabel: STAFF,
        confirmedOn: "2025-08-01",
      },
      db,
    );
    expect(conf.ok).toBe(true);

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    const rows = await db.select().from(schema.ownershipConfirmations);
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(survivor.id);
    expect(rows[0].confirmedOn).toBe("2025-08-01"); // timestamp never manufactured
  });

  test("household memberships reparent and dedupe — primary survives", async () => {
    const { survivor, retired } = await pair();
    const [house] = await db
      .insert(schema.households)
      .values({ name: "Owner family" })
      .returning();
    await db.insert(schema.householdMembers).values([
      { householdId: house.id, personId: survivor.id, role: "member" },
      { householdId: house.id, personId: retired.id, role: "primary" },
    ]);
    const [other] = await db
      .insert(schema.households)
      .values({ name: "Other household" })
      .returning();
    await db
      .insert(schema.householdMembers)
      .values({ householdId: other.id, personId: retired.id, role: "member" });

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    const members = await db.select().from(schema.householdMembers);
    // Same-household pair dedupes to one row; primary survives.
    const inShared = members.filter((m) => m.householdId === house.id);
    expect(inShared).toHaveLength(1);
    expect(inShared[0].personId).toBe(survivor.id);
    expect(inShared[0].role).toBe("primary");
    const inOther = members.filter((m) => m.householdId === other.id);
    expect(inOther).toHaveLength(1);
    expect(inOther[0].personId).toBe(survivor.id);
  });

  test("registrations, payments and submissions reparent; snapshots and ledger unchanged", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    const [submission] = await db
      .insert(schema.registrationSubmissions)
      .values({ ownerName: "Jane Owner", personId: retired.id, totalFeeCents: 1500 })
      .returning();
    const reg = await createRegistration(
      { animalId: animal.id, year: 2025, amountDueCents: 1500 },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("registration failed");
    // Link the person + label snapshot as registration-time truth.
    await db
      .update(schema.registrations)
      .set({ personId: retired.id, ownerLabel: "Jane Owner (reg card)" })
      .where(eq(schema.registrations.id, reg.registration.id));
    const pay = await recordRegistrationPayment(
      reg.registration.id,
      { amountCents: 1500, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("payment failed");
    await db
      .update(schema.payments)
      .set({ personId: retired.id })
      .where(eq(schema.payments.id, pay.paymentId));

    const ledgerBefore = await db
      .select({ total: sql<number>`coalesce(sum(amount_cents),0)::int` })
      .from(schema.payments)
      .where(eq(schema.payments.status, "confirmed"));

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);

    const [regAfter] = await db
      .select()
      .from(schema.registrations)
      .where(eq(schema.registrations.id, reg.registration.id));
    expect(regAfter.personId).toBe(survivor.id);
    expect(regAfter.ownerLabel).toBe("Jane Owner (reg card)"); // snapshot untouched
    const [subAfter] = await db
      .select()
      .from(schema.registrationSubmissions)
      .where(eq(schema.registrationSubmissions.id, submission.id));
    expect(subAfter.personId).toBe(survivor.id);
    const [payAfter] = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, pay.paymentId));
    expect(payAfter.personId).toBe(survivor.id);
    const ledgerAfter = await db
      .select({ total: sql<number>`coalesce(sum(amount_cents),0)::int` })
      .from(schema.payments)
      .where(eq(schema.payments.status, "confirmed"));
    expect(ledgerAfter[0].total).toBe(ledgerBefore[0].total);
  });

  test("owner requests, communications, follow-ups and prefs reparent", async () => {
    const { survivor, retired } = await pair();
    const animal = await seedAnimal();
    await db.insert(schema.ownerRequests).values({
      kind: "transfer",
      personId: retired.id,
      animalId: animal.id,
      detail: "gave her to my cousin",
      status: "pending",
    });
    await db.insert(schema.communications).values({
      personId: retired.id,
      channel: "email",
      kind: "registration-due",
      status: "sent",
      recipient: "jane@example.com",
      sentAt: new Date(),
    });
    await db.insert(schema.followUps).values({
      animalId: animal.id,
      personId: retired.id,
      kind: "recheck",
      reason: "suture removal",
      dueOn: "2026-01-01",
    });
    await db.insert(schema.clinicExpectations).values({
      animalId: animal.id,
      personId: retired.id,
      expectedOn: "2026-01-05",
      reason: "vaccination visit",
    });
    await db.insert(schema.communicationPreferences).values({
      personId: retired.id,
      channel: "email",
      kind: "vaccination-reminder",
      optedOut: true,
    });
    // Survivor has the same preference, opted IN — the union must keep
    // the opt-out.
    await db.insert(schema.communicationPreferences).values({
      personId: survivor.id,
      channel: "email",
      kind: "vaccination-reminder",
      optedOut: false,
    });

    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);

    const reqs = await db.select().from(schema.ownerRequests);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].personId).toBe(survivor.id);
    expect(reqs[0].detail).toBe("gave her to my cousin"); // prose untouched
    const comms = await db.select().from(schema.communications);
    expect(comms[0].personId).toBe(survivor.id);
    expect(comms[0].recipient).toBe("jane@example.com"); // send-time snapshot
    const fu = await db.select().from(schema.followUps);
    expect(fu[0].personId).toBe(survivor.id);
    const ce = await db.select().from(schema.clinicExpectations);
    expect(ce[0].personId).toBe(survivor.id);
    const prefs = await db.select().from(schema.communicationPreferences);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].personId).toBe(survivor.id);
    expect(prefs[0].optedOut).toBe(true);
  });
});

describe("field choices and retirement", () => {
  test("explicit choices apply; fill-the-blank fields combine automatically", async () => {
    const survivor = await seedPerson("Jane Owner", {
      email: "jane@example.com",
      phone: "555-0100",
    });
    const retired = await seedPerson("Jane Owner", {
      email: "jane@example.com",
      phone: "555-9999",
      address: "Windwardside",
      notes: "imported record",
    });
    const preview = await previewPersonMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    const result = await executePersonMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: { phone: "retired" },
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(true);
    const [after] = await db
      .select()
      .from(schema.persons)
      .where(eq(schema.persons.id, survivor.id));
    expect(after.phone).toBe("555-9999"); // staff-chosen
    expect(after.address).toBe("Windwardside"); // filled from retired
    expect(after.notes).toBe("imported record");
    expect(after.fullName).toBe("Jane Owner");
  });

  test("missing a required choice refuses the merge", async () => {
    const survivor = await seedPerson("Jane", { phone: "1" });
    const retired = await seedPerson("Jane", { phone: "2" });
    const preview = await previewPersonMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    const result = await executePersonMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid");
    expect(result.missingFields).toContain("phone");
  });

  test("merge lineage + alias resolution + confirmed review", async () => {
    const { survivor, retired } = await pair();
    const result = await merge(survivor.id, retired.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = await getPersonMergeInfo(retired.id, db);
    expect(info?.status).toBe("merged");
    expect(info?.survivor?.id).toBe(survivor.id);
    const target = await resolvePersonMergeTarget(retired.id, db);
    expect(target?.canonicalId).toBe(survivor.id);
    expect(target?.wasMerged).toBe(true);

    const canonicalInfo = await getPersonMergeInfo(survivor.id, db);
    expect(canonicalInfo?.absorbed.map((a) => a.id)).toEqual([retired.id]);

    const review = await db.select().from(schema.dataQualityReviews);
    expect(review).toHaveLength(1);
    expect(review[0].detector).toBe("duplicate-person");
    expect(review[0].decision).toBe("confirmed");

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityType, "person"));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("merge-retire");
    expect(actions).toContain("merge-absorb");
  });

  test("retired person is excluded from pickers and lists, but resolves annotated", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);

    const listed = await listPersons({}, db);
    expect(listed.map((p) => p.id)).toEqual([survivor.id]);
    const searched = await searchPersons("Jane", {}, db);
    expect(searched.map((p) => p.id)).toEqual([survivor.id]);

    const withRetired = await listPersons({ includeRetired: true }, db);
    const retiredRow = withRetired.find((p) => p.id === retired.id);
    expect(retiredRow?.mergedInto?.id).toBe(survivor.id);
  });

  test("retired person cannot be edited, linked, or re-merged", async () => {
    const { survivor, retired } = await pair();
    await merge(survivor.id, retired.id);

    const edit = await updatePerson(
      retired.id,
      { fullName: "New Name" },
      retired.updatedAt.toISOString(),
      STAFF,
      db,
    );
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.reason).toBe("merged");

    const [unlinked] = await db
      .insert(schema.authIdentities)
      .values({ provider: "firebase", providerUid: "unlinked-uid" })
      .returning();
    const link = await linkIdentityToPerson(unlinked.id, retired.id, STAFF, db);
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.reason).toBe("merged");

    const reMerge = await previewPersonMerge(retired.id, survivor.id, db);
    if (!reMerge.ok) throw new Error("preview failed");
    expect(reMerge.preview.blockers.map((b) => b.code)).toContain("already-merged");
  });

  test("a stale fingerprint refuses to apply", async () => {
    const { survivor, retired } = await pair();
    const preview = await previewPersonMerge(survivor.id, retired.id, db);
    if (!preview.ok) throw new Error("preview failed");
    // Something changed after the preview — a new ownership appears.
    const animal = await seedAnimal();
    await createOwnership(
      { animalId: animal.id, personId: retired.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const result = await executePersonMerge(
      {
        survivorId: survivor.id,
        retiredId: retired.id,
        fieldChoices: {},
        fingerprint: preview.preview.fingerprint,
        actorLabel: STAFF,
      },
      db,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stale");
  });
});
