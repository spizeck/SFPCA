import "server-only";

// Reporting service (#179) — the canonical read layer behind
// /admin/reports, /statistics, and staff CSV export. Every metric is a
// typed function deriving from the authoritative relational data; pages
// never embed queries of their own.
//
// Definition discipline (see src/lib/reports.ts + ARCHITECTURE.md):
//   - POPULATION metrics describe current registry state: the registry
//     records CURRENT lifecycle, not history-at-a-date, so "active
//     known animals" is always "as of the report date", not "as of the
//     selected year". Period selection only scopes period metrics.
//   - PERIOD metrics are calendar-year (#169 semantics) or, for
//     workload/lifecycle history, grouped by the event's own real-world
//     date column (effective_on / reported_at / resolved_at / ...).
//   - Retired merge duplicates (lifecycle 'merged') are NEVER animals:
//     they are excluded from every animal count and listed only as the
//     transparency figure `mergedAliases`.
//   - Payment state comes from the #170 ledger projection
//     (deriveRegistrationBalance over moneyByRegistration) — never
//     re-implemented here.
//   - Vaccination state comes from the canonical latest-dose-per-series
//     read + vaccinationDueState — the same projection the reminder
//     evaluator uses, filtered to active animals only.

import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { getRegistryDb } from "../db/client";
import type { RegistryDb } from "./public-animals";
import {
  animalLifecycleEvents,
  animals,
  clinicExpectations,
  communications,
  followUps,
  lostFoundCases,
  microchipRecords,
  ownerRequests,
  ownershipConfirmations,
  registrationSubmissions,
  registrations,
  vaccinations,
  vetEncounters,
  vetProcedures,
} from "@/lib/db/schema";
import {
  currentRegistrationYear,
  isRegistrationYear,
  isRegistrationResolution,
  REGISTRATION_PAYMENT_STATES,
  type RegistrationPaymentState,
} from "@/lib/registrations";
import { REGISTRATION_ELIGIBLE_LIFECYCLES } from "@/lib/registry/registrations";
import {
  deriveRegistrationBalance,
  emptyLedgerAggregate,
} from "@/lib/payments";
import { moneyByRegistration } from "@/lib/registry/payments";
import { countOpenChipConflicts } from "@/lib/registry/microchips";
import { getOpenCaseCounts } from "@/lib/registry/lost-found";
import { countPendingOwnerRequests } from "@/lib/registry/owner-requests";
import {
  effectiveVaccinationDate,
  isIsoDateString,
  todayIsoDate,
  vaccinationDueState,
  type VaccinationDueState,
} from "@/lib/vaccinations";
import {
  ageBandFor,
  AGE_BAND_KEYS,
  AGE_BAND_LABELS,
  PUBLIC_SMALL_CELL_MIN,
  publicPercent,
  suppressSmallCells,
  toCsv,
  type AgeBandKey,
  type PublicBreakdownCell,
} from "@/lib/reports";


// --- Shared report shapes -------------------------------------------------------

export interface ReportParams {
  // Calendar-year registration period. Defaults to the period
  // containing asOf; invalid values fall back the same way.
  year?: number;
  // YYYY-MM-DD the report is generated for. Defaults to today (UTC).
  // Drives due-state classification and ownership-at-a-date; population
  // counts themselves describe CURRENT registry state.
  asOf?: string;
}

export function normalizeReportParams(input: ReportParams = {}): {
  year: number;
  asOf: string;
} {
  const asOf =
    input.asOf && isIsoDateString(input.asOf)
      ? input.asOf
      : todayIsoDate();
  return {
    asOf,
    year: isRegistrationYear(input.year)
      ? input.year
      : currentRegistrationYear(asOf),
  };
}

export interface CountByLabel {
  key: string;
  label: string;
  count: number;
}

export interface PopulationReport {
  // All non-merged registry animals — "animals known to SFPCA".
  knownAnimals: number;
  lifecycle: CountByLabel[];
  // lifecycle='active' only: the population every coverage metric uses.
  activeKnownAnimals: number;
  speciesAmongActive: CountByLabel[];
  // Active animals with an open ownership interval at asOf — "has a
  // recorded owner right now" (person OR household).
  withCurrentOwner: number;
  withoutCurrentOwner: number;
  ageBandsAmongActive: (CountByLabel & { key: AgeBandKey })[];
  // Active animals whose birth_date exists but is flagged approximate.
  estimatedBirthDates: number;
}

export interface RegistrationPeriodReport {
  year: number;
  // Every registrations row for the period (history included).
  rowsForPeriod: number;
  active: number;
  cancelledCorrection: number;
  cancelledWithdrawn: number;
  // Distinct animals with an ACTIVE row this period — includes animals
  // that have since died or left (the registration is historical fact).
  uniqueAnimalsRegistered: number;
  // Denominator for the registration rate: registration-eligible
  // animals = lifecycle 'active' or 'unknown' (canonical set from
  // registrations.ts) — the animals the annual program targets.
  eligibleAnimals: number;
  eligibleRegistered: number;
  eligibleUnregistered: number;
  registeredPct: number | null;
  payments: {
    // Active registrations of the period, bucketed by the canonical
    // derived payment state.
    byState: { state: RegistrationPaymentState; count: number }[];
    assessedCents: number;
    settledCents: number;
    outstandingCents: number;
    pendingCents: number;
    overpaidCents: number;
    // paid + waived + complimentary + no-fee — every active registration
    // whose obligation is settled or formally resolved.
    resolved: number;
    resolvedPct: number | null;
    // Cancelled rows still carrying confirmed/pending money — a data-
    // quality signal (money-on-cancelled is a #178 detector), not a debt.
    cancelledWithMoney: number;
    moneyOnCancelledCents: number;
  };
}

