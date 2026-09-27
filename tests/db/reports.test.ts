// Reporting metric tests (#179) against PGlite — real Postgres
// semantics for the aggregates the staff workspace, public statistics,
// and CSV export all derive. The properties under test are the issue's
// invariants:
//   - merged identities never count as animals;
//   - deceased/moved-off-saba leave the active population;
//   - submissions are intake, never registrations;
//   - payment state comes from the confirmed ledger — pending money
//     never settles, refunds subtract;
//   - latest-dose-per-series is the only vaccination authority;
//   - current chips only — a replaced chip is not coverage;
//   - the public DTO carries no PII and enforces small-cell suppression;
//   - exports reuse the same canonical numbers and are formula-safe.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  buildExportCsv,
  getHealthReport,
  getLifecycleTrend,
  getPopulationReport,
  getPublicStats,
  getRegistrationPeriodReport,
  getStaffReport,
  getWorkloadTrend,
  normalizeReportParams,
} from "@/lib/registry/reports";
import {
  cancelRegistration,
  createRegistration,
  recordRegistrationPayment,
  resolveRegistrationFee,
} from "@/lib/registry/registrations";
import { refundPayment } from "@/lib/registry/payments";
import { assignMicrochip, closeMicrochip } from "@/lib/registry/microchips";
import { createVaccination } from "@/lib/registry/vaccinations";
import { createOwnership } from "@/lib/registry/ownership";

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
    sql`TRUNCATE lost_found_updates, lost_found_cases, communications, ownership_confirmations, payments, payment_events, registrations, registration_submissions, microchip_conflicts, microchip_records, vet_procedures, vet_encounters, vaccinations, follow_ups, clinic_expectations, owner_requests, ownerships, animal_lifecycle_events, household_members, households, persons, auth_identities, animals, audit_events CASCADE`,
  );
});

const STAFF = "reports@test.dev";
// Fixed as-of so due-state and age-band math are deterministic.
const AS_OF = "2026-06-15";
const YEAR = 2026;

let seq = 0;
async function seedAnimal(
  opts: Partial<typeof schema.animals.$inferInsert> = {},
) {
  const [animal] = await db
    .insert(schema.animals)
    .values({
      name: `Animal-${++seq}`,
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      sterilizationStatus: "unknown",
      ...opts,
    })
    .returning();
  return animal;
}

async function seedPerson(fullName = "Jane Owner") {
  const [person] = await db
    .insert(schema.persons)
    .values({ fullName })
    .returning();
  return person;
}

async function seedRegisteredAnimal(
  opts: Parameters<typeof seedAnimal>[0] = {},
  year = YEAR,
  amountDueCents = 3000,
) {
  const animal = await seedAnimal(opts);
  const res = await createRegistration(
    { animalId: animal.id, year, amountDueCents },
    STAFF,
    db,
  );
  if (!res.ok) throw new Error(`registration setup failed`);
  return { animal, registration: res.registration };
}

async function insertLifecycleEvent(
  animalId: string,
  fromStatus: string | null,
  toStatus: string,
  effectiveOn: string,
) {
  await db.insert(schema.animalLifecycleEvents).values({
    animalId,
    fromStatus,
    toStatus,
    effectiveOn,
    source: "staff",
  });
}

// ---------------------------------------------------------------- population

