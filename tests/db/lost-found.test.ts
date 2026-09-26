// Lost/found case model tests (#176), run against PGlite so real
// Postgres semantics apply: partial unique indexes, CHECK constraints,
// FOR UPDATE, transaction isolation.
//
// The properties under test are the issue's core:
//   - case state is a WORKFLOW, deliberately separate from permanent
//     animal lifecycle — a resolved case never rewrites identity;
//   - at most one open missing and one open found case per animal, and
//     one open unmatched case per chip — the database enforces it;
//   - an unmatched found case is real without a fabricated animal, and
//     linking preserves that it began unmatched;
//   - resolution propagates to the sibling open case (the "missing
//     animal was found" pair) but never deletes history;
//   - outcome 'deceased' is the only path that touches lifecycle, via
//     the canonical transition;
//   - publication is explicit opt-in, and the public DTO is an
//     allowlist — no owner/reporter contact, notes, or chip data;
//   - the owner-portal report reuses canonical ownership authorization —
//     former owners are denied.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  addCaseUpdate,
  cancelCase,
  getCaseDetail,
  getOpenCaseCounts,
  isPubliclyListable,
  linkCaseToAnimal,
  listCasesForAnimal,
  listClosedCases,
  listOpenCases,
  listOpenCasesForChipOrAnimal,
  listPublishedLostAnimals,
  listUpdatesForCase,
  openFoundCase,
  openMissingCase,
  publishCase,
  reopenCase,
  reportMissingByOwner,
  resolveCase,
  submitPublicSighting,
  unpublishCase,
} from "@/lib/registry/lost-found";
import { createOwnership } from "@/lib/registry/ownership";
import { setHouseholdMember } from "@/lib/registry/persons";

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
    sql`TRUNCATE lost_found_updates, lost_found_cases, communications, microchip_conflicts, microchip_records, ownerships, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

let seq = 0;
async function seedAnimal(name?: string, lifecycleStatus = "active") {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: name ?? `Animal-${++seq}`,
      species: "dog",
      sex: "female",
      lifecycleStatus,
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

// actor_identity_id FKs to auth_identities — seed a real row so the
// owner-portal path records a genuine actor identity, same as prod.
async function seedIdentity(personId?: string) {
  const [identity] = await db
    .insert(schema.authIdentities)
    .values({
      provider: "firebase",
      providerUid: `uid-${++seq}`,
      personId: personId ?? null,
    })
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

describe("missing cases", () => {
  test("opens on a registered animal; a second open dedupes", async () => {
    const animal = await seedAnimal("Fluffy");
    const r1 = await openMissingCase(
      {
        animalId: animal.id,
        lastSeenOn: "2026-03-01",
        lastSeenLocation: "Windwardside",
        notes: "Slipped her collar.",
      },
      STAFF,
      db,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.case.caseType).toBe("missing");
    expect(r1.case.status).toBe("open");
    expect(r1.case.animalId).toBe(animal.id);
    expect(r1.case.animalName).toBe("Fluffy");
    expect(r1.case.lastSeenOn).toBe("2026-03-01");

    const r2 = await openMissingCase({ animalId: animal.id }, STAFF, db);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.existing).toBe(true);
    expect(r2.case.id).toBe(r1.case.id);
    expect(await auditActions("lost_found_case")).toContain("create");
  });

  test("the database itself enforces one open missing case per animal", async () => {
    const animal = await seedAnimal();
    await db.insert(schema.lostFoundCases).values({
      caseType: "missing",
      animalId: animal.id,
    });
    await expect(
      db.insert(schema.lostFoundCases).values({
        caseType: "missing",
        animalId: animal.id,
      }),
    ).rejects.toThrow();
    // A resolved one + a new open one is legitimate history.
    await db.insert(schema.lostFoundCases).values({
      caseType: "missing",
      animalId: animal.id,
      status: "resolved",
      outcome: "reunited",
      resolvedAt: new Date(),
      resolvedBy: STAFF,
    });
    await expect(
      db.insert(schema.lostFoundCases).values({
        caseType: "missing",
        animalId: animal.id,
        status: "resolved",
        outcome: "reunited",
        resolvedAt: new Date(),
        resolvedBy: STAFF,
      }),
    ).resolves.toBeTruthy();
  });

  test("a missing case without an animal is rejected by the CHECK", async () => {
    await expect(
      db.insert(schema.lostFoundCases).values({
        caseType: "missing",
        animalId: null,
      }),
    ).rejects.toThrow();
    // …and by the service.
    expect(
      await openMissingCase({ animalId: "not-a-uuid" }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("a resolved case closes; a NEW missing period can open after", async () => {
    const animal = await seedAnimal();
    const first = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!first.ok) throw new Error("setup");
    await resolveCase(first.case.id, { outcome: "reunited" }, STAFF, db);

    const second = await openMissingCase({ animalId: animal.id }, STAFF, db);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.existing).not.toBe(true);
    expect(second.case.id).not.toBe(first.case.id);

    // Both are preserved on the animal's history.
    const cases = await listCasesForAnimal(animal.id, db);
    expect(cases).toHaveLength(2);
  });
});

describe("found cases and dedupe", () => {
  test("the same unknown chip re-scan folds into one case", async () => {
    const r1 = await openFoundCase({ chipNumber: "999000" }, STAFF, db);
    if (!r1.ok) throw new Error("setup");
    const r2 = await openFoundCase({ chipNumber: "999-000" }, STAFF, db);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.existing).toBe(true);
    expect(r2.case.id).toBe(r1.case.id);
  });

  test("the database enforces one open unmatched case per chip", async () => {
    await db.insert(schema.lostFoundCases).values({
      caseType: "found",
      chipNumber: "ABC123",
    });
    await expect(
      db.insert(schema.lostFoundCases).values({
        caseType: "found",
        chipNumber: "ABC123",
      }),
    ).rejects.toThrow();
  });

  test("a found animal with no chip gets a distinct case each report", async () => {
    const r1 = await openFoundCase(
      { description: "Black dog, no collar, The Level" },
      STAFF,
      db,
    );
    const r2 = await openFoundCase(
      { description: "Black dog seen again" },
      STAFF,
      db,
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // No reliable dedupe key — both stand, staff reconcile manually.
    expect(r1.case.id).not.toBe(r2.case.id);
  });
});

describe("sightings and updates", () => {
  test("updates append in chronological order with provenance", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");

    await addCaseUpdate(
      c.case.id,
      {
        kind: "sighting",
        occurredAt: "2026-03-05T08:00:00.000Z",
        location: "Fort Bay",
        note: "Seen near the harbour",
        reporterName: "A passerby",
        source: "public",
      },
      "public-report",
      db,
    );
    await addCaseUpdate(
      c.case.id,
      {
        kind: "update",
        occurredAt: "2026-03-06T09:00:00.000Z",
        note: "Checked the area — nothing found",
      },
      STAFF,
      db,
    );

    const updates = await listUpdatesForCase(c.case.id, db);
    expect(updates).toHaveLength(2);
    expect(updates[0].kind).toBe("sighting");
    expect(updates[0].location).toBe("Fort Bay");
    expect(updates[0].reporterName).toBe("A passerby");
    expect(updates[1].kind).toBe("update");
    expect(await auditActions("lost_found_update")).toContain("add");
  });

  test("updates on a resolved case are refused", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await resolveCase(c.case.id, { outcome: "reunited" }, STAFF, db);
    expect(
      await addCaseUpdate(
        c.case.id,
        { kind: "sighting", note: "too late" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-open" });
  });

  test("a content-free update is refused", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    expect(
      await addCaseUpdate(c.case.id, { kind: "update" }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("linking unmatched cases", () => {
  test("link stamps who did it and preserves the unmatched origin", async () => {
    const animal = await seedAnimal("Scout");
    const c = await openFoundCase(
      { chipNumber: "12345", foundLocation: "The Bottom" },
      STAFF,
      db,
    );
    if (!c.ok) throw new Error("setup");
    expect(c.case.animalId).toBeNull();
    expect(c.case.linkedAt).toBeNull();

    const linked = await linkCaseToAnimal(c.case.id, animal.id, STAFF, db);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.case.animalId).toBe(animal.id);
    expect(linked.case.linkedAt).not.toBeNull();
    expect(linked.case.linkedBy).toBe(STAFF);
    expect(linked.case.animalName).toBe("Scout");

    // The timeline tells the whole story — scan, then link.
    const updates = await listUpdatesForCase(c.case.id, db);
    expect(updates.some((u) => u.note?.includes("Linked to"))).toBe(true);
    expect(await auditActions("lost_found_case")).toContain("link-animal");
  });

  test("linking to an animal that already has an open found case is refused", async () => {
    const animal = await seedAnimal();
    const first = await openFoundCase({ animalId: animal.id }, STAFF, db);
    if (!first.ok) throw new Error("setup");
    const second = await openFoundCase({ description: "stray" }, STAFF, db);
    if (!second.ok) throw new Error("setup");

    expect(
      await linkCaseToAnimal(second.case.id, animal.id, STAFF, db),
    ).toMatchObject({ ok: false, reason: "has-open-case" });
  });

  test("linking is fine alongside an open MISSING case — that IS the match", async () => {
    const animal = await seedAnimal();
    await openMissingCase({ animalId: animal.id }, STAFF, db);
    const found = await openFoundCase({ chipNumber: "777777" }, STAFF, db);
    if (!found.ok) throw new Error("setup");

    const linked = await linkCaseToAnimal(found.case.id, animal.id, STAFF, db);
    expect(linked.ok).toBe(true);
  });

  test("a resolved or already-linked case cannot be re-linked", async () => {
    const a1 = await seedAnimal();
    const a2 = await seedAnimal();
    const c = await openFoundCase({ chipNumber: "8888" }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await linkCaseToAnimal(c.case.id, a1.id, STAFF, db);
    expect(
      await linkCaseToAnimal(c.case.id, a2.id, STAFF, db),
    ).toMatchObject({ ok: false, reason: "not-unmatched" });
  });
});

describe("resolution", () => {
  test("resolving the missing case closes the sibling found case", async () => {
    const animal = await seedAnimal();
    const missing = await openMissingCase({ animalId: animal.id }, STAFF, db);
    const found = await openFoundCase({ chipNumber: "1212" }, STAFF, db);
    if (!missing.ok || !found.ok) throw new Error("setup");
    await linkCaseToAnimal(found.case.id, animal.id, STAFF, db);

    const resolved = await resolveCase(
      missing.case.id,
      { outcome: "reunited", resolutionNote: "Owner collected her" },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const detail = await getCaseDetail(found.case.id, db);
    expect(detail?.case.status).toBe("resolved");
    expect(detail?.case.outcome).toBe("reunited");
  });

  test("cancelling never touches the sibling — only the wrong case dies", async () => {
    const animal = await seedAnimal();
    const missing = await openMissingCase({ animalId: animal.id }, STAFF, db);
    const found = await openFoundCase({ chipNumber: "3434" }, STAFF, db);
    if (!missing.ok || !found.ok) throw new Error("setup");
    await linkCaseToAnimal(found.case.id, animal.id, STAFF, db);

    await cancelCase(found.case.id, { note: "Wrong animal" }, STAFF, db);
    const detail = await getCaseDetail(missing.case.id, db);
    expect(detail?.case.status).toBe("open");
  });

  test("ordinary resolution leaves lifecycle and ownership untouched", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await resolveCase(c.case.id, { outcome: "reunited" }, STAFF, db);

    const [a] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, animal.id));
    expect(a.lifecycleStatus).toBe("active");
    const ownerships = await db
      .select()
      .from(schema.ownerships)
      .where(eq(schema.ownerships.animalId, animal.id));
    expect(ownerships[0].validTo).toBeNull();
  });

  test("outcome 'deceased' drives the canonical lifecycle transition", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    const resolved = await resolveCase(
      c.case.id,
      {
        outcome: "deceased",
        resolutionNote: "Found dead on the road",
        deceasedEffectiveOn: "2026-03-10",
      },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);

    const [a] = await db
      .select()
      .from(schema.animals)
      .where(eq(schema.animals.id, animal.id));
    expect(a.lifecycleStatus).toBe("deceased");
    expect(a.lifecycleEffectiveOn).toBe("2026-03-10");
    // The canonical path wrote the lifecycle event + audit, not notes.
    const events = await db
      .select()
      .from(schema.animalLifecycleEvents)
      .where(eq(schema.animalLifecycleEvents.animalId, animal.id));
    expect(events[0].toStatus).toBe("deceased");
    expect(events[0].sourceRef).toBe(c.case.id);
  });

  test("resolved history is retained — nothing is deleted", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await resolveCase(c.case.id, { outcome: "reunited" }, STAFF, db);

    const cases = await listCasesForAnimal(animal.id, db);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe("resolved");
    const closed = await listClosedCases({}, db);
    expect(closed.map((x) => x.id)).toContain(c.case.id);
  });

  test("reopen clears the resolution and is audited", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await resolveCase(c.case.id, { outcome: "other" }, STAFF, db);

    const reopened = await reopenCase(c.case.id, STAFF, db);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.case.status).toBe("open");
    expect(reopened.case.resolvedAt).toBeNull();
    expect(await auditActions("lost_found_case")).toContain("reopen");
  });
});

describe("publication and the public DTO", () => {
  test("publish is explicit; the public read returns the allowlist only", async () => {
    const animal = await seedAnimal("Pepper");
    const person = await seedPerson("Secret Owner", {
      phone: "+599-416-9999",
      email: "secret@example.com",
    });
    await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    const c = await openMissingCase(
      {
        animalId: animal.id,
        lastSeenOn: "2026-03-01",
        lastSeenLocation: "Windwardside",
        reporterName: "Secret Owner",
        reporterContact: "secret@example.com",
        notes: "staff-only note",
      },
      STAFF,
      db,
    );
    if (!c.ok) throw new Error("setup");

    // Not published → invisible publicly, sighting refused.
    expect(await listPublishedLostAnimals(db)).toHaveLength(0);
    expect(await isPubliclyListable(c.case.id, db)).toBe(false);
    expect(
      await submitPublicSighting(c.case.id, { note: "seen it" }, db),
    ).toMatchObject({ ok: false });

    const published = await publishCase(
      c.case.id,
      { publicNote: "Shy but friendly — do not chase" },
      STAFF,
      db,
    );
    expect(published.ok).toBe(true);
    expect(await auditActions("lost_found_case")).toContain("publish");

    const list = await listPublishedLostAnimals(db);
    expect(list).toHaveLength(1);
    const dto = list[0];
    expect(dto.name).toBe("Pepper");
    expect(dto.species).toBe("dog");
    expect(dto.lastSeenLocation).toBe("Windwardside");
    expect(dto.publicNote).toBe("Shy but friendly — do not chase");
    expect(dto.missingSince).toBe("2026-03-01");
    // The allowlist is the contract — nothing private may appear.
    expect(Object.keys(dto).sort()).toEqual(
      [
        "approxAge",
        "caseId",
        "lastSeenLocation",
        "missingSince",
        "name",
        "photoUrl",
        "publicNote",
        "registryRef",
        "sex",
        "species",
      ].sort(),
    );
  });

  test("a resolved case drops out of the public listing automatically", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await publishCase(c.case.id, {}, STAFF, db);
    expect(await listPublishedLostAnimals(db)).toHaveLength(1);

    await resolveCase(c.case.id, { outcome: "reunited" }, STAFF, db);
    expect(await listPublishedLostAnimals(db)).toHaveLength(0);
    // Internal history still knows it was published once.
    const detail = await getCaseDetail(c.case.id, db);
    expect(detail?.case.publishedAt).not.toBeNull();
  });

  test("unpublish removes it from the listing; audit records both", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await publishCase(c.case.id, {}, STAFF, db);
    const un = await unpublishCase(c.case.id, STAFF, db);
    expect(un.ok).toBe(true);
    expect(await listPublishedLostAnimals(db)).toHaveLength(0);
    expect(await auditActions("lost_found_case")).toContain("unpublish");
  });

  test("a found case can never be published — only missing+linked", async () => {
    const found = await openFoundCase({ chipNumber: "555555" }, STAFF, db);
    if (!found.ok) throw new Error("setup");
    expect(
      await publishCase(found.case.id, {}, STAFF, db),
    ).toMatchObject({ ok: false });
  });

  test("public sightings land on the case chronology", async () => {
    const animal = await seedAnimal();
    const c = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!c.ok) throw new Error("setup");
    await publishCase(c.case.id, {}, STAFF, db);

    const s = await submitPublicSighting(
      c.case.id,
      {
        location: "The Bottom",
        note: "Seen this morning",
        reporterName: "Anonymous",
        reporterContact: "anon@example.com",
      },
      db,
    );
    expect(s.ok).toBe(true);
    const updates = await listUpdatesForCase(c.case.id, db);
    const sighting = updates.find((u) => u.kind === "sighting");
    expect(sighting?.source).toBe("public");
    expect(sighting?.reporterContact).toBe("anon@example.com");
  });
});

describe("owner-portal reporting", () => {
  test("a current owner reports their own animal missing", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson("Real Owner", {
      email: "owner@example.com",
    });
    const own = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");
    const identity = await seedIdentity(person.id);

    const r = await reportMissingByOwner(
      {
        ownershipId: own.ownership.id,
        personId: person.id,
        reporterEmail: "owner@example.com",
        actorIdentity: identity.id,
        lastSeenOn: "2026-03-02",
        lastSeenLocation: "Home",
      },
      db,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const detail = await getCaseDetail(r.caseId, db);
    expect(detail?.case.reportedVia).toBe("owner-portal");
    expect(detail?.case.reporterName).toBe("Real Owner");
    expect(detail?.case.status).toBe("open");

    // A second report dedupes — no duplicate case.
    const again = await reportMissingByOwner(
      {
        ownershipId: own.ownership.id,
        personId: person.id,
        reporterEmail: "owner@example.com",
        actorIdentity: identity.id,
      },
      db,
    );
    expect(again.ok && again.existing).toBe(true);
  });

  test("a former owner is denied — historical ownership is not access", async () => {
    const animal = await seedAnimal();
    const former = await seedPerson("Former Owner");
    const own = await createOwnership(
      {
        animalId: animal.id,
        personId: former.id,
        validFrom: "2020-01-01",
        validTo: "2021-01-01",
      },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");

    const r = await reportMissingByOwner(
      {
        ownershipId: own.ownership.id,
        personId: former.id,
        reporterEmail: null,
        actorIdentity: null,
      },
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "not-owner" });
  });

  test("a stranger's ownership id is meaningless to them", async () => {
    const animal = await seedAnimal();
    const owner = await seedPerson("True Owner");
    const stranger = await seedPerson("Stranger");
    const own = await createOwnership(
      { animalId: animal.id, personId: owner.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");

    const r = await reportMissingByOwner(
      {
        ownershipId: own.ownership.id,
        personId: stranger.id,
        reporterEmail: null,
        actorIdentity: null,
      },
      db,
    );
    expect(r).toMatchObject({ ok: false, reason: "not-owner" });
  });

  test("a household member can report a household animal", async () => {
    const animal = await seedAnimal();
    const [household] = await db
      .insert(schema.households)
      .values({ name: "Fort Bay Family" })
      .returning();
    const member = await seedPerson("Household Member");
    await setHouseholdMember(household.id, member.id, "member", STAFF, db);
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
    const identity = await seedIdentity(member.id);

    const r = await reportMissingByOwner(
      {
        ownershipId: own.ownership.id,
        personId: member.id,
        reporterEmail: null,
        actorIdentity: identity.id,
      },
      db,
    );
    expect(r.ok).toBe(true);
  });
});

describe("queues and the chip-scan read", () => {
  test("open queue counts and type filtering", async () => {
    const a1 = await seedAnimal();
    const a2 = await seedAnimal();
    await openMissingCase({ animalId: a1.id }, STAFF, db);
    await openFoundCase({ chipNumber: "111111" }, STAFF, db); // unmatched
    await openFoundCase({ animalId: a2.id, chipNumber: "222222" }, STAFF, db);
    const cancelled = await openFoundCase({ chipNumber: "333333" }, STAFF, db);
    if (!cancelled.ok) throw new Error("setup");
    await cancelCase(cancelled.case.id, {}, STAFF, db);

    const counts = await getOpenCaseCounts(db);
    expect(counts).toEqual({
      missing: 1,
      foundUnmatched: 1,
      foundMatched: 1,
    });
    expect(await listOpenCases({ caseType: "missing" }, db)).toHaveLength(1);
    expect(await listOpenCases({}, db)).toHaveLength(3);
  });

  test("the scan read finds animal cases AND unmatched chip cases", async () => {
    const animal = await seedAnimal();
    await openMissingCase({ animalId: animal.id }, STAFF, db);
    await openFoundCase(
      { chipNumber: "777777", foundLocation: "Trail" },
      STAFF,
      db,
    );

    // Animal-only view (the match card).
    const byAnimal = await listOpenCasesForChipOrAnimal(
      { animalId: animal.id },
      db,
    );
    expect(byAnimal).toHaveLength(1);
    expect(byAnimal[0].caseType).toBe("missing");

    // Chip-only view (the not-found card).
    const byChip = await listOpenCasesForChipOrAnimal(
      { chipNumber: "777777" },
      db,
    );
    expect(byChip).toHaveLength(1);
    expect(byChip[0].foundLocation).toBe("Trail");
  });
});