export interface TrendYear {
  year: number;
  active: number;
  cancelled: number;
  uniqueAnimals: number;
}

export interface VaccinationSeriesReport {
  seriesKey: string;
  // Display name: the vaccine_name of the most recent dose in the
  // series — free text in the source, so labelled descriptively.
  label: string;
  animals: number;
  current: number;
  dueSoon: number;
  overdue: number;
  unscheduled: number;
}

export interface HealthReport {
  sterilizationAmongActive: CountByLabel[];
  sterilizedPct: number | null;
  microchippedActive: number;
  notMicrochippedActive: number;
  microchipCoveragePct: number | null;
  openChipConflicts: number;
  vaccination: {
    // Denominator: active known animals.
    animalsWithAnyRecord: number;
    animalsWithoutRecord: number;
    // Latest dose per (animal, series) on active animals — historical
    // superseded doses never inflate these counts.
    doseStates: { state: VaccinationDueState; count: number }[];
    series: VaccinationSeriesReport[];
  };
}

export interface LifecycleTrendYear {
  year: number;
  // Animals whose FIRST registry event (from_status IS NULL) landed in
  // the year — "entered the registry".
  entered: number;
  // Non-entry transitions TO 'active' (corrections/confirmations).
  becameActive: number;
  // Distinct animals recorded deceased / moved off Saba in the year by
  // effective_on — real-world timing, not when staff typed it.
  deceased: number;
  movedOffSaba: number;
}

export interface WorkloadYear {
  year: number;
  // registered_at — when staff recorded the registration (period the
  // row is FOR lives in registrationTrend; this is when the work was
  // done).
  registrationsProcessed: number;
  intakeSubmissions: number;
  ownerRequestsOpened: number;
  ownerRequestsResolved: number;
  lostFoundOpened: number;
  lostFoundResolved: number;
  animalsReunited: number;
  communicationsSent: number;
  vaccinationsAdministered: number;
  spayNeuterProcedures: number;
  chipsAssigned: number;
  annualConfirmations: number;
  vetVisitsRecorded: number;
}

export interface OpenWorkSnapshot {
  pendingSubmissions: number;
  pendingOwnerRequests: number;
  openMissingCases: number;
  openFoundUnmatched: number;
  openFoundMatched: number;
  openChipConflicts: number;
  openFollowUps: number;
  expectedClinicAnimals: number;
}

export interface DataQualityContext {
  // All among active known animals — the completeness of the very
  // denominators the headline metrics divide by.
  unknownBirthDate: number;
  unknownSterilization: number;
  noCurrentOwner: number;
  openChipConflicts: number;
}

export interface StaffReport {
  asOf: string;
  year: number;
  availableYears: number[];
  population: PopulationReport;
  registration: RegistrationPeriodReport;
  registrationTrend: TrendYear[];
  health: HealthReport;
  lifecycleTrend: LifecycleTrendYear[];
  workload: WorkloadYear[];
  openWork: OpenWorkSnapshot;
  dataQuality: DataQualityContext;
}

// --- Metric queries -------------------------------------------------------------

const LIFECYCLE_LABELS: Record<string, string> = {
  active: "Active",
  unknown: "Status unknown",
  deceased: "Deceased",
  "moved-off-saba": "Moved off Saba",
};

const SPECIES_LABELS: Record<string, string> = {
  dog: "Dogs",
  cat: "Cats",
  other: "Other",
};

const STERILIZATION_LABELS: Record<string, string> = {
  sterilized: "Sterilized",
  intact: "Not sterilized",
  unknown: "Unknown",
};

const VACCINATION_STATE_ORDER: VaccinationDueState[] = [
  "current",
  "due-soon",
  "overdue",
  "unscheduled",
];

