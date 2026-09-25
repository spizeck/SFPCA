// Owner registry tests (#166) — the durable person/identity/household/
// ownership/confirmation/request model, run against PGlite so real
// Postgres semantics (CHECK constraints, partial unique indexes,
// interval math, FOR UPDATE) apply.
//
// The security properties under test are the issue's core:
//   - a login account is never the ownership record;
//   - an email match alone never links an account to a person;
//   - portal access follows CURRENT ownership only — former owners
//     lose access when their interval closes;
//   - every sensitive change leaves an audit_events row.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  closeOwnership,
  CONFIRMATION_PERIOD_DAYS,
  correctOwnership,
  createOwnership,
  getOwnedOwnership,
  listConfirmationsForAnimal,
  listCurrentOwnerships,
  listOwnershipHistory,
  listOwnershipsRequiringConfirmation,
  listPortalAnimals,
  recordOwnershipConfirmation,
  resolveAnimalOwner,
  transferOwnership,
} from "@/lib/registry/ownership";
import {
  createPerson,
  findClaimCandidates,
  getIdentityByProviderUid,
  householdsForPerson,
  linkIdentityToPerson,
  resolveOwnerSession,
  setHouseholdMember,
  removeHouseholdMember,
  unlinkIdentity,
  updateOwnerProfile,
  upsertAuthIdentity,
} from "@/lib/registry/persons";
import {
  cancelOwnerRequest,
  listOwnerRequests,
  listOwnerRequestsForPerson,
  provisionOwnerLink,
  resolveOwnerRequest,
  submitOwnerRequest,
} from "@/lib/registry/owner-requests";

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
    sql`TRUNCATE owner_requests, ownership_confirmations, ownerships, household_members, households, auth_identities, persons, animals, audit_events CASCADE`,
  );
});

let animalSeq = 0;
async function seedAnimal(name?: string) {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: name ?? `Animal-${++animalSeq}`,
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
    })
    .returning();
  return animal;
}

async function seedPerson(email = "owner@example.com", fullName = "Jane Owner") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName, email })
    .returning();
  return person;
}

async function seedIdentity(
  providerUid: string,
  email: string | null = "owner@example.com",
  personId: string | null = null,
) {
  const [identity] = await db
    .insert(schema.authIdentities)
    .values({ provider: "firebase", providerUid, email, personId })
    .returning();
  return identity;
}

async function auditActions(entityType: string) {
  const rows = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityType, entityType));
  return rows.map((r) => r.action);
}

const STAFF = "staff@example.com";
const TODAY = "2026-09-20";

