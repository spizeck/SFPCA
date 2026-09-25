// Microchip registry + found-animal workflow tests (#168), run against
// PGlite so real Postgres semantics apply: partial unique indexes,
// CHECK constraints, FOR UPDATE, transaction isolation.
//
// The properties under test are the issue's core:
//   - one canonical normalization drives every path;
//   - a duplicate chip claim is rejected AND flagged — never silently
//     moved or overwritten;
//   - chips close with a reason instead of being deleted; history and
//     replacement chains are preserved;
//   - the staff scan lookup is lifecycle-independent and resolves the
//     CURRENT owner through the canonical ownership projection;
//   - every mutation leaves an audit_events row.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  assignMicrochip,
  closeMicrochip,
  correctMicrochip,
  getCurrentMicrochip,
  listChipConflicts,
  listMicrochipsForAnimal,
  lookupChip,
  replaceMicrochip,
  resolveChipConflict,
} from "@/lib/registry/microchips";
import {
  linkCaseToAnimal,
  listCasesForAnimal,
  listUpdatesForCase,
  openFoundCase,
  openMissingCase,
  resolveCase,
} from "@/lib/registry/lost-found";
import { searchAnimals } from "@/lib/registry/animals";
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
    sql`TRUNCATE lost_found_updates, lost_found_cases, communications, microchip_conflicts, microchip_records, ownerships, household_members, households, persons, animals, audit_events CASCADE`,
  );
});

const STAFF = "volunteer@sfpca.example";

let seq = 0;
async function seedAnimal(name?: string, lifecycleStatus = "active") {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: name ?? `Found-${++seq}`,
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

async function auditActions(entityType: string) {
  const rows = await db
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityType, entityType));
  return rows.map((r) => r.action);
}