describe("population metrics", () => {
  test("active known animals exclude deceased, departed, and merged", async () => {
    await seedAnimal({ species: "dog" });
    await seedAnimal({ species: "dog" });
    await seedAnimal({ species: "cat" });
    await seedAnimal({ lifecycleStatus: "deceased", species: "dog" });
    await seedAnimal({ lifecycleStatus: "moved-off-saba" });
    await seedAnimal({ lifecycleStatus: "unknown" });
    await seedAnimal({ lifecycleStatus: "merged" });

    const pop = await getPopulationReport(AS_OF, db);
    expect(pop.activeKnownAnimals).toBe(3);
    // Known = every non-merged durable record.
    expect(pop.knownAnimals).toBe(6);
    const lifecycle = Object.fromEntries(
      pop.lifecycle.map((l) => [l.key, l.count]),
    );
    expect(lifecycle).toEqual({
      active: 3,
      unknown: 1,
      deceased: 1,
      "moved-off-saba": 1,
    });
    // Species counts the ACTIVE population only.
    const species = Object.fromEntries(
      pop.speciesAmongActive.map((s) => [s.key, s.count]),
    );
    expect(species).toEqual({ dog: 2, cat: 1, other: 0 });
  });

  test("current-ownership coverage respects interval bounds", async () => {
    const owned = await seedAnimal();
    const closed = await seedAnimal();
    const stray = await seedAnimal();
    const person = await seedPerson();

    const open = await createOwnership(
      {
        animalId: owned.id,
        personId: person.id,
        validFrom: "2025-01-01",
      },
      STAFF,
      db,
    );
    if (!open.ok) throw new Error("setup");
    const past = await createOwnership(
      {
        animalId: closed.id,
        personId: person.id,
        validFrom: "2020-01-01",
        validTo: "2021-01-01",
      },
      STAFF,
      db,
    );
    if (!past.ok) throw new Error("setup");

    const pop = await getPopulationReport(AS_OF, db);
    expect(pop.withCurrentOwner).toBe(1);
    expect(pop.withoutCurrentOwner).toBe(2);
    void stray;
  });

  test("age bands assign by canonical month math; unknown stays visible", async () => {
    await seedAnimal({ birthDate: "2026-05-01" }); // ~1 month → under-1
    await seedAnimal({ birthDate: "2024-06-15", birthDateEstimated: true });
    await seedAnimal({ birthDate: null });
    await seedAnimal({ birthDate: "2099-01-01" }); // future → unknown

    const pop = await getPopulationReport(AS_OF, db);
    const bands = Object.fromEntries(
      pop.ageBandsAmongActive.map((b) => [b.key, b.count]),
    );
    expect(bands["under-1"]).toBe(1);
    expect(bands["1-3"]).toBe(1); // ~2 years
    expect(bands["unknown"]).toBe(2); // null + impossible date
    expect(pop.estimatedBirthDates).toBe(1);
  });
});

// -------------------------------------------------------------- registration

