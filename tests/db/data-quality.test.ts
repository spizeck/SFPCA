// Data-quality detection + review tests (#178) on PGlite — real
// constraint and query semantics, not mocks.
//
// The properties under test:
//   - every detector produces typed findings with evidence, severity,
//     and an actionable href — candidates, never conclusions;
//   - name similarity ALONE never qualifies a duplicate pair;
//   - chip conflicts are surfaced from #168's conflict table, not
//     re-detected;
//   - persisted review decisions suppress/reopen correctly and a
//     materially-changed evidence fingerprint resurfaces a dismissal;
//   - the dashboard summary excludes chip conflicts (they have their
//     own #177 item) and counts only non-suppressed findings.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  canonicalEntityIds,
  getDataQualitySummary,
  listDataQualityFindings,
  recordDataQualityReview,
  clearDataQualityReview,
  type DataQualityFinding,
} from "@/lib/registry/data-quality";
import { createOwnership } from "@/lib/registry/ownership";
import { createRegistration } from "@/lib/registry/registrations";

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
    sql`TRUNCATE animal_merges, data_quality_reviews, payments, registrations, microchip_conflicts, microchip_records, lost_found_cases, vaccinations, vet_encounters, vet_procedures, vet_medications, medical_alerts, weight_records, vet_documents, follow_ups, clinic_expectations, communications, owner_requests, ownership_confirmations, ownerships, animal_lifecycle_events, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

async function seedAnimal(
  opts: Partial<typeof schema.animals.$inferInsert> = {},
) {
  const [a] = await db
    .insert(schema.animals)
    .values({
      name: "Rex",
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
      adoptionStatus: "not-listed",
      ...opts,
    })
    .returning();
  return a;
}

async function seedPerson(
  opts: Partial<typeof schema.persons.$inferInsert> = {},
) {
  const [p] = await db
    .insert(schema.persons)
    .values({ fullName: "Jane Owner", ...opts })
    .returning();
  return p;
}

async function findingsFor(
  detector: string,
): Promise<DataQualityFinding[]> {
  const all = await listDataQualityFindings({ status: "all" }, db);
  return all.filter((f) => f.detector === detector);
}

describe("duplicate-animal detection", () => {
  test("same microchip on two live records is a strong candidate", async () => {
    const a = await seedAnimal({ name: "Rex" });
    const b = await seedAnimal({ name: "Rocky" });
    for (const id of [a.id, b.id]) {
      await db.insert(schema.microchipRecords).values({
        animalId: id,
        chipNumber: "985113000000001",
        chipDisplay: "985113000000001",
        assignedFrom: "2025-01-01",
        assignedTo: "2025-06-01", // closed on both — history still counts
        closedReason: "replaced",
      });
    }
    const found = await findingsFor("duplicate-animal");
    expect(found.length).toBe(1);
    expect(found[0].entityIds).toEqual(canonicalEntityIds([a.id, b.id]));
    expect(found[0].severity).toBe("review");
    expect(found[0].href).toBe(
      `/admin/data-quality/merge?a=${canonicalEntityIds([a.id, b.id])[0]}&b=${canonicalEntityIds([a.id, b.id])[1]}`,
    );
    expect(found[0].evidence.join(" ")).toContain("microchip");
  });

  test("shared current owner corroborates a candidate", async () => {
    const a = await seedAnimal({ name: "Bella" });
    const b = await seedAnimal({ name: "Bella" });
    const owner = await seedPerson();
    for (const id of [a.id, b.id]) {
      await createOwnership(
        { animalId: id, personId: owner.id, validFrom: "2025-01-01" },
        STAFF,
        db,
      );
    }
    const found = await findingsFor("duplicate-animal");
    expect(found.length).toBe(1);
    expect(found[0].evidence.join(" ")).toContain("same current owner");
  });

  test("same name + species alone is NOT a candidate", async () => {
    await seedAnimal({ name: "Bella", species: "dog", sex: "female" });
    await seedAnimal({ name: "Bella", species: "dog", sex: "male" });
    const found = await findingsFor("duplicate-animal");
    expect(found.length).toBe(0);
  });

  test("same name + species + identical birth date qualifies", async () => {
    await seedAnimal({
      name: "Bella",
      species: "dog",
      birthDate: "2020-05-01",
    });
    await seedAnimal({
      name: "bella",
      species: "dog",
      birthDate: "2020-05-01",
    });
    const found = await findingsFor("duplicate-animal");
    expect(found.length).toBe(1);
  });

  test("merged records never participate as candidates", async () => {
    const a = await seedAnimal({ name: "Bella" });
    await seedAnimal({ name: "Bella", lifecycleStatus: "merged" });
    const found = await findingsFor("duplicate-animal");
    expect(found.filter((f) => f.entityIds.includes(a.id)).length).toBe(0);
  });
});

describe("duplicate-person / household detection", () => {
  test("two persons sharing a normalized email are a candidate", async () => {
    await seedPerson({ fullName: "Jane Owner", email: "jane@example.com" });
    await seedPerson({ fullName: "J. Owner", email: " JANE@example.com " });
    const found = await findingsFor("duplicate-person");
    expect(found.length).toBe(1);
    expect(found[0].evidence.join(" ")).toContain("same email");
  });

  test("name-only similarity never flags people", async () => {
    await seedPerson({ fullName: "Jane Owner" });
    await seedPerson({ fullName: "Jane Owner" });
    const found = await findingsFor("duplicate-person");
    expect(found.length).toBe(0);
  });

  test("a person in two households flags the households", async () => {
    const p = await seedPerson();
    const h1 = await db
      .insert(schema.households)
      .values({ name: "House A" })
      .returning();
    const h2 = await db
      .insert(schema.households)
      .values({ name: "House B" })
      .returning();
    for (const h of [h1[0], h2[0]]) {
      await db
        .insert(schema.householdMembers)
        .values({ householdId: h.id, personId: p.id });
    }
    const found = await findingsFor("duplicate-household");
    expect(found.length).toBe(1);
    expect(found[0].evidence.join(" ")).toContain("shared member");
  });
});

describe("integrity detectors", () => {
  test("open chip conflict surfaces as blocking — #168's table, surfaced not re-detected", async () => {
    const a = await seedAnimal();
    const b = await seedAnimal();
    await db.insert(schema.microchipConflicts).values({
      chipNumber: "985113000000001",
      claimedAnimalId: a.id,
      existingAnimalId: b.id,
      source: "staff",
    });
    const found = await findingsFor("microchip-conflict");
    expect(found.length).toBe(1);
    expect(found[0].severity).toBe("blocking");
    expect(found[0].href).toContain("chip-lookup");
    // Resolved conflicts produce no finding.
    await db
      .update(schema.microchipConflicts)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: STAFF });
    expect((await findingsFor("microchip-conflict")).length).toBe(0);
  });

  test("active unlisted animal with no owner → review; adoption-listed → advisory", async () => {
    const unlisted = await seedAnimal({ adoptionStatus: "not-listed" });
    const listed = await seedAnimal({ adoptionStatus: "available" });
    const found = await findingsFor("animal-no-owner");
    const forUnlisted = found.find((f) => f.entityIds[0] === unlisted.id);
    const forListed = found.find((f) => f.entityIds[0] === listed.id);
    expect(forUnlisted?.severity).toBe("review");
    expect(forListed?.severity).toBe("advisory");
  });

  test("open ownership on a deceased animal is contradictory", async () => {
    const a = await seedAnimal({ lifecycleStatus: "deceased" });
    const p = await seedPerson();
    // Direct insert — transitionAnimalLifecycle would have closed it.
    await db.insert(schema.ownerships).values({
      animalId: a.id,
      personId: p.id,
      validFrom: "2025-01-01",
    });
    const found = await findingsFor("terminal-open-ownership");
    expect(found.length).toBe(1);
    expect(found[0].entityIds).toEqual([a.id]);
  });

  test("current status diverging from latest lifecycle event is flagged", async () => {
    const a = await seedAnimal({ lifecycleStatus: "active" });
    // History says deceased; the row was patched outside the write path.
    await db.insert(schema.animalLifecycleEvents).values({
      animalId: a.id,
      toStatus: "deceased",
      effectiveOn: "2026-01-01",
      source: "staff",
    });
    const found = await findingsFor("lifecycle-history-mismatch");
    expect(found.length).toBe(1);
    expect(found[0].entityIds).toEqual([a.id]);
  });

  test("future birth date is an impossible-date finding", async () => {
    await seedAnimal({ birthDate: "2999-01-01" });
    const found = await findingsFor("impossible-dates");
    expect(found.length).toBe(1);
  });

  test("active registration on a deceased animal is flagged", async () => {
    const a = await seedAnimal({ lifecycleStatus: "deceased" });
    await db.insert(schema.registrations).values({
      animalId: a.id,
      year: 2026,
      amountDueCents: 1500,
      status: "active",
    });
    const found = await findingsFor("registration-on-ineligible");
    expect(found.length).toBe(1);
  });

  test("confirmed money on a cancelled registration is flagged", async () => {
    const a = await seedAnimal();
    const reg = await createRegistration(
      { animalId: a.id, year: 2026, amountDueCents: 1500 },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("registration failed");
    await db.insert(schema.payments).values({
      registrationId: reg.registration.id,
      amountCents: 1500,
      currency: "USD",
      kind: "payment",
      status: "confirmed",
      method: "cash",
      source: "staff",
      occurredAt: new Date(),
    });
    await db
      .update(schema.registrations)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: "correction",
      })
      .where(sql`id = ${reg.registration.id}`);
    const found = await findingsFor("money-on-cancelled-registration");
    expect(found.length).toBe(1);
    expect(found[0].entityIds).toEqual([a.id]);
  });

  test("a chip number stored non-normalized is a blocking finding", async () => {
    const a = await seedAnimal();
    await db.insert(schema.microchipRecords).values({
      animalId: a.id,
      chipNumber: "bad-chip!",
      chipDisplay: "bad chip",
      assignedFrom: "2025-01-01",
    });
    const found = await findingsFor("malformed-microchip");
    expect(found.length).toBe(1);
    expect(found[0].severity).toBe("blocking");
  });
});

describe("review persistence", () => {
  async function aDuplicateFinding() {
    const a = await seedAnimal({ name: "Bella", birthDate: "2020-05-01" });
    const b = await seedAnimal({ name: "Bella", birthDate: "2020-05-01" });
    const found = await findingsFor("duplicate-animal");
    expect(found.length).toBe(1);
    return { finding: found[0], a, b };
  }

  test("dismissal suppresses while evidence is unchanged; filter shows it", async () => {
    const { finding } = await aDuplicateFinding();
    const r = await recordDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: finding.entityIds,
        fingerprint: finding.fingerprint,
        decision: "dismissed",
        note: "Different animals — verified with owners.",
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(true);

    const open = await listDataQualityFindings({ status: "open" }, db);
    expect(
      open.filter((f) => f.key === finding.key).length,
    ).toBe(0);
    const dismissed = await listDataQualityFindings(
      { status: "suppressed" },
      db,
    );
    const f = dismissed.find((x) => x.key === finding.key);
    expect(f?.suppressed).toBe(true);
    expect(f?.review?.decidedByLabel).toBe(STAFF);
    expect(f?.review?.note).toContain("Different animals");
  });

  test("pair order is canonical — dismissing B+A suppresses A+B", async () => {
    const { finding } = await aDuplicateFinding();
    const reversed = [...finding.entityIds].reverse();
    const r = await recordDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: reversed,
        fingerprint: finding.fingerprint,
        decision: "dismissed",
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(true);
    const open = await listDataQualityFindings({ status: "open" }, db);
    expect(open.find((f) => f.key === finding.key)).toBeUndefined();
  });

  test("changed evidence resurfaces a dismissal as a stale review", async () => {
    const { finding, a, b } = await aDuplicateFinding();
    await recordDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: finding.entityIds,
        fingerprint: finding.fingerprint,
        decision: "dismissed",
        actorLabel: STAFF,
      },
      db,
    );
    // Evidence materially changes: now they share a birth date AND a chip.
    for (const id of [a.id, b.id]) {
      await db.insert(schema.microchipRecords).values({
        animalId: id,
        chipNumber: "985113000000001",
        chipDisplay: "985113000000001",
        assignedFrom: "2025-01-01",
        assignedTo: "2025-06-01",
        closedReason: "replaced",
      });
    }
    const all = await listDataQualityFindings({ status: "all" }, db);
    const f = all.find((x) => x.key === finding.key);
    expect(f?.suppressed).toBe(false);
    expect(f?.staleReview).toBe(true);
    const open = await listDataQualityFindings({ status: "open" }, db);
    expect(open.find((x) => x.key === finding.key)).toBeDefined();
  });

  test("reopen clears the decision", async () => {
    const { finding } = await aDuplicateFinding();
    await recordDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: finding.entityIds,
        fingerprint: finding.fingerprint,
        decision: "dismissed",
        actorLabel: STAFF,
      },
      db,
    );
    const r = await clearDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: finding.entityIds,
        actorLabel: STAFF,
      },
      db,
    );
    expect(r.ok).toBe(true);
    const all = await listDataQualityFindings({ status: "all" }, db);
    expect(all.find((f) => f.key === finding.key)?.review).toBeNull();
  });

  test("reviews write an audit row", async () => {
    const { finding } = await aDuplicateFinding();
    await recordDataQualityReview(
      {
        detector: finding.detector,
        entityType: finding.entityType,
        entityIds: finding.entityIds,
        fingerprint: finding.fingerprint,
        decision: "confirmed",
        actorLabel: STAFF,
      },
      db,
    );
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(sql`entity_type = 'data-quality-review'`);
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("review-confirmed");
  });
});

describe("dashboard summary", () => {
  test("counts exclude chip conflicts and suppressed findings", async () => {
    // One blocking finding (chip conflict — excluded from summary).
    const a = await seedAnimal();
    const b = await seedAnimal();
    await db.insert(schema.microchipConflicts).values({
      chipNumber: "985113000000001",
      claimedAnimalId: a.id,
      existingAnimalId: b.id,
      source: "staff",
    });
    // One suppressed review finding.
    const c = await seedAnimal({ name: "Bella", birthDate: "2020-05-01" });
    const d = await seedAnimal({ name: "Bella", birthDate: "2020-05-01" });
    const dup = (await findingsFor("duplicate-animal"))[0];
    await recordDataQualityReview(
      {
        detector: dup.detector,
        entityType: dup.entityType,
        entityIds: dup.entityIds,
        fingerprint: dup.fingerprint,
        decision: "dismissed",
        actorLabel: STAFF,
      },
      db,
    );

    const summary = await getDataQualitySummary(db);
    // The chip conflict must NOT count (its own dashboard item covers
    // it); the dismissed pair counts only as suppressed; remaining
    // unlisted ownerless actives are 'review' findings.
    expect(summary.blocking).toBe(0);
    expect(summary.suppressed).toBe(1);
    expect(c.id && d.id).toBeTruthy();
    // animal-no-owner findings for the four seed animals exist.
    expect(summary.review).toBeGreaterThanOrEqual(4);
  });
});