// Population metrics describe CURRENT registry state (as-of-the-report
// is the report's own date). `asOf` scopes the ownership interval test.
export async function getPopulationReport(
  asOf: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PopulationReport> {
  const currentOwnership = sql`
    exists (
      select 1 from ownerships o
      where o.animal_id = animals.id
        and o.valid_from <= ${asOf}
        and (o.valid_to is null or o.valid_to > ${asOf})
    )`;

  const [lifecycleRows, speciesRows, ownershipRow, birthRows] =
    await Promise.all([
      db
        .select({ status: animals.lifecycleStatus, n: count() })
        .from(animals)
        .groupBy(animals.lifecycleStatus),
      db
        .select({ species: animals.species, n: count() })
        .from(animals)
        .where(eq(animals.lifecycleStatus, "active"))
        .groupBy(animals.species),
      db
        .select({
          active: count(),
          withOwner: sql<number>`count(*) filter (where ${currentOwnership})`,
        })
        .from(animals)
        .where(eq(animals.lifecycleStatus, "active")),
      db
        .select({
          birthDate: animals.birthDate,
          estimated: animals.birthDateEstimated,
          n: count(),
        })
        .from(animals)
        .where(eq(animals.lifecycleStatus, "active"))
        .groupBy(animals.birthDate, animals.birthDateEstimated),
    ]);

  const lifecycleByKey = new Map(lifecycleRows.map((r) => [r.status, r.n]));
  const nonMerged = [...lifecycleByKey.entries()]
    .filter(([k]) => k !== "merged")
    .reduce((s, [, n]) => s + n, 0);

  const bandCounts = new Map<AgeBandKey, number>();
  let estimatedBirthDates = 0;
  for (const row of birthRows) {
    const band = ageBandFor(row.birthDate, asOf);
    bandCounts.set(band, (bandCounts.get(band) ?? 0) + row.n);
    if (row.birthDate && row.estimated) estimatedBirthDates += row.n;
  }

  const withOwner = ownershipRow[0]?.withOwner ?? 0;
  const active = ownershipRow[0]?.active ?? 0;

  return {
    knownAnimals: nonMerged,
    lifecycle: ["active", "unknown", "deceased", "moved-off-saba"].map(
      (k) => ({
        key: k,
        label: LIFECYCLE_LABELS[k],
        count: lifecycleByKey.get(k) ?? 0,
      }),
    ),
    activeKnownAnimals: active,
    speciesAmongActive: ["dog", "cat", "other"].map((k) => ({
      key: k,
      label: SPECIES_LABELS[k],
      count: speciesRows.find((r) => r.species === k)?.n ?? 0,
    })),
    withCurrentOwner: withOwner,
    withoutCurrentOwner: active - withOwner,
    ageBandsAmongActive: AGE_BAND_KEYS.map((k) => ({
      key: k,
      label: AGE_BAND_LABELS[k],
      count: bandCounts.get(k) ?? 0,
    })),
    estimatedBirthDates,
  };
}

// Registration period metrics. Money flows through the canonical #170
// projection: one moneyByRegistration aggregate, one
// deriveRegistrationBalance per row — the same arithmetic the ledger
// UI, reminder evaluator, and portal use.
export async function getRegistrationPeriodReport(
  year: number,
  db: RegistryDb = getRegistryDb(),
): Promise<RegistrationPeriodReport> {
  const [rows, eligibleRow] = await Promise.all([
    db
      .select({
        id: registrations.id,
        animalId: registrations.animalId,
        status: registrations.status,
        resolution: registrations.resolution,
        amountDueCents: registrations.amountDueCents,
        cancellationReason: registrations.cancellationReason,
        lifecycle: animals.lifecycleStatus,
      })
      .from(registrations)
      .leftJoin(animals, eq(registrations.animalId, animals.id))
      .where(eq(registrations.year, year)),
    db
      .select({ n: count() })
      .from(animals)
      .where(inArray(animals.lifecycleStatus, REGISTRATION_ELIGIBLE_LIFECYCLES)),
  ]);

  const money = await moneyByRegistration(
    db,
    rows.map((r) => r.id),
  );

  const byState = new Map<RegistrationPaymentState, number>(
    REGISTRATION_PAYMENT_STATES.map((s) => [s, 0]),
  );
  const eligible = new Set<string>(REGISTRATION_ELIGIBLE_LIFECYCLES);
  const registeredAnimals = new Set<string>();
  const registeredEligibleAnimals = new Set<string>();
  let assessed = 0,
    settled = 0,
    outstanding = 0,
    pending = 0,
    overpaid = 0;
  let cancelledWithMoney = 0;
  let moneyOnCancelledCents = 0;

  for (const row of rows) {
    const balance = deriveRegistrationBalance(
      {
        amountDueCents: row.amountDueCents,
        resolution: isRegistrationResolution(row.resolution)
          ? row.resolution
          : null,
      },
      money.get(row.id) ?? emptyLedgerAggregate(),
    );
    if (row.status === "cancelled") {
      const carried = balance.settledCents + balance.pendingCents;
      if (carried !== 0) {
        cancelledWithMoney += 1;
        moneyOnCancelledCents += carried;
      }
      continue;
    }
    byState.set(
      balance.paymentState,
      (byState.get(balance.paymentState) ?? 0) + 1,
    );
    assessed += row.amountDueCents;
    settled += balance.settledCents;
    outstanding += balance.outstandingCents;
    pending += balance.pendingCents;
    overpaid += balance.overpaidCents;
    registeredAnimals.add(row.animalId);
    if (row.lifecycle && eligible.has(row.lifecycle)) {
      registeredEligibleAnimals.add(row.animalId);
    }
  }

  const eligibleAnimals = eligibleRow[0]?.n ?? 0;
  const resolved =
    (byState.get("paid") ?? 0) +
    (byState.get("waived") ?? 0) +
    (byState.get("complimentary") ?? 0) +
    (byState.get("no-fee") ?? 0);
  const activeCount = byStateCount(byState);

  return {
    year,
    rowsForPeriod: rows.length,
    active: activeCount,
    cancelledCorrection: rows.filter(
      (r) => r.status === "cancelled" && r.cancellationReason === "correction",
    ).length,
    cancelledWithdrawn: rows.filter(
      (r) => r.status === "cancelled" && r.cancellationReason === "withdrawn",
    ).length,
    uniqueAnimalsRegistered: registeredAnimals.size,
    eligibleAnimals,
    eligibleRegistered: registeredEligibleAnimals.size,
    eligibleUnregistered: Math.max(
      eligibleAnimals - registeredEligibleAnimals.size,
      0,
    ),
    registeredPct:
      eligibleAnimals > 0
        ? Math.round((registeredEligibleAnimals.size / eligibleAnimals) * 100)
        : null,
    payments: {
      byState: REGISTRATION_PAYMENT_STATES.map((s) => ({
        state: s,
        count: byState.get(s) ?? 0,
      })),
      assessedCents: assessed,
      settledCents: settled,
      outstandingCents: outstanding,
      pendingCents: pending,
      overpaidCents: overpaid,
      resolved,
      resolvedPct:
        activeCount > 0 ? Math.round((resolved / activeCount) * 100) : null,
      cancelledWithMoney,
      moneyOnCancelledCents,
    },
  };

  function byStateCount(m: Map<RegistrationPaymentState, number>): number {
    let n = 0;
    for (const v of m.values()) n += v;
    return n;
  }
}

export async function getRegistrationTrend(
  db: RegistryDb = getRegistryDb(),
): Promise<TrendYear[]> {
  const rows = await db
    .select({
      year: registrations.year,
      active: sql<number>`count(*) filter (where ${registrations.status} = 'active')`,
      cancelled: sql<number>`count(*) filter (where ${registrations.status} = 'cancelled')`,
      uniqueAnimals: sql<number>`count(distinct ${registrations.animalId}) filter (where ${registrations.status} = 'active')`,
    })
    .from(registrations)
    .groupBy(registrations.year)
    .orderBy(registrations.year);
  return rows;
}

export async function getHealthReport(
  asOf: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HealthReport> {
  const [sterilizationRows, chipRow, openConflicts, latestDoses] =
    await Promise.all([
      db
        .select({ status: animals.sterilizationStatus, n: count() })
        .from(animals)
        .where(eq(animals.lifecycleStatus, "active"))
        .groupBy(animals.sterilizationStatus),
      db
        .select({
          active: count(),
          chipped: sql<number>`count(*) filter (where exists (
            select 1 from microchip_records m
            where m.animal_id = animals.id and m.assigned_to is null
          ))`,
        })
        .from(animals)
        .where(eq(animals.lifecycleStatus, "active")),
      countOpenChipConflicts(db),
      // Latest dose per (animal, series) restricted to active animals —
      // the same DISTINCT ON projection the due-vaccinations queue uses;
      // only the 'active' lifecycle filter differs from its inner read.
      db
        .selectDistinctOn([vaccinations.animalId, vaccinations.seriesKey], {
          animalId: vaccinations.animalId,
          seriesKey: vaccinations.seriesKey,
          vaccineName: vaccinations.vaccineName,
          administeredOn: vaccinations.administeredOn,
          dueOn: vaccinations.dueOn,
          validUntil: vaccinations.validUntil,
        })
        .from(vaccinations)
        .innerJoin(
          animals,
          and(
            eq(vaccinations.animalId, animals.id),
            eq(animals.lifecycleStatus, "active"),
          ),
        )
        .orderBy(
          vaccinations.animalId,
          vaccinations.seriesKey,
          desc(vaccinations.administeredOn),
          desc(vaccinations.createdAt),
          desc(vaccinations.id),
        ),
    ]);

  const sterileByKey = new Map(
    sterilizationRows.map((r) => [r.status, r.n]),
  );
  const active = chipRow[0]?.active ?? 0;
  const chipped = chipRow[0]?.chipped ?? 0;

  const doseStateCounts = new Map<VaccinationDueState, number>(
    VACCINATION_STATE_ORDER.map((s) => [s, 0]),
  );
  const seriesMap = new Map<string, VaccinationSeriesReport>();
  const animalsWithRecord = new Set<string>();

  for (const dose of latestDoses) {
    const state = vaccinationDueState(
      effectiveVaccinationDate(dose.dueOn, dose.validUntil),
      asOf,
    );
    doseStateCounts.set(state, (doseStateCounts.get(state) ?? 0) + 1);
    animalsWithRecord.add(dose.animalId);
    let series = seriesMap.get(dose.seriesKey);
    if (!series) {
      series = {
        seriesKey: dose.seriesKey,
        label: dose.vaccineName,
        animals: 0,
        current: 0,
        dueSoon: 0,
        overdue: 0,
        unscheduled: 0,
      };
      seriesMap.set(dose.seriesKey, series);
    }
    series.animals += 1;
    if (state === "current") series.current += 1;
    else if (state === "due-soon") series.dueSoon += 1;
    else if (state === "overdue") series.overdue += 1;
    else series.unscheduled += 1;
  }

  const sterilized = sterileByKey.get("sterilized") ?? 0;

  return {
    sterilizationAmongActive: ["sterilized", "intact", "unknown"].map(
      (k) => ({
        key: k,
        label: STERILIZATION_LABELS[k],
        count: sterileByKey.get(k) ?? 0,
      }),
    ),
    sterilizedPct:
      active > 0 ? Math.round((sterilized / active) * 100) : null,
    microchippedActive: chipped,
    notMicrochippedActive: active - chipped,
    microchipCoveragePct:
      active > 0 ? Math.round((chipped / active) * 100) : null,
    openChipConflicts: openConflicts,
    vaccination: {
      animalsWithAnyRecord: animalsWithRecord.size,
      animalsWithoutRecord: active - animalsWithRecord.size,
      doseStates: VACCINATION_STATE_ORDER.map((s) => ({
        state: s,
        count: doseStateCounts.get(s) ?? 0,
      })),
      series: [...seriesMap.values()].sort((a, b) => b.animals - a.animals),
    },
  };
}

// Lifecycle history by real-world event year (effective_on). Counts are
// DISTINCT ANIMALS per (year, outcome) so a corrected double-transition
// can't inflate a year. Merge retirement events (to_status='merged')
// are excluded — a merged duplicate is not a lost animal.
export async function getLifecycleTrend(
  db: RegistryDb = getRegistryDb(),
): Promise<LifecycleTrendYear[]> {
  const rows = await db
    .select({
      year: sql<number>`extract(year from ${animalLifecycleEvents.effectiveOn})::int`,
      toStatus: animalLifecycleEvents.toStatus,
      isEntry: sql<boolean>`${animalLifecycleEvents.fromStatus} is null`,
      animals: sql<number>`count(distinct ${animalLifecycleEvents.animalId})`,
    })
    .from(animalLifecycleEvents)
    .groupBy(
      sql`extract(year from ${animalLifecycleEvents.effectiveOn})`,
      animalLifecycleEvents.toStatus,
      sql`${animalLifecycleEvents.fromStatus} is null`,
    )
    .orderBy(sql`1`);

  const years = new Map<number, LifecycleTrendYear>();
  const row = (y: number) => {
    let r = years.get(y);
    if (!r) {
      r = { year: y, entered: 0, becameActive: 0, deceased: 0, movedOffSaba: 0 };
      years.set(y, r);
    }
    return r;
  };
  for (const r of rows) {
    const y = row(r.year);
    if (r.isEntry) y.entered += r.animals;
    else if (r.toStatus === "active") y.becameActive += r.animals;
    else if (r.toStatus === "deceased") y.deceased += r.animals;
    else if (r.toStatus === "moved-off-saba") y.movedOffSaba += r.animals;
    // 'unknown'/'merged' targets: corrections and merge retirement —
    // not program outcomes, so deliberately unreported here.
  }
  return [...years.values()].sort((a, b) => a.year - b.year);
}

// Program workload by the year the work happened. Each domain groups by
// its own real-world date column; the merge into per-year rows happens
// in JS over small aggregates.
export async function getWorkloadTrend(
  db: RegistryDb = getRegistryDb(),
): Promise<WorkloadYear[]> {
  const year = (col: SQLWrapper) =>
    sql<number>`extract(year from ${col})::int`;

  const [
    regRows,
    submissionRows,
    requestOpened,
    requestResolved,
    casesOpened,
    casesResolved,
    commRows,
    vaccineRows,
    spayNeuterRows,
    chipRows,
    confirmRows,
    visitRows,
  ] = await Promise.all([
    db
      .select({ year: year(registrations.registeredAt), n: count() })
      .from(registrations)
      .where(isNotNull(registrations.registeredAt))
      .groupBy(sql`1`),
    db
      .select({ year: year(registrationSubmissions.submittedAt), n: count() })
      .from(registrationSubmissions)
      .groupBy(sql`1`),
    db
      .select({ year: year(ownerRequests.createdAt), n: count() })
      .from(ownerRequests)
      .groupBy(sql`1`),
    db
      .select({ year: year(ownerRequests.resolvedAt), n: count() })
      .from(ownerRequests)
      .where(isNotNull(ownerRequests.resolvedAt))
      .groupBy(sql`1`),
    db
      .select({ year: year(lostFoundCases.reportedAt), n: count() })
      .from(lostFoundCases)
      .groupBy(sql`1`),
    db
      .select({
        year: year(lostFoundCases.resolvedAt),
        n: count(),
        reunited: sql<number>`count(*) filter (where ${lostFoundCases.outcome} = 'reunited')`,
      })
      .from(lostFoundCases)
      .where(isNotNull(lostFoundCases.resolvedAt))
      .groupBy(sql`1`),
    db
      .select({ year: year(communications.createdAt), n: count() })
      .from(communications)
      .where(inArray(communications.status, ["sent", "delivered"]))
      .groupBy(sql`1`),
    db
      .select({ year: year(vaccinations.administeredOn), n: count() })
      .from(vaccinations)
      .groupBy(sql`1`),
    db
      .select({ year: year(vetProcedures.performedOn), n: count() })
      .from(vetProcedures)
      .where(
        and(
          inArray(vetProcedures.kind, ["spay", "neuter"]),
          isNotNull(vetProcedures.performedOn),
        ),
      )
      .groupBy(sql`1`),
    db
      .select({ year: year(microchipRecords.assignedFrom), n: count() })
      .from(microchipRecords)
      .groupBy(sql`1`),
    db
      .select({ year: year(ownershipConfirmations.confirmedOn), n: count() })
      .from(ownershipConfirmations)
      .groupBy(sql`1`),
    db
      .select({ year: year(vetEncounters.occurredOn), n: count() })
      .from(vetEncounters)
      .where(eq(vetEncounters.kind, "visit"))
      .groupBy(sql`1`),
  ]);

  const years = new Map<number, WorkloadYear>();
  const row = (y: number): WorkloadYear => {
    let r = years.get(y);
    if (!r) {
      r = {
        year: y,
        registrationsProcessed: 0,
        intakeSubmissions: 0,
        ownerRequestsOpened: 0,
        ownerRequestsResolved: 0,
        lostFoundOpened: 0,
        lostFoundResolved: 0,
        animalsReunited: 0,
        communicationsSent: 0,
        vaccinationsAdministered: 0,
        spayNeuterProcedures: 0,
        chipsAssigned: 0,
        annualConfirmations: 0,
        vetVisitsRecorded: 0,
      };
      years.set(y, r);
    }
    return r;
  };
  const apply = (
    rows: readonly { year: number; n: number }[],
    key: keyof Omit<WorkloadYear, "year">,
  ) => {
    for (const r of rows) row(r.year)[key] += r.n;
  };

  apply(regRows, "registrationsProcessed");
  apply(submissionRows, "intakeSubmissions");
  apply(requestOpened, "ownerRequestsOpened");
  apply(requestResolved, "ownerRequestsResolved");
  apply(casesOpened, "lostFoundOpened");
  apply(casesResolved, "lostFoundResolved");
  for (const r of casesResolved) row(r.year).animalsReunited += r.reunited;
  apply(commRows, "communicationsSent");
  apply(vaccineRows, "vaccinationsAdministered");
  apply(spayNeuterRows, "spayNeuterProcedures");
  apply(chipRows, "chipsAssigned");
  apply(confirmRows, "annualConfirmations");
  apply(visitRows, "vetVisitsRecorded");

  return [...years.values()].sort((a, b) => a.year - b.year);
}

export async function getOpenWorkSnapshot(
  db: RegistryDb = getRegistryDb(),
): Promise<OpenWorkSnapshot> {
  const [
    pendingSubmissions,
    pendingRequests,
    openCases,
    openConflicts,
    openFollowUps,
    expectedClinic,
  ] = await Promise.all([
    db
      .select({ n: count() })
      .from(registrationSubmissions)
      .where(eq(registrationSubmissions.status, "pending")),
    countPendingOwnerRequests(db),
    getOpenCaseCounts(db),
    countOpenChipConflicts(db),
    db
      .select({ n: count() })
      .from(followUps)
      .where(eq(followUps.status, "open")),
    db
      .select({ n: count() })
      .from(clinicExpectations)
      .where(eq(clinicExpectations.status, "expected")),
  ]);
  return {
    pendingSubmissions: pendingSubmissions[0]?.n ?? 0,
    pendingOwnerRequests: pendingRequests,
    openMissingCases: openCases.missing,
    openFoundUnmatched: openCases.foundUnmatched,
    openFoundMatched: openCases.foundMatched,
    openChipConflicts: openConflicts,
    openFollowUps: openFollowUps[0]?.n ?? 0,
    expectedClinicAnimals: expectedClinic[0]?.n ?? 0,
  };
}

export async function getDataQualityContext(
  asOf: string,
  db: RegistryDb = getRegistryDb(),
): Promise<DataQualityContext> {
  const rows = await db
    .select({
      unknownBirth: sql<number>`count(*) filter (where ${animals.birthDate} is null)`,
      unknownSterilization: sql<number>`count(*) filter (where ${animals.sterilizationStatus} = 'unknown')`,
      noOwner: sql<number>`count(*) filter (where not exists (
        select 1 from ownerships o
        where o.animal_id = animals.id
          and o.valid_from <= ${asOf}
          and (o.valid_to is null or o.valid_to > ${asOf})
      ))`,
    })
    .from(animals)
    .where(eq(animals.lifecycleStatus, "active"));
  const openConflicts = await countOpenChipConflicts(db);
  return {
    unknownBirthDate: rows[0]?.unknownBirth ?? 0,
    unknownSterilization: rows[0]?.unknownSterilization ?? 0,
    noCurrentOwner: rows[0]?.noOwner ?? 0,
    openChipConflicts: openConflicts,
  };
}

// --- Composed report -------------------------------------------------------------

// The staff report: every section is an independent set-based read,
// gathered concurrently. Unlike the exception dashboard this is not a
// per-service allSettled composition — a failed report should fail
// visibly rather than silently show zeros (dashboard shows availability;
// a report that can't compute its denominator must not publish it).
export async function getStaffReport(
  params: ReportParams = {},
  db: RegistryDb = getRegistryDb(),
): Promise<StaffReport> {
  const { year, asOf } = normalizeReportParams(params);
  const [
    population,
    registration,
    registrationTrend,
    health,
    lifecycleTrend,
    workload,
    openWork,
    dataQuality,
    yearRows,
  ] = await Promise.all([
    getPopulationReport(asOf, db),
    getRegistrationPeriodReport(year, db),
    getRegistrationTrend(db),
    getHealthReport(asOf, db),
    getLifecycleTrend(db),
    getWorkloadTrend(db),
    getOpenWorkSnapshot(db),
    getDataQualityContext(asOf, db),
    db
      .selectDistinct({ year: registrations.year })
      .from(registrations)
      .orderBy(registrations.year),
  ]);

  const availableYears = [
    ...new Set([...yearRows.map((r) => r.year), year]),
  ].sort((a, b) => b - a);

  return {
    asOf,
    year,
    availableYears,
    population,
    registration,
    registrationTrend,
    health,
    lifecycleTrend,
    workload,
    openWork,
    dataQuality,
  };
}

// --- Public anonymous statistics -------------------------------------------------
// A SEPARATE DTO — never the staff report minus fields. Everything that
// reaches /statistics passed through this mapping: small breakdown cells
// suppressed (complementary suppression included), rates only above the
// threshold denominator, and no field that could carry an owner,
// household, chip number, payment, or medical detail exists here at all.

export interface PublicStatsReport {
  asOf: string;
  registrationYear: number;
  // Exact population-level totals are publishable — a total is not a
  // small cell and can't single out a household.
  activeKnownAnimals: number;
  knownAnimals: number;
  speciesBreakdown: PublicBreakdownCell[];
  ageBreakdown: PublicBreakdownCell[];
  registeredThisPeriod: number;
  registeredPct: number | null;
  sterilizedPct: number | null;
  microchippedPct: number | null;
  // Program activity for the current registration year — program-level
  // aggregates (no sub-population partitioning), so exact counts.
  program: {
    newRegistryEntries: number;
    registrationsCompleted: number;
    animalsReunited: number;
    vaccinationsAdministered: number;
    spayNeuterProcedures: number;
  };
  // Echoed so the UI can state the policy truthfully.
  smallCellMin: number;
}

export async function getPublicStats(
  params: ReportParams = {},
  db: RegistryDb = getRegistryDb(),
): Promise<PublicStatsReport> {
  const { year, asOf } = normalizeReportParams(params);
  const [population, registration, health, lifecycleTrend, workload] =
    await Promise.all([
      getPopulationReport(asOf, db),
      getRegistrationPeriodReport(year, db),
      getHealthReport(asOf, db),
      getLifecycleTrend(db),
      getWorkloadTrend(db),
    ]);

  const lifecycleThisYear = lifecycleTrend.find((t) => t.year === year);
  const workloadThisYear = workload.find((w) => w.year === year);

  return {
    asOf,
    registrationYear: year,
    activeKnownAnimals: population.activeKnownAnimals,
    knownAnimals: population.knownAnimals,
    speciesBreakdown: suppressSmallCells(population.speciesAmongActive),
    ageBreakdown: suppressSmallCells(population.ageBandsAmongActive),
    registeredThisPeriod: registration.uniqueAnimalsRegistered,
    registeredPct: publicPercent(
      registration.eligibleRegistered,
      registration.eligibleAnimals,
    ),
    sterilizedPct: publicPercent(
      health.sterilizationAmongActive.find((s) => s.key === "sterilized")
        ?.count ?? 0,
      population.activeKnownAnimals,
    ),
    microchippedPct: publicPercent(
      health.microchippedActive,
      population.activeKnownAnimals,
    ),
    program: {
      newRegistryEntries: lifecycleThisYear?.entered ?? 0,
      registrationsCompleted: workloadThisYear?.registrationsProcessed ?? 0,
      animalsReunited: workloadThisYear?.animalsReunited ?? 0,
      vaccinationsAdministered:
        workloadThisYear?.vaccinationsAdministered ?? 0,
      spayNeuterProcedures: workloadThisYear?.spayNeuterProcedures ?? 0,
    },
    smallCellMin: PUBLIC_SMALL_CELL_MIN,
  };
}

// --- Staff CSV export -----------------------------------------------------------
// Aggregate report data only — never owner-level rows. Every export
// reuses the same StaffReport figures the page shows, so the download
// can never disagree with the screen. Encoding (quoting + formula-
// injection guard) is shared in src/lib/reports.ts.

export const EXPORT_REPORTS = ["overview", "period", "trends"] as const;
export type ExportReportKey = (typeof EXPORT_REPORTS)[number];

export function isExportReportKey(v: unknown): v is ExportReportKey {
  return (EXPORT_REPORTS as readonly string[]).includes(v as string);
}

const money = (cents: number) => (cents / 100).toFixed(2);

export function buildExportCsv(
  report: StaffReport,
  kind: ExportReportKey,
): string {
  if (kind === "trends") {
    // One wide row per calendar year — registry history, registration
    // periods, and program workload aligned on the same timeline.
    const years = new Set<number>();
    for (const t of report.lifecycleTrend) years.add(t.year);
    for (const t of report.registrationTrend) years.add(t.year);
    for (const w of report.workload) years.add(w.year);
    const lifecycle = new Map(report.lifecycleTrend.map((t) => [t.year, t]));
    const registration = new Map(
      report.registrationTrend.map((t) => [t.year, t]),
    );
    const workload = new Map(report.workload.map((w) => [w.year, w]));
    const rows = [...years].sort().map((y) => {
      const l = lifecycle.get(y);
      const r = registration.get(y);
      const w = workload.get(y);
      return [
        y,
        l?.entered ?? 0,
        l?.becameActive ?? 0,
        l?.deceased ?? 0,
        l?.movedOffSaba ?? 0,
        r?.active ?? 0,
        r?.uniqueAnimals ?? 0,
        r?.cancelled ?? 0,
        w?.registrationsProcessed ?? 0,
        w?.intakeSubmissions ?? 0,
        w?.ownerRequestsOpened ?? 0,
        w?.ownerRequestsResolved ?? 0,
        w?.lostFoundOpened ?? 0,
        w?.lostFoundResolved ?? 0,
        w?.animalsReunited ?? 0,
        w?.communicationsSent ?? 0,
        w?.vaccinationsAdministered ?? 0,
        w?.spayNeuterProcedures ?? 0,
        w?.chipsAssigned ?? 0,
        w?.annualConfirmations ?? 0,
        w?.vetVisitsRecorded ?? 0,
      ] as const;
    });
    return toCsv(
      [
        "year",
        "animals_entered_registry",
        "confirmed_active",
        "recorded_deceased",
        "moved_off_saba",
        "registrations_in_effect",
        "unique_animals_registered",
        "registrations_cancelled",
        "registrations_processed",
        "intake_submissions",
        "owner_requests_opened",
        "owner_requests_resolved",
        "lostfound_cases_opened",
        "lostfound_cases_resolved",
        "animals_reunited",
        "communications_sent",
        "vaccinations_administered",
        "spay_neuter_procedures",
        "microchips_assigned",
        "annual_confirmations",
        "vet_visits_recorded",
      ],
      rows,
    );
  }

  const { year, asOf } = report;
  const m = (
    section: string,
    metric: string,
    value: number | string | null,
    denominator = "",
  ) => [section, metric, value, denominator, year, asOf] as const;

  const rows: (readonly (string | number | null)[])[] = [];

  if (kind === "overview") {
    rows.push(
      m("population", "active_known_animals", report.population.activeKnownAnimals),
      m("population", "known_animals_total", report.population.knownAnimals),
      ...report.population.lifecycle.map((l) =>
        m("population", `lifecycle_${l.key.replace(/-/g, "_")}`, l.count),
      ),
      ...report.population.speciesAmongActive.map((s) =>
        m("population", `species_${s.key}`, s.count, "active known animals"),
      ),
      m("population", "active_with_current_owner", report.population.withCurrentOwner, "active known animals"),
      m("population", "active_without_current_owner", report.population.withoutCurrentOwner, "active known animals"),
      ...report.population.ageBandsAmongActive.map((b) =>
        m("population", `age_band_${b.key.replace(/-/g, "_")}`, b.count, "active known animals"),
      ),
      ...report.health.sterilizationAmongActive.map((s) =>
        m("health", `sterilization_${s.key}`, s.count, "active known animals"),
      ),
      m("health", "sterilized_pct", report.health.sterilizedPct, "active known animals"),
      m("health", "microchipped_active", report.health.microchippedActive, "active known animals"),
      m("health", "microchip_coverage_pct", report.health.microchipCoveragePct, "active known animals"),
      m("health", "open_chip_conflicts", report.health.openChipConflicts),
      m("health", "vaccinated_animals", report.health.vaccination.animalsWithAnyRecord, "active known animals"),
      m("health", "no_vaccination_record", report.health.vaccination.animalsWithoutRecord, "active known animals"),
      ...report.health.vaccination.doseStates.map((s) =>
        m("health", `vaccination_${s.state.replace(/-/g, "_")}`, s.count, "latest dose per animal-series"),
      ),
      ...report.health.vaccination.series.flatMap((s) => [
        m("health_series", `${s.label}_animals`, s.animals, "active known animals"),
        m("health_series", `${s.label}_current`, s.current, `animals with ${s.label} on record`),
        m("health_series", `${s.label}_due_soon`, s.dueSoon, `animals with ${s.label} on record`),
        m("health_series", `${s.label}_overdue`, s.overdue, `animals with ${s.label} on record`),
      ]),
      m("open_work", "pending_intake_submissions", report.openWork.pendingSubmissions),
      m("open_work", "pending_owner_requests", report.openWork.pendingOwnerRequests),
      m("open_work", "open_missing_cases", report.openWork.openMissingCases),
      m("open_work", "open_found_cases", report.openWork.openFoundUnmatched + report.openWork.openFoundMatched),
      m("open_work", "open_follow_ups", report.openWork.openFollowUps),
      m("open_work", "expected_clinic_animals", report.openWork.expectedClinicAnimals),
      m("data_quality", "unknown_birth_date", report.dataQuality.unknownBirthDate, "active known animals"),
      m("data_quality", "unknown_sterilization", report.dataQuality.unknownSterilization, "active known animals"),
      m("data_quality", "no_current_owner", report.dataQuality.noCurrentOwner, "active known animals"),
    );
  }

  // The "period" detail is always included — overview carries it too,
  // and the dedicated export is the period's own sheet.
  if (kind === "overview" || kind === "period") {
    const reg = report.registration;
    rows.push(
      m("registration", "rows_for_period", reg.rowsForPeriod, `period ${year}`),
      m("registration", "registrations_in_effect", reg.active, `period ${year}`),
      m("registration", "cancelled_correction", reg.cancelledCorrection, `period ${year}`),
      m("registration", "cancelled_withdrawn", reg.cancelledWithdrawn, `period ${year}`),
      m("registration", "unique_animals_registered", reg.uniqueAnimalsRegistered, `period ${year}`),
      m("registration", "eligible_animals", reg.eligibleAnimals, "lifecycle active|unknown"),
      m("registration", "eligible_registered", reg.eligibleRegistered, "eligible animals"),
      m("registration", "eligible_unregistered", reg.eligibleUnregistered, "eligible animals"),
      m("registration", "registered_pct", reg.registeredPct, "eligible animals"),
      ...reg.payments.byState.map((s) =>
        m("payments", `state_${s.state.replace(/-/g, "_")}`, s.count, `${year} active registrations`),
      ),
      m("payments", "financially_resolved", reg.payments.resolved, `${year} active registrations`),
      m("payments", "resolved_pct", reg.payments.resolvedPct, `${year} active registrations`),
      m("payments", "assessed_usd", money(reg.payments.assessedCents)),
      m("payments", "settled_usd", money(reg.payments.settledCents)),
      m("payments", "outstanding_usd", money(reg.payments.outstandingCents)),
      m("payments", "pending_usd", money(reg.payments.pendingCents)),
      m("payments", "overpaid_usd", money(reg.payments.overpaidCents)),
      m("payments", "cancelled_rows_with_money", reg.payments.cancelledWithMoney, `${year} cancelled registrations`),
      m("payments", "money_on_cancelled_usd", money(reg.payments.moneyOnCancelledCents)),
    );
  }

  return toCsv(["section", "metric", "value", "denominator", "period", "as_of"], rows);
}