describe("registration period metrics", () => {
  test("period counts follow #169 semantics; submissions never count", async () => {
    const { registration: keep } = await seedRegisteredAnimal();
    const { registration: cancel } = await seedRegisteredAnimal();
    await seedRegisteredAnimal({}, 2025); // other period — not counted
    // An intake submission is NOT a registration.
    await db.insert(schema.registrationSubmissions).values({
      ownerName: "Submitter",
      status: "pending",
    });

    await cancelRegistration(
      cancel.id,
      { reason: "correction", note: "wrong year entered" },
      STAFF,
      db,
    );

    const reg = await getRegistrationPeriodReport(YEAR, db);
    expect(reg.rowsForPeriod).toBe(2);
    expect(reg.active).toBe(1);
    expect(reg.cancelledCorrection).toBe(1);
    expect(reg.cancelledWithdrawn).toBe(0);
    expect(reg.uniqueAnimalsRegistered).toBe(1);
    void keep;
  });

  test("registration denominator uses eligible lifecycles and history", async () => {
    // Eligible = active + unknown.
    const active1 = await seedRegisteredAnimal();
    const unknown = await seedRegisteredAnimal({ lifecycleStatus: "unknown" });
    const unregistered = await seedAnimal();
    // Registered this year but since deceased: historical registration
    // stays in uniqueAnimalsRegistered but leaves the eligible set.
    const deceased = await seedRegisteredAnimal();
    await db
      .update(schema.animals)
      .set({ lifecycleStatus: "deceased" })
      .where(eq(schema.animals.id, deceased.animal.id));

    const reg = await getRegistrationPeriodReport(YEAR, db);
    expect(reg.uniqueAnimalsRegistered).toBe(3);
    expect(reg.eligibleAnimals).toBe(3); // active, unknown, unregistered
    expect(reg.eligibleRegistered).toBe(2); // deceased animal not eligible
    expect(reg.eligibleUnregistered).toBe(1);
    expect(reg.registeredPct).toBe(67); // 2/3 → round
    void active1;
    void unknown;
    void unregistered;
  });

  test("payment states derive from the ledger — pending never settles", async () => {
    const paid = await seedRegisteredAnimal({}, YEAR, 3000);
    const partial = await seedRegisteredAnimal({}, YEAR, 3000);
    const unpaid = await seedRegisteredAnimal({}, YEAR, 3000);
    const pendingOnly = await seedRegisteredAnimal({}, YEAR, 3000);
    const waived = await seedRegisteredAnimal({}, YEAR, 3000);
    const comp = await seedRegisteredAnimal({}, YEAR, 3000);
    const noFee = await seedRegisteredAnimal({}, YEAR, 0);

    await recordRegistrationPayment(
      paid.registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );
    await recordRegistrationPayment(
      partial.registration.id,
      { amountCents: 1500, method: "cash" },
      STAFF,
      db,
    );
    const pend = await recordRegistrationPayment(
      pendingOnly.registration.id,
      { amountCents: 3000, method: "bank-transfer", pending: true },
      STAFF,
      db,
    );
    if (!pend.ok) throw new Error("setup");
    await resolveRegistrationFee(
      waived.registration.id,
      { resolution: "waived" },
      STAFF,
      db,
    );
    await resolveRegistrationFee(
      comp.registration.id,
      { resolution: "complimentary" },
      STAFF,
      db,
    );

    const reg = await getRegistrationPeriodReport(YEAR, db);
    const byState = Object.fromEntries(
      reg.payments.byState.map((s) => [s.state, s.count]),
    );
    expect(byState).toEqual({
      paid: 1,
      partial: 1,
      unpaid: 2, // includes the pending-money registration
      waived: 1,
      complimentary: 1,
      "no-fee": 1,
    });
    // Financially resolved = paid + waived + complimentary + no-fee.
    expect(reg.payments.resolved).toBe(4);
    expect(reg.payments.resolvedPct).toBe(57); // 4/7
    expect(reg.payments.assessedCents).toBe(18000);
    expect(reg.payments.settledCents).toBe(4500);
    // unpaid (3000) + partial remainder (1500) + pending-only (3000).
    expect(reg.payments.outstandingCents).toBe(7500);
    // In-flight money is surfaced separately — it did not settle.
    expect(reg.payments.pendingCents).toBe(3000);
    void unpaid;
    void noFee;
  });

  test("refunds subtract from settled money; cancelled rows are DQ context", async () => {
    const { registration } = await seedRegisteredAnimal({}, YEAR, 3000);
    const pay = await recordRegistrationPayment(
      registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );
    if (!pay.ok) throw new Error("setup");
    await refundPayment(
      pay.paymentId,
      { amountCents: 1000, reason: "Overcharged" },
      STAFF,
      db,
    );

    const cancelled = await seedRegisteredAnimal({}, YEAR, 3000);
    const cPay = await recordRegistrationPayment(
      cancelled.registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );
    if (!cPay.ok) throw new Error("setup");
    await cancelRegistration(
      cancelled.registration.id,
      { reason: "withdrawn", note: "owner declined" },
      STAFF,
      db,
    );

    const reg = await getRegistrationPeriodReport(YEAR, db);
    // 3000 received − 1000 refunded = 2000 settled → partial.
    expect(reg.payments.settledCents).toBe(2000);
    expect(reg.payments.byState.find((s) => s.state === "partial")!.count).toBe(
      1,
    );
    // The cancelled row's money never enters the active buckets.
    expect(reg.payments.cancelledWithMoney).toBe(1);
    expect(reg.payments.moneyOnCancelledCents).toBe(3000);
    expect(reg.active).toBe(1);
  });
});

// -------------------------------------------------------------------- health