describe("ownership intervals", () => {
  test("create → current; invalid shapes rejected", async () => {
    const person = await seedPerson();
    const animal = await seedAnimal("Rex");

    const created = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const current = await listCurrentOwnerships(animal.id, TODAY, db);
    expect(current).toHaveLength(1);
    expect(current[0].ownerName).toBe("Jane Owner");
    expect(current[0].ownerKind).toBe("person");

    // Both owner sides / neither side → invalid.
    expect(
      await createOwnership(
        { animalId: animal.id, validFrom: "2025-01-01" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, field: "owner" });
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Smiths" })
      .returning();
    expect(
      await createOwnership(
        {
          animalId: animal.id,
          personId: person.id,
          householdId: household.id,
          validFrom: "2025-01-01",
        },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, field: "owner" });

    // valid_to <= valid_from rejected.
    expect(
      await createOwnership(
        {
          animalId: animal.id,
          personId: person.id,
          validFrom: "2025-01-01",
          validTo: "2025-01-01",
        },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, field: "validTo" });

    expect(await auditActions("ownership")).toContain("create");
  });

  test("same-owner overlap rejected; different-owner overlap is co-ownership", async () => {
    const a = await seedPerson("a@example.com", "A");
    const b = await seedPerson("b@example.com", "B");
    const animal = await seedAnimal("Shared");

    await createOwnership(
      { animalId: animal.id, personId: a.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    // Same person, overlapping interval → contradictory data.
    expect(
      await createOwnership(
        { animalId: animal.id, personId: a.id, validFrom: "2025-06-01" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "overlap" });

    // Different person, overlapping interval → legitimate co-ownership.
    const co = await createOwnership(
      { animalId: animal.id, personId: b.id, validFrom: "2025-06-01" },
      STAFF,
      db,
    );
    expect(co.ok).toBe(true);
    const current = await listCurrentOwnerships(animal.id, TODAY, db);
    expect(current).toHaveLength(2);
  });

  test("close preserves the row as history; closing twice conflicts", async () => {
    const person = await seedPerson();
    const animal = await seedAnimal();
    const created = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");

    const closed = await closeOwnership(created.ownership.id, "2026-01-01", STAFF, db);
    expect(closed.ok).toBe(true);

    expect(
      await closeOwnership(created.ownership.id, "2026-02-01", STAFF, db),
    ).toMatchObject({ ok: false, reason: "conflict" });

    // validTo before validFrom rejected.
    const another = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2026-01-01" },
      STAFF,
      db,
    );
    if (!another.ok) throw new Error("setup");
    expect(
      await closeOwnership(another.ownership.id, "2025-12-31", STAFF, db),
    ).toMatchObject({ ok: false, field: "validTo" });

    const history = await listOwnershipHistory(animal.id, db);
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.validTo)).toContain("2026-01-01");
    expect(await auditActions("ownership")).toContain("close");
  });

  test("transfer closes the old interval and opens the new one atomically", async () => {
    const old = await seedPerson("old@example.com", "Old Owner");
    const next = await seedPerson("new@example.com", "New Owner");
    const animal = await seedAnimal("Transferred");

    const created = await createOwnership(
      { animalId: animal.id, personId: old.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");

    const moved = await transferOwnership(
      {
        ownershipId: created.ownership.id,
        validTo: "2026-02-01",
        newOwner: { personId: next.id },
      },
      STAFF,
      db,
    );
    expect(moved.ok).toBe(true);

    const history = await listOwnershipHistory(animal.id, db);
    expect(history).toHaveLength(2);

    // Before the transfer date the old owner is still current; at/after
    // it the new owner is. [valid_from, valid_to) semantics.
    const before = await listCurrentOwnerships(animal.id, "2026-01-31", db);
    expect(before[0].personId).toBe(old.id);
    const after = await listCurrentOwnerships(animal.id, "2026-02-01", db);
    expect(after[0].personId).toBe(next.id);

    expect(await auditActions("ownership")).toContain("transfer");
  });

  test("correctOwnership fixes bad data under optimistic concurrency", async () => {
    const person = await seedPerson();
    const animal = await seedAnimal();
    const created = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");

    expect(
      await correctOwnership(
        created.ownership.id,
        { validFrom: "2025-02-01" },
        "1970-01-01T00:00:00.000Z",
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "conflict" });

    const fixed = await correctOwnership(
      created.ownership.id,
      { validFrom: "2025-02-01", note: "corrected date" },
      created.ownership.createdAt,
      STAFF,
      db,
    );
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(fixed.ownership.validFrom).toBe("2025-02-01");
    expect(await auditActions("ownership")).toContain("correct");
  });
});

describe("owner authorization", () => {
  test("portal lists only current animals; former owners lose access", async () => {
    const owner = await seedPerson("owner@example.com", "Owner");
    const other = await seedPerson("other@example.com", "Other");
    const mine = await seedAnimal("Mine");
    const theirs = await seedAnimal("Theirs");
    const former = await seedAnimal("Former");

    await createOwnership(
      { animalId: mine.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: theirs.id, personId: other.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const closed = await createOwnership(
      { animalId: former.id, personId: owner.id, validFrom: "2020-01-01" },
      STAFF,
      db,
    );
    if (!closed.ok) throw new Error("setup");
    await closeOwnership(closed.ownership.id, "2021-01-01", STAFF, db);

    const mine_ = await listPortalAnimals(owner.id, TODAY, db);
    expect(mine_.map((a) => a.name)).toEqual(["Mine"]);

    const others = await listPortalAnimals(other.id, TODAY, db);
    expect(others.map((a) => a.name)).toEqual(["Theirs"]);

    // getOwnedOwnership is the mutation gate — guessed ids fail.
    const ownedRow = mine_[0];
    expect(
      await getOwnedOwnership(ownedRow.ownershipId, owner.id, TODAY, db),
    ).not.toBeNull();
    expect(
      await getOwnedOwnership(ownedRow.ownershipId, other.id, TODAY, db),
    ).toBeNull();
    expect(
      await getOwnedOwnership("not-a-uuid", owner.id, TODAY, db),
    ).toBeNull();
  });

  test("household members see household animals; non-members do not", async () => {
    const member = await seedPerson("member@example.com", "Member");
    const outsider = await seedPerson("outsider@example.com", "Outsider");
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Smiths" })
      .returning();
    await setHouseholdMember(household.id, member.id, "primary", STAFF, db);
    const animal = await seedAnimal("Household Pet");
    await createOwnership(
      { animalId: animal.id, householdId: household.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );

    const memberAnimals = await listPortalAnimals(member.id, TODAY, db);
    expect(memberAnimals.map((a) => a.name)).toEqual(["Household Pet"]);
    expect(memberAnimals[0].basis).toBe("household");
    expect(memberAnimals[0].householdName).toBe("Smiths");

    expect(await listPortalAnimals(outsider.id, TODAY, db)).toEqual([]);

    // Leaving the household ends portal access.
    await removeHouseholdMember(household.id, member.id, STAFF, db);
    expect(await listPortalAnimals(member.id, TODAY, db)).toEqual([]);
    expect(await auditActions("household_member")).toEqual(
      expect.arrayContaining(["add", "remove"]),
    );
  });
});

describe("annual confirmations", () => {
  test("portal confirm writes a deliberate row + audit; non-party rejected", async () => {
    const owner = await seedPerson();
    const other = await seedPerson("other@example.com", "Other");
    const identity = await seedIdentity("uid-1", owner.email, owner.id);
    const animal = await seedAnimal();
    const created = await createOwnership(
      { animalId: animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");

    const confirmed = await recordOwnershipConfirmation(
      {
        ownershipId: created.ownership.id,
        personId: owner.id,
        method: "owner-portal",
        confirmedByIdentityId: identity.id,
        confirmedOn: TODAY,
      },
      db,
    );
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.confirmation.method).toBe("owner-portal");
      expect(confirmed.confirmation.confirmedOn).toBe(TODAY);
    }

    // A person who is not a party to the relationship cannot confirm it.
    expect(
      await recordOwnershipConfirmation(
        {
          ownershipId: created.ownership.id,
          personId: other.id,
          method: "owner-portal",
          confirmedOn: TODAY,
        },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-owner" });

    const history = await listConfirmationsForAnimal(animal.id, db);
    expect(history).toHaveLength(1);
    expect(await auditActions("ownership_confirmation")).toContain("confirm");
  });

  test("confirmation on a closed interval is rejected", async () => {
    const owner = await seedPerson();
    const animal = await seedAnimal();
    const created = await createOwnership(
      { animalId: animal.id, personId: owner.id, validFrom: "2020-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    await closeOwnership(created.ownership.id, "2021-01-01", STAFF, db);

    expect(
      await recordOwnershipConfirmation(
        {
          ownershipId: created.ownership.id,
          personId: owner.id,
          method: "staff",
          confirmedOn: TODAY,
        },
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-current" });
  });

  test("eligibility: due one year after last affirmation; confirmation resets", async () => {
    const owner = await seedPerson();
    const animal = await seedAnimal("DueSoon");
    // valid_from seeds the affirmation clock.
    const created = await createOwnership(
      { animalId: animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");

    // 364 days in — not due.
    expect(
      await listOwnershipsRequiringConfirmation({ asOf: "2025-12-31" }, db),
    ).toHaveLength(0);
    // 365 days in — due.
    const due = await listOwnershipsRequiringConfirmation(
      { asOf: "2026-01-01" },
      db,
    );
    expect(due).toHaveLength(1);
    expect(due[0].ownershipId).toBe(created.ownership.id);
    expect(due[0].dueOn).toBe("2026-01-01");

    // A confirmation pushes the next due date a full period out.
    await recordOwnershipConfirmation(
      {
        ownershipId: created.ownership.id,
        personId: owner.id,
        method: "owner-portal",
        confirmedOn: "2026-01-15",
      },
      db,
    );
    expect(
      await listOwnershipsRequiringConfirmation({ asOf: "2026-01-15" }, db),
    ).toHaveLength(0);
    const nextDue = await listOwnershipsRequiringConfirmation(
      { asOf: "2027-01-15" },
      db,
    );
    expect(nextDue[0]?.dueOn).toBe("2027-01-15");

    // Closed relationships are never eligible.
    await closeOwnership(created.ownership.id, "2026-02-01", STAFF, db);
    expect(
      await listOwnershipsRequiringConfirmation({ asOf: "2026-02-02" }, db),
    ).toHaveLength(0);
  });
});

describe("identity linking and claiming", () => {
  test("upsertAuthIdentity is idempotent and refreshes the email snapshot", async () => {
    const first = await upsertAuthIdentity(
      { providerUid: "uid-x", email: "a@example.com" },
      db,
    );
    const second = await upsertAuthIdentity(
      { providerUid: "uid-x", email: "b@example.com" },
      db,
    );
    expect(second.id).toBe(first.id);
    expect(second.email).toBe("b@example.com");
    expect(second.personId).toBeNull();
  });

  test("unlinked identity with no candidates gets a NEW person — never email-guessed", async () => {
    const identity = await seedIdentity("uid-new", "fresh@example.com");
    const result = await provisionOwnerLink(
      { ...identity, createdAt: identity.createdAt.toISOString() },
      { displayName: "Fresh Owner", actorLabel: "fresh@example.com" },
      db,
    );
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.person.fullName).toBe("Fresh Owner");
      const linked = await getIdentityByProviderUid("uid-new", db);
      expect(linked?.personId).toBe(result.person.id);
    }
  });

  test("email-matched unclaimed person → claim request, NOT a link", async () => {
    // A registry person exists with this email — typed in by staff.
    await seedPerson("claimed@example.com", "Registry Person");
    const identity = await seedIdentity("uid-claim", "claimed@example.com");

    const result = await provisionOwnerLink(
      { ...identity, createdAt: identity.createdAt.toISOString() },
      { displayName: "Claimant", actorLabel: "claimed@example.com" },
      db,
    );
    expect(result.status).toBe("pending-claim");

    // The identity is still unlinked — the claimant sees nothing.
    const ctx = await resolveOwnerSession("uid-claim", db);
    expect(ctx?.person).toBeNull();

    const pending = await listOwnerRequests({ status: "pending" }, db);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("account-claim");

    // Repeat login does not pile up duplicate claims.
    await provisionOwnerLink(
      { ...identity, createdAt: identity.createdAt.toISOString() },
      { displayName: "Claimant", actorLabel: "claimed@example.com" },
      db,
    );
    expect(await listOwnerRequests({ status: "pending" }, db)).toHaveLength(1);
  });

  test("already-linked person is not a claim candidate", async () => {
    const person = await seedPerson("taken@example.com");
    await seedIdentity("uid-taken", "taken@example.com", person.id);
    expect(await findClaimCandidates("taken@example.com", db)).toHaveLength(0);
  });

  test("staff approving a claim links the identity", async () => {
    const person = await seedPerson("claimed2@example.com", "Real Owner");
    const identity = await seedIdentity("uid-claim2", "claimed2@example.com");
    await provisionOwnerLink(
      { ...identity, createdAt: identity.createdAt.toISOString() },
      { displayName: null, actorLabel: "claimed2@example.com" },
      db,
    );
    const [pending] = await listOwnerRequests({ status: "pending" }, db);

    const resolved = await resolveOwnerRequest(
      pending.id,
      { decision: "approved", targetPersonId: person.id },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const ctx = await resolveOwnerSession("uid-claim2", db);
    expect(ctx?.person?.id).toBe(person.id);
    expect(await auditActions("auth_identity")).toContain("link-person");
    expect(await auditActions("owner_request")).toContain("resolve-approved");
  });

  test("link/unlink identity are audited and conflict-guarded", async () => {
    const a = await seedPerson("a2@example.com", "A2");
    const b = await seedPerson("b2@example.com", "B2");
    const identity = await seedIdentity("uid-link", "x@example.com");

    expect(await linkIdentityToPerson(identity.id, a.id, STAFF, db)).toEqual({
      ok: true,
    });
    // Already linked to A — linking to B requires an explicit unlink first.
    expect(await linkIdentityToPerson(identity.id, b.id, STAFF, db)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(await unlinkIdentity(identity.id, STAFF, db)).toEqual({ ok: true });
    expect(await linkIdentityToPerson(identity.id, b.id, STAFF, db)).toEqual({
      ok: true,
    });
  });
});

describe("owner requests", () => {
  let uidSeq = 0;
  async function ownedSetup() {
    const owner = await seedPerson();
    const identity = await seedIdentity(
      `uid-owner-${++uidSeq}`,
      owner.email,
      owner.id,
    );
    const animal = await seedAnimal();
    const created = await createOwnership(
      { animalId: animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!created.ok) throw new Error("setup");
    return { owner, identity, animal, ownership: created.ownership };
  }

  test("submit + dedup + owner history + cancel", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();

    const submitted = await submitOwnerRequest(
      {
        kind: "no-longer-mine",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
        detail: "Rehomed to a neighbour",
      },
      owner.email!,
      db,
    );
    expect(submitted.ok).toBe(true);

    // Same kind+animal+account pending → dedup, not a second row.
    const dup = await submitOwnerRequest(
      {
        kind: "no-longer-mine",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
      },
      owner.email!,
      db,
    );
    expect(dup).toMatchObject({ ok: false, reason: "duplicate" });

    const mine = await listOwnerRequestsForPerson(owner.id, db);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("no-longer-mine");

    const cancelled = await cancelOwnerRequest(
      mine[0].id,
      owner.id,
      identity.id,
      db,
    );
    expect(cancelled.ok).toBe(true);

    // A stranger cannot cancel someone else's request.
    const other = await seedPerson("other@example.com", "Other");
    const second = await submitOwnerRequest(
      {
        kind: "lifecycle-deceased",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
      },
      owner.email!,
      db,
    );
    if (!second.ok) throw new Error("setup");
    expect(
      await cancelOwnerRequest(second.request.id, other.id, identity.id, db),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("approving 'no-longer-mine' closes the ownership; rejecting does not", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();

    const submitted = await submitOwnerRequest(
      {
        kind: "no-longer-mine",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");

    const resolved = await resolveOwnerRequest(
      submitted.request.id,
      { decision: "approved", effectiveOn: "2026-03-01" },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    // Ownership closed effective that date — history intact.
    const history = await listOwnershipHistory(animal.id, db);
    expect(history[0].validTo).toBe("2026-03-01");
    // Former owner no longer has portal access.
    expect(await listPortalAnimals(owner.id, "2026-03-02", db)).toEqual([]);

    // Rejecting a fresh request leaves everything unchanged.
    const { owner: o2, identity: i2, animal: a2, ownership: osh2 } = await ownedSetup();
    const second = await submitOwnerRequest(
      {
        kind: "no-longer-mine",
        authIdentityId: i2.id,
        personId: o2.id,
        animalId: a2.id,
        ownershipId: osh2.id,
      },
      o2.email!,
      db,
    );
    if (!second.ok) throw new Error("setup");
    const rejected = await resolveOwnerRequest(
      second.request.id,
      { decision: "rejected", resolutionNote: "Confirmed still yours" },
      STAFF,
      db,
    );
    expect(rejected.ok).toBe(true);
    const stillCurrent = await listCurrentOwnerships(a2.id, TODAY, db);
    expect(stillCurrent[0].personId).toBe(o2.id);
  });

  test("approving a transfer moves ownership to the staff-picked target", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();
    const next = await seedPerson("newowner@example.com", "New Owner");

    const submitted = await submitOwnerRequest(
      {
        kind: "transfer",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
        // The owner's free-text hint is context for staff, never a link.
        payload: { targetName: "Someone New", targetContact: "555-1234" },
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");

    const resolved = await resolveOwnerRequest(
      submitted.request.id,
      {
        decision: "approved",
        targetPersonId: next.id,
        effectiveOn: "2026-03-01",
      },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const after = await listCurrentOwnerships(animal.id, "2026-03-01", db);
    expect(after[0].personId).toBe(next.id);
    const history = await listOwnershipHistory(animal.id, db);
    expect(history).toHaveLength(2);
  });

  test("lifecycle reports close the reporter's ownership on approval", async () => {
    const { owner, identity, animal, ownership } = await ownedSetup();
    const submitted = await submitOwnerRequest(
      {
        kind: "lifecycle-deceased",
        authIdentityId: identity.id,
        personId: owner.id,
        animalId: animal.id,
        ownershipId: ownership.id,
        detail: "Passed away last week",
      },
      owner.email!,
      db,
    );
    if (!submitted.ok) throw new Error("setup");

    const resolved = await resolveOwnerRequest(
      submitted.request.id,
      { decision: "approved", effectiveOn: "2026-02-20" },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);
    const history = await listOwnershipHistory(animal.id, db);
    expect(history[0].validTo).toBe("2026-02-20");
  });
});

describe("resolveAnimalOwner (canonical)", () => {
  test("household ownership resolves through its primary member", async () => {
    const member = await seedPerson("hh@example.com", "HH Member");
    const [household] = await db
      .insert(schema.households)
      .values({ name: "HH" })
      .returning();
    await setHouseholdMember(household.id, member.id, "primary", STAFF, db);
    const animal = await seedAnimal();
    await createOwnership(
      { animalId: animal.id, householdId: household.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );

    const resolved = await resolveAnimalOwner(animal.id, TODAY, db);
    expect(resolved).toMatchObject({
      status: "ok",
      personId: member.id,
      email: "hh@example.com",
    });
  });
});

describe("owner profile", () => {
  test("owner self-edit updates contact fields and audits", async () => {
    const person = await seedPerson();
    const identity = await seedIdentity("uid-prof", person.email, person.id);
    const result = await updateOwnerProfile(
      person.id,
      {
        fullName: "Jane Renamed",
        email: "new@example.com",
        phone: "+599-555-0100",
      },
      identity.id,
      person.email!,
      db,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.person.fullName).toBe("Jane Renamed");
      // notes is staff-only — never writable via the owner path.
      expect(result.person.notes).toBeNull();
    }
    expect(await auditActions("person")).toContain("owner-profile-update");
  });

  test("householdsForPerson lists memberships", async () => {
    const person = await seedPerson();
    const [h] = await db
      .insert(schema.households)
      .values({ name: "Them", address: "Windwardside" })
      .returning();
    await setHouseholdMember(h.id, person.id, "member", STAFF, db);
    const list = await householdsForPerson(person.id, db);
    expect(list.map((x) => x.name)).toEqual(["Them"]);
    expect(list[0].members[0].fullName).toBe("Jane Owner");
  });
});