describe("microchip assignment", () => {
  test("assign stores the normalized number + as-entered display", async () => {
    const animal = await seedAnimal("Rex");
    const result = await assignMicrochip(
      {
        animalId: animal.id,
        chipNumber: " 985-112-345-678-901 ",
        manufacturer: "Datamars",
        implantedOn: "2024-03-01",
        implantedBy: "Island Vet",
      },
      STAFF,
      db,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.chipNumber).toBe("985112345678901");
    expect(result.record.chipDisplay).toBe("985-112-345-678-901");
    expect(result.record.assignedTo).toBeNull();
    expect(result.record.manufacturer).toBe("Datamars");

    const current = await getCurrentMicrochip(animal.id, db);
    expect(current?.id).toBe(result.record.id);
    expect(await auditActions("microchip")).toContain("assign");
  });

  test("a second current chip for the same animal is refused", async () => {
    const animal = await seedAnimal();
    await assignMicrochip({ animalId: animal.id, chipNumber: "1111" }, STAFF, db);
    const second = await assignMicrochip(
      { animalId: animal.id, chipNumber: "2222" },
      STAFF,
      db,
    );
    expect(second).toMatchObject({ ok: false, reason: "has-current" });
  });

  test("duplicate claim on another animal is rejected AND flagged", async () => {
    const holder = await seedAnimal("Holder");
    const claimant = await seedAnimal("Claimant");
    await assignMicrochip(
      { animalId: holder.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );

    const dup = await assignMicrochip(
      // Different formatting, same chip — normalization catches it.
      { animalId: claimant.id, chipNumber: "985 112 345 678 901" },
      STAFF,
      db,
    );
    expect(dup).toMatchObject({ ok: false, reason: "chip-conflict" });
    if (dup.ok || !dup.chipConflict) throw new Error("expected conflict info");
    expect(dup.chipConflict.holderAnimalId).toBe(holder.id);
    expect(dup.chipConflict.holderAnimalName).toBe("Holder");

    // The chip never moved — the holder still owns the number.
    const holderChips = await listMicrochipsForAnimal(holder.id, db);
    expect(holderChips).toHaveLength(1);
    expect(holderChips[0].assignedTo).toBeNull();
    expect(await listMicrochipsForAnimal(claimant.id, db)).toHaveLength(0);

    // The flagged conflict is open evidence for human resolution.
    const conflicts = await listChipConflicts({ animalId: claimant.id }, db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe("open");
    expect(conflicts[0].existingAnimalId).toBe(holder.id);
    expect(await auditActions("microchip_conflict")).toContain("flag");

    // A repeat attempt re-flags the same work item, not a new row.
    const dup2 = await assignMicrochip(
      { animalId: claimant.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );
    expect(dup2).toMatchObject({ ok: false, reason: "chip-conflict" });
    expect(await listChipConflicts({ animalId: claimant.id }, db)).toHaveLength(1);
  });

  test("the database itself rejects a second active row for a chip", async () => {
    const a = await seedAnimal();
    const b = await seedAnimal();
    await db.insert(schema.microchipRecords).values({
      animalId: a.id,
      chipNumber: "ABC123",
      assignedFrom: "2025-01-01",
    });
    // Straight SQL — no service guard. The partial unique index is the
    // last line of defense under concurrency.
    await expect(
      db.insert(schema.microchipRecords).values({
        animalId: b.id,
        chipNumber: "ABC123",
        assignedFrom: "2025-02-01",
      }),
    ).rejects.toThrow();
    // And one animal cannot hold two current chips either.
    await expect(
      db.insert(schema.microchipRecords).values({
        animalId: a.id,
        chipNumber: "XYZ999",
        assignedFrom: "2025-02-01",
      }),
    ).rejects.toThrow();
  });

  test("invalid input is refused before any write", async () => {
    const animal = await seedAnimal();
    for (const chipNumber of ["", "ab", "x".repeat(40)]) {
      const result = await assignMicrochip(
        { animalId: animal.id, chipNumber },
        STAFF,
        db,
      );
      expect(result).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(
      await assignMicrochip(
        { animalId: "not-a-uuid", chipNumber: "1234" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("current vs historical chips", () => {
  test("replacement closes the old record with a successor link", async () => {
    const animal = await seedAnimal();
    const first = await assignMicrochip(
      { animalId: animal.id, chipNumber: "1111", assignedFrom: "2024-01-01" },
      STAFF,
      db,
    );
    if (!first.ok) throw new Error("setup");

    const second = await replaceMicrochip(
      first.record.id,
      { chipNumber: "2222", effectiveOn: "2025-06-01" },
      STAFF,
      db,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const chips = await listMicrochipsForAnimal(animal.id, db);
    expect(chips).toHaveLength(2);
    const [cur, old] = chips; // current first
    expect(cur.id).toBe(second.record.id);
    expect(cur.assignedTo).toBeNull();
    expect(old.id).toBe(first.record.id);
    expect(old.assignedTo).toBe("2025-06-01");
    expect(old.closedReason).toBe("replaced");
    expect(old.replacedById).toBe(second.record.id);
    expect(await auditActions("microchip")).toContain("replace");
  });

  test("replacing with the SAME number is refused — correct instead", async () => {
    const animal = await seedAnimal();
    const first = await assignMicrochip(
      { animalId: animal.id, chipNumber: "985 112 345" },
      STAFF,
      db,
    );
    if (!first.ok) throw new Error("setup");
    const same = await replaceMicrochip(
      first.record.id,
      { chipNumber: "985112345" },
      STAFF,
      db,
    );
    expect(same).toMatchObject({ ok: false, field: "chipNumber" });
  });

  test("close without successor keeps the row as history", async () => {
    const animal = await seedAnimal();
    const first = await assignMicrochip(
      { animalId: animal.id, chipNumber: "1111", assignedFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!first.ok) throw new Error("setup");
    const closed = await closeMicrochip(
      first.record.id,
      { reason: "removed", assignedTo: "2025-09-01" },
      STAFF,
      db,
    );
    expect(closed.ok).toBe(true);
    expect(await getCurrentMicrochip(animal.id, db)).toBeNull();
    const chips = await listMicrochipsForAnimal(animal.id, db);
    expect(chips[0].closedReason).toBe("removed");
    expect(chips[0].assignedTo).toBe("2025-09-01");
    // Double-close is a conflict, not a silent no-op.
    expect(
      await closeMicrochip(first.record.id, { reason: "removed" }, STAFF, db),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("correction edits in place — no fake replacement event", async () => {
    const animal = await seedAnimal();
    const first = await assignMicrochip(
      { animalId: animal.id, chipNumber: "985-112-345" },
      STAFF,
      db,
    );
    if (!first.ok) throw new Error("setup");

    const corrected = await correctMicrochip(
      first.record.id,
      { chipNumber: "985 112 346" },
      first.record.createdAt,
      STAFF,
      db,
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.record.id).toBe(first.record.id);
    expect(corrected.record.chipNumber).toBe("985112346");
    expect(corrected.record.assignedTo).toBeNull();
    // Still exactly one record — history was not fabricated.
    expect(await listMicrochipsForAnimal(animal.id, db)).toHaveLength(1);
    expect(await auditActions("microchip")).toContain("correct");

    // A stale createdAt token (another edit landed meanwhile) → conflict.
    const stale = await correctMicrochip(
      first.record.id,
      { chipNumber: "985112347" },
      "2020-01-01T00:00:00.000Z",
      STAFF,
      db,
    );
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("correcting a chip number onto a held number flags a conflict", async () => {
    const holder = await seedAnimal();
    const animal = await seedAnimal();
    await assignMicrochip(
      { animalId: holder.id, chipNumber: "1111" },
      STAFF,
      db,
    );
    const mine = await assignMicrochip(
      { animalId: animal.id, chipNumber: "2222" },
      STAFF,
      db,
    );
    if (!mine.ok) throw new Error("setup");
    const bad = await correctMicrochip(
      mine.record.id,
      { chipNumber: "1111" },
      mine.record.createdAt,
      STAFF,
      db,
    );
    expect(bad).toMatchObject({ ok: false, reason: "chip-conflict" });
  });

  test("multiple historical chips are all preserved and ordered", async () => {
    const animal = await seedAnimal();
    const c1 = await assignMicrochip(
      { animalId: animal.id, chipNumber: "1111", assignedFrom: "2020-01-01" },
      STAFF,
      db,
    );
    if (!c1.ok) throw new Error("setup");
    const c2 = await replaceMicrochip(
      c1.record.id,
      { chipNumber: "2222", effectiveOn: "2021-01-01" },
      STAFF,
      db,
    );
    if (!c2.ok) throw new Error("setup");
    const c3 = await replaceMicrochip(
      c2.record.id,
      { chipNumber: "3333", effectiveOn: "2022-01-01" },
      STAFF,
      db,
    );
    if (!c3.ok) throw new Error("setup");

    const chips = await listMicrochipsForAnimal(animal.id, db);
    expect(chips.map((c) => c.chipNumber)).toEqual(["3333", "2222", "1111"]);
    expect(chips[1].replacedById).toBe(c3.record.id);
    expect(chips[2].replacedById).toBe(c2.record.id);
  });
});

describe("chip conflicts", () => {
  test("resolve marks the work item done; re-resolve is a conflict", async () => {
    const holder = await seedAnimal();
    const claimant = await seedAnimal();
    await assignMicrochip({ animalId: holder.id, chipNumber: "9999" }, STAFF, db);
    const dup = await assignMicrochip(
      { animalId: claimant.id, chipNumber: "9999" },
      STAFF,
      db,
    );
    if (dup.ok || !dup.chipConflict) throw new Error("setup");

    const resolved = await resolveChipConflict(
      dup.chipConflict.conflictId,
      { resolutionNote: "Claimant record was the typo — corrected." },
      STAFF,
      db,
    );
    expect(resolved).toMatchObject({ ok: true });
    const conflicts = await listChipConflicts(
      { animalId: claimant.id, status: "all" },
      db,
    );
    expect(conflicts[0].status).toBe("resolved");
    expect(conflicts[0].resolutionNote).toContain("typo");
    expect(await auditActions("microchip_conflict")).toContain("resolve");
    expect(
      await resolveChipConflict(dup.chipConflict.conflictId, {}, STAFF, db),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });
});

describe("lookupChip — the found-animal read", () => {
  test("exact normalized match; formatted scanner input works", async () => {
    const animal = await seedAnimal("Buddy");
    await assignMicrochip(
      { animalId: animal.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );
    // What a scanner or clipboard actually delivers.
    const result = await lookupChip(" 985-112-345-678-901 ", db);
    expect(result.status).toBe("match");
    if (result.status !== "match") return;
    expect(result.animal.id).toBe(animal.id);
    expect(result.animal.name).toBe("Buddy");
    expect(result.animal.registryRef).toMatch(/^SFPCA-/);
    expect(result.animal.lifecycleStatus).toBe("active");
    expect(result.chip.assignedTo).toBeNull();
    expect(result.owners).toEqual([]);
    expect(result.ownershipAmbiguous).toBe(false);
  });

  test("unknown chip → not-found with the normalized number", async () => {
    const result = await lookupChip("985-000-000", db);
    expect(result.status).toBe("not-found");
    if (result.status !== "not-found") return;
    expect(result.normalized).toBe("985000000");
    expect(result.display).toBe("985-000-000");
  });

  test("implausible input → invalid, no lookup", async () => {
    expect(await lookupChip("??", db)).toMatchObject({ status: "invalid" });
    expect(await lookupChip("ab", db)).toMatchObject({ status: "invalid" });
  });

  test("a replaced chip still identifies the animal — and says so", async () => {
    const animal = await seedAnimal();
    const c1 = await assignMicrochip(
      { animalId: animal.id, chipNumber: "1111" },
      STAFF,
      db,
    );
    if (!c1.ok) throw new Error("setup");
    const c2 = await replaceMicrochip(
      c1.record.id,
      { chipNumber: "2222" },
      STAFF,
      db,
    );
    if (!c2.ok) throw new Error("setup");

    const result = await lookupChip("1111", db);
    expect(result.status).toBe("match");
    if (result.status !== "match") return;
    expect(result.chip.id).toBe(c1.record.id);
    expect(result.chip.assignedTo).not.toBeNull();
    // The current chip is surfaced so staff know the animal rechipped.
    expect(result.currentChip?.id).toBe(c2.record.id);
  });

  test("lifecycle does not suppress lookup — deceased and moved-off match", async () => {
    const deceased = await seedAnimal("Old Girl", "deceased");
    const moved = await seedAnimal("Traveler", "moved-off-saba");
    await assignMicrochip(
      { animalId: deceased.id, chipNumber: "1001" },
      STAFF,
      db,
    );
    await assignMicrochip({ animalId: moved.id, chipNumber: "1002" }, STAFF, db);

    for (const [chip, animal, status] of [
      ["1001", deceased, "deceased"],
      ["1002", moved, "moved-off-saba"],
    ] as const) {
      const result = await lookupChip(chip, db);
      expect(result.status).toBe("match");
      if (result.status !== "match") continue;
      expect(result.animal.id).toBe(animal.id);
      expect(result.animal.lifecycleStatus).toBe(status);
    }
  });

  test("person owner resolves with contact details", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson("Sam Walker", {
      phone: "+599-416-0001",
      email: "sam@example.com",
    });
    const own = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");
    await assignMicrochip({ animalId: animal.id, chipNumber: "7777" }, STAFF, db);

    const result = await lookupChip("7777", db);
    if (result.status !== "match") throw new Error("expected match");
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0].kind).toBe("person");
    expect(result.owners[0].name).toBe("Sam Walker");
    expect(result.owners[0].contacts[0]).toMatchObject({
      phone: "+599-416-0001",
      email: "sam@example.com",
    });
    expect(result.ownershipAmbiguous).toBe(false);
  });

  test("household owner resolves through members, primary first", async () => {
    const animal = await seedAnimal();
    const [household] = await db
      .insert(schema.households)
      .values({ name: "The Fort Bay Family", address: "Fort Bay Rd 3" })
      .returning();
    const primary = await seedPerson("Pat Primary", {
      phone: "+599-416-0002",
    });
    const member = await seedPerson("Chris Member", {
      email: "chris@example.com",
    });
    await setHouseholdMember(household.id, member.id, "member", STAFF, db);
    await setHouseholdMember(household.id, primary.id, "primary", STAFF, db);
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
    await assignMicrochip({ animalId: animal.id, chipNumber: "8888" }, STAFF, db);

    const result = await lookupChip("8888", db);
    if (result.status !== "match") throw new Error("expected match");
    expect(result.owners).toHaveLength(1);
    const owner = result.owners[0];
    expect(owner.kind).toBe("household");
    expect(owner.name).toBe("The Fort Bay Family");
    expect(owner.householdAddress).toBe("Fort Bay Rd 3");
    expect(owner.contacts.map((c) => c.name)).toEqual([
      "Pat Primary",
      "Chris Member",
    ]);
    expect(owner.contacts[0].role).toBe("primary");
  });

  test("multiple current ownerships are flagged ambiguous, not guessed", async () => {
    const animal = await seedAnimal();
    const p1 = await seedPerson("Owner One");
    const p2 = await seedPerson("Owner Two");
    await createOwnership(
      { animalId: animal.id, personId: p1.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await createOwnership(
      { animalId: animal.id, personId: p2.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await assignMicrochip({ animalId: animal.id, chipNumber: "9001" }, STAFF, db);

    const result = await lookupChip("9001", db);
    if (result.status !== "match") throw new Error("expected match");
    // Both are shown — but flagged so staff verify rather than picking.
    expect(result.owners).toHaveLength(2);
    expect(result.ownershipAmbiguous).toBe(true);
  });

  test("owner with no contact details is explicit, not hidden", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson("No Details");
    await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    await assignMicrochip({ animalId: animal.id, chipNumber: "9002" }, STAFF, db);

    const result = await lookupChip("9002", db);
    if (result.status !== "match") throw new Error("expected match");
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0].contacts[0].phone).toBeNull();
    expect(result.owners[0].contacts[0].email).toBeNull();
  });

  test("open chip conflicts ride along on the match", async () => {
    const holder = await seedAnimal();
    const claimant = await seedAnimal();
    await assignMicrochip({ animalId: holder.id, chipNumber: "9100" }, STAFF, db);
    await assignMicrochip({ animalId: claimant.id, chipNumber: "9100" }, STAFF, db);

    const result = await lookupChip("9100", db);
    if (result.status !== "match") throw new Error("expected match");
    expect(result.openConflicts).toHaveLength(1);
    expect(result.openConflicts[0].existingAnimalId).toBe(holder.id);
    expect(result.openConflicts[0].claimedAnimalId).toBe(claimant.id);
  });
});

// Lost/found cases (#176) — the chip-scan workflow's case semantics.
// Full case-model coverage lives in lost-found.test.ts; these tests pin
// the scan-side contract that used to live on found_reports.
describe("found cases", () => {
  test("open case records the scan; re-scan folds into it", async () => {
    const animal = await seedAnimal();
    const r1 = await openFoundCase(
      { animalId: animal.id, chipNumber: "985 112 345" },
      STAFF,
      db,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.case.status).toBe("open");
    expect(r1.case.caseType).toBe("found");
    expect(r1.case.chipNumber).toBe("985112345");

    const r2 = await openFoundCase(
      { animalId: animal.id, chipNumber: "985112345" },
      STAFF,
      db,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.existing).toBe(true);
    expect(r2.case.id).toBe(r1.case.id);
    // The rescan is chronology, not a second case.
    const updates = await listUpdatesForCase(r1.case.id, db);
    expect(updates.some((u) => u.kind === "scan")).toBe(true);
    expect(await auditActions("lost_found_case")).toContain("create");
  });

  test("an unknown chip scan creates an unmatched case — no animal", async () => {
    const r = await openFoundCase({ chipNumber: "555000" }, STAFF, db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.case.animalId).toBeNull();
    expect(r.case.status).toBe("open");
    expect(r.case.caseType).toBe("found");
  });

  test("a scan of a MISSING animal lands on the missing case", async () => {
    const animal = await seedAnimal();
    const missing = await openMissingCase({ animalId: animal.id }, STAFF, db);
    if (!missing.ok) throw new Error("setup");

    const scan = await openFoundCase(
      { animalId: animal.id, chipNumber: "7777" },
      STAFF,
      db,
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.matchedMissing).toBe(true);
    // No second case — the scan is evidence on the missing case.
    expect(scan.case.id).toBe(missing.case.id);
    const updates = await listUpdatesForCase(missing.case.id, db);
    expect(updates.some((u) => u.kind === "scan")).toBe(true);
  });

  test("record with outcome writes an immediately-resolved case", async () => {
    const animal = await seedAnimal();
    const r = await openFoundCase(
      {
        animalId: animal.id,
        chipNumber: "4444",
        outcome: "reunited",
        notes: "Owner fetched her at the gate.",
      },
      STAFF,
      db,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.case.status).toBe("resolved");
    expect(r.case.outcome).toBe("reunited");
    expect(r.case.resolvedAt).not.toBeNull();
  });

  test("resolve closes an open case once", async () => {
    const animal = await seedAnimal();
    const r = await openFoundCase(
      { animalId: animal.id, chipNumber: "3333" },
      STAFF,
      db,
    );
    if (!r.ok) throw new Error("setup");
    const resolved = await resolveCase(
      r.case.id,
      { outcome: "in-care", resolutionNote: "At the vet clinic overnight." },
      STAFF,
      db,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.case.status).toBe("resolved");
    expect(resolved.case.outcome).toBe("in-care");

    // Resolving twice is rejected — the record is history now.
    expect(
      await resolveCase(r.case.id, { outcome: "reunited" }, STAFF, db),
    ).toMatchObject({ ok: false });
    expect(await auditActions("lost_found_case")).toContain("resolve");
  });

  test("an unmatched case links to a registry animal, preserving origin", async () => {
    const animal = await seedAnimal();
    const r = await openFoundCase({ chipNumber: "8080" }, STAFF, db);
    if (!r.ok) throw new Error("setup");

    const linked = await linkCaseToAnimal(r.case.id, animal.id, STAFF, db);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.case.animalId).toBe(animal.id);
    // linked_at is the durable "began unmatched" evidence.
    expect(linked.case.linkedAt).not.toBeNull();
    expect(linked.case.linkedBy).toBe(STAFF);
  });

  test("animal profile history lists cases, open first", async () => {
    const animal = await seedAnimal();
    // An open found case on the animal swallows the next scan (that's
    // the dedupe) — so a second distinct case needs the first closed.
    const first = await openFoundCase(
      { animalId: animal.id, chipNumber: "121212" },
      STAFF,
      db,
    );
    if (!first.ok) throw new Error("setup");
    await resolveCase(first.case.id, { outcome: "reunited" }, STAFF, db);
    await openFoundCase({ animalId: animal.id, chipNumber: "131313" }, STAFF, db);
    const cases = await listCasesForAnimal(animal.id, db);
    expect(cases).toHaveLength(2);
    expect(cases[0].status).toBe("open");
    expect(cases[1].status).toBe("resolved");
  });

  test("invalid outcome is rejected", async () => {
    const animal = await seedAnimal();
    expect(
      await openFoundCase(
        { animalId: animal.id, chipNumber: "6666", outcome: "vanished" },
        STAFF,
        db,
      ),
    ).toMatchObject({ ok: false, field: "outcome" });
  });
});

describe("registry search integration", () => {
  test("search normalizes chip input through the canonical function", async () => {
    const animal = await seedAnimal("Chipper");
    await assignMicrochip(
      { animalId: animal.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );
    // Formatted as a scanner/person might type it — same hit as the
    // dedicated lookup would produce.
    const hits = await searchAnimals("985-112-345-678-901", {}, db);
    expect(hits.map((h) => h.animal.id)).toContain(animal.id);
    // Prefix semantics — a partial chip typed left-to-right still hits.
    const partial = await searchAnimals("985112345", {}, db);
    expect(partial.map((h) => h.animal.id)).toContain(animal.id);
    const hit = hits.find((h) => h.animal.id === animal.id)!;
    expect(hit.microchips).toContain("985112345678901");
  });
});