describe("health & identification metrics", () => {
  test("sterilization counts only active animals; unknown is explicit", async () => {
    await seedAnimal({ sterilizationStatus: "sterilized" });
    await seedAnimal({ sterilizationStatus: "intact" });
    await seedAnimal({ sterilizationStatus: "unknown" });
    await seedAnimal({
      sterilizationStatus: "sterilized",
      lifecycleStatus: "deceased",
    });

    const health = await getHealthReport(AS_OF, db);
    const st = Object.fromEntries(
      health.sterilizationAmongActive.map((s) => [s.key, s.count]),
    );
    expect(st).toEqual({ sterilized: 1, intact: 1, unknown: 1 });
    expect(health.sterilizedPct).toBe(33); // denominator includes unknown
  });

  test("microchip coverage counts current chips only; conflicts surface", async () => {
    const chipped = await seedAnimal();
    const closedChip = await seedAnimal();
    const bare = await seedAnimal();

    await assignMicrochip(
      { animalId: chipped.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );
    const second = await assignMicrochip(
      { animalId: closedChip.id, chipNumber: "985112345678902" },
      STAFF,
      db,
    );
    if (!second.ok || !("record" in second)) throw new Error("setup");
    await closeMicrochip(
      second.record.id,
      { reason: "removed" },
      STAFF,
      db,
    );
    // Duplicate claim on a third party → open conflict, not a chip.
    const claimant = await seedAnimal();
    await assignMicrochip(
      { animalId: claimant.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );

    const health = await getHealthReport(AS_OF, db);
    expect(health.microchippedActive).toBe(1);
    expect(health.notMicrochippedActive).toBe(3); // closed + bare + claimant
    expect(health.openChipConflicts).toBe(1);
    void bare;
  });

  test("vaccination state uses latest dose per (animal, series)", async () => {
    const current = await seedAnimal();
    const overdue = await seedAnimal();
    const none = await seedAnimal();

    // Older superseded dose + newer current dose — history can't inflate.
    await createVaccination(
      {
        animalId: current.id,
        vaccineName: "Rabies",
        administeredOn: "2024-01-01",
        dueOn: "2025-01-01",
      },
      STAFF,
      db,
    );
    await createVaccination(
      {
        animalId: current.id,
        vaccineName: "Rabies",
        administeredOn: "2026-01-01",
        dueOn: "2030-01-01",
      },
      STAFF,
      db,
    );
    await createVaccination(
      {
        animalId: overdue.id,
        vaccineName: "Rabies",
        administeredOn: "2024-01-01",
        dueOn: "2025-01-01",
      },
      STAFF,
      db,
    );
    // A dose on a deceased animal never counts.
    const deceased = await seedAnimal({ lifecycleStatus: "deceased" });
    await createVaccination(
      {
        animalId: deceased.id,
        vaccineName: "Rabies",
        administeredOn: "2024-01-01",
        dueOn: "2025-01-01",
      },
      STAFF,
      db,
    );

    const health = await getHealthReport(AS_OF, db);
    const states = Object.fromEntries(
      health.vaccination.doseStates.map((s) => [s.state, s.count]),
    );
    expect(states.current).toBe(1);
    expect(states.overdue).toBe(1);
    expect(states["due-soon"]).toBe(0);
    expect(health.vaccination.animalsWithAnyRecord).toBe(2);
    expect(health.vaccination.animalsWithoutRecord).toBe(1);
    const rabies = health.vaccination.series.find(
      (s) => s.seriesKey === "rabies",
    )!;
    expect(rabies.animals).toBe(2);
    expect(rabies.current).toBe(1);
    expect(rabies.overdue).toBe(1);
    void none;
  });
});

// ------------------------------------------------------------------ trends

describe("lifecycle trend", () => {
  test("events bucket by effective_on; merges and corrections behave", async () => {
    const a = await seedAnimal();
    const b = await seedAnimal();
    const c = await seedAnimal();

    await insertLifecycleEvent(a.id, null, "active", "2025-03-01");
    await insertLifecycleEvent(b.id, null, "active", "2026-01-10");
    await insertLifecycleEvent(a.id, "active", "deceased", "2026-02-01");
    // A corrected double-transition still counts the animal once.
    await insertLifecycleEvent(a.id, "deceased", "deceased", "2026-02-02");
    await insertLifecycleEvent(b.id, "active", "moved-off-saba", "2026-04-01");
    // Merge retirement is an identity operation, not a loss.
    await insertLifecycleEvent(c.id, "active", "merged", "2026-05-01");
    await insertLifecycleEvent(c.id, null, "unknown", "2024-11-01");

    const trend = await getLifecycleTrend(db);
    const byYear = Object.fromEntries(trend.map((t) => [t.year, t]));
    expect(byYear[2024]).toMatchObject({ entered: 1 });
    expect(byYear[2025]).toMatchObject({ entered: 1 });
    expect(byYear[2026]).toMatchObject({
      entered: 1,
      deceased: 1, // distinct animal, not events
      movedOffSaba: 1,
    });
    // The merged retirement produced no loss: exactly one death and
    // one departure across all years.
    const losses = trend.reduce((s, t) => s + t.deceased + t.movedOffSaba, 0);
    expect(losses).toBe(2);
  });
});

describe("workload trend", () => {
  test("activity lands in the year the work happened", async () => {
    const animal = await seedAnimal();
    const person = await seedPerson();
    const own = await createOwnership(
      { animalId: animal.id, personId: person.id, validFrom: "2025-01-01" },
      STAFF,
      db,
    );
    if (!own.ok) throw new Error("setup");

    // A registration processed in 2026 for the 2026 period.
    const reg = await createRegistration(
      { animalId: animal.id, year: YEAR, amountDueCents: 3000 },
      STAFF,
      db,
    );
    if (!reg.ok) throw new Error("setup");
    await db
      .update(schema.registrations)
      .set({ registeredAt: new Date("2026-02-01T12:00:00Z") })
      .where(eq(schema.registrations.id, reg.registration.id));

    await db.insert(schema.lostFoundCases).values({
      caseType: "missing",
      animalId: animal.id,
      status: "resolved",
      outcome: "reunited",
      reportedAt: new Date("2026-03-01T10:00:00Z"),
      resolvedAt: new Date("2026-03-05T10:00:00Z"),
    });
    await db.insert(schema.communications).values({
      channel: "email",
      kind: "registration-due",
      status: "sent",
      sentAt: new Date("2026-04-01T10:00:00Z"),
      createdAt: new Date("2026-04-01T09:00:00Z"),
    });
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "Rabies",
        administeredOn: "2026-01-15",
      },
      STAFF,
      db,
    );
    await db.insert(schema.vetProcedures).values({
      animalId: animal.id,
      kind: "spay",
      performedOn: "2026-03-20",
      description: "Spay",
    });
    await db.insert(schema.vetEncounters).values({
      animalId: animal.id,
      kind: "visit",
      occurredOn: "2026-03-20",
      reason: "Spay",
    });
    await db.insert(schema.ownershipConfirmations).values({
      ownershipId: own.ownership.id,
      animalId: animal.id,
      personId: person.id,
      confirmedOn: "2026-05-01",
      method: "staff",
    });
    const chip = await assignMicrochip(
      { animalId: animal.id, chipNumber: "985112345678901" },
      STAFF,
      db,
    );
    if (!chip.ok) throw new Error("setup");

    const trend = await getWorkloadTrend(db);
    const y2026 = trend.find((t) => t.year === 2026)!;
    expect(y2026).toMatchObject({
      registrationsProcessed: 1,
      lostFoundOpened: 1,
      lostFoundResolved: 1,
      animalsReunited: 1,
      communicationsSent: 1,
      vaccinationsAdministered: 1,
      spayNeuterProcedures: 1,
      chipsAssigned: 1,
      annualConfirmations: 1,
      vetVisitsRecorded: 1,
    });
  });
});

// ---------------------------------------------------------------- composed

describe("composed staff report", () => {
  test("asOf/year normalization is deterministic and defensive", async () => {
    expect(normalizeReportParams({ year: 2025, asOf: "2026-01-05" })).toEqual({
      year: 2025,
      asOf: "2026-01-05",
    });
    // Bad inputs fall back — never crash the page on a hand-edited URL.
    const fallback = normalizeReportParams({
      year: Number.NaN,
      asOf: "nonsense",
    });
    expect(fallback.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fallback.year).toBeGreaterThanOrEqual(2000);
  });

  test("getStaffReport composes every section at the selected period", async () => {
    await seedRegisteredAnimal({}, YEAR);
    const report = await getStaffReport({ year: YEAR, asOf: AS_OF }, db);
    expect(report.year).toBe(YEAR);
    expect(report.asOf).toBe(AS_OF);
    expect(report.availableYears).toContain(YEAR);
    expect(report.population.activeKnownAnimals).toBe(1);
    expect(report.registration.uniqueAnimalsRegistered).toBe(1);
    expect(report.health.vaccination.animalsWithoutRecord).toBe(1);
  });
});

// ------------------------------------------------------------- public stats

describe("public statistics — anonymous DTO", () => {
  test("aggregates only: seeded PII never reaches the DTO", async () => {
    const animal = await seedAnimal({ name: "Secret Pet" });
    await db.insert(schema.persons).values({
      fullName: "Private Person",
      email: "secret@example.com",
      phone: "+599 555 0100",
    });
    await assignMicrochip(
      { animalId: animal.id, chipNumber: "CHIP777PRIVATE" },
      STAFF,
      db,
    );

    const stats = await getPublicStats({ asOf: AS_OF, year: YEAR }, db);
    const json = JSON.stringify(stats);
    for (const pii of [
      "Private Person",
      "secret@example.com",
      "555 0100",
      "CHIP777",
      "Secret Pet",
      animal.id,
    ]) {
      expect(json).not.toContain(pii);
    }
  });

  test("small cells are suppressed with complementary suppression", async () => {
    // 6 dogs + 1 cat: cat is below threshold; hiding only cat would let
    // total−dogs isolate it, so the smallest remaining cell hides too.
    for (let i = 0; i < 6; i++) await seedAnimal({ species: "dog" });
    await seedAnimal({ species: "cat" });

    const stats = await getPublicStats({ asOf: AS_OF, year: YEAR }, db);
    const byKey = Object.fromEntries(
      stats.speciesBreakdown.map((c) => [c.key, c]),
    );
    expect(byKey.cat).toMatchObject({ count: null, suppressed: true });
    // Complementary cell: 'other' (0) is the smallest survivor.
    expect(byKey.other.suppressed).toBe(true);
    // The suppressed true count never leaves the server.
    expect(JSON.stringify(stats.speciesBreakdown)).not.toContain('"count":1');
    expect(byKey.dog).toMatchObject({ count: 6, suppressed: false });
    expect(stats.activeKnownAnimals).toBe(7);
  });

  test("rates refuse small denominators; headline counts stay exact", async () => {
    for (let i = 0; i < 4; i++) {
      await seedAnimal({ sterilizationStatus: "sterilized" });
    }
    const stats = await getPublicStats({ asOf: AS_OF, year: YEAR }, db);
    expect(stats.activeKnownAnimals).toBe(4);
    // Denominator below the threshold → the rate is withheld entirely.
    expect(stats.sterilizedPct).toBeNull();
    expect(stats.microchippedPct).toBeNull();
    expect(stats.registeredPct).toBeNull();
  });
});

// ------------------------------------------------------------------- export

describe("CSV export", () => {
  test("period export matches the canonical numbers", async () => {
    const { registration } = await seedRegisteredAnimal({}, YEAR, 3000);
    await recordRegistrationPayment(
      registration.id,
      { amountCents: 3000, method: "cash" },
      STAFF,
      db,
    );

    const report = await getStaffReport({ year: YEAR, asOf: AS_OF }, db);
    const csv = buildExportCsv(report, "period");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("section,metric,value,denominator,period,as_of");
    expect(csv).toContain(
      `registration,unique_animals_registered,1,period ${YEAR},${YEAR},${AS_OF}`,
    );
    expect(csv).toContain(`payments,state_paid,1,`);
    expect(csv).toContain(`payments,settled_usd,30.00`);
  });

  test("free-text series labels cannot inject formulas into CSV", async () => {
    const animal = await seedAnimal();
    await createVaccination(
      {
        animalId: animal.id,
        vaccineName: "=HYPERLINK(\"https://evil.example\")",
        administeredOn: "2026-01-01",
        dueOn: "2030-01-01",
      },
      STAFF,
      db,
    );

    const report = await getStaffReport({ year: YEAR, asOf: AS_OF }, db);
    const csv = buildExportCsv(report, "overview");
    // The vaccine name flows into health_series metric labels — the
    // leading '=' must be apostrophe-escaped so no spreadsheet
    // evaluates it.
    expect(csv).not.toContain(",=HYPERLINK");
    // The apostrophe sits inside quotes because the label contains
    // quote characters — still impossible to evaluate as a formula.
    expect(csv).toContain(`,"'=HYPERLINK`);
  });

  test("trends export aligns lifecycle, registration, and workload years", async () => {
    const animal = await seedAnimal();
    await insertLifecycleEvent(animal.id, null, "active", "2025-06-01");
    await createRegistration(
      { animalId: animal.id, year: YEAR, amountDueCents: 0 },
      STAFF,
      db,
    );
    const report = await getStaffReport({ year: YEAR, asOf: AS_OF }, db);
    const csv = buildExportCsv(report, "trends");
    expect(lines(csv)[0]).toMatch(/^year,animals_entered_registry,/);
    expect(csv).toContain("2025,1,");
    function lines(s: string) {
      return s.split("\r\n");
    }
  });
});
