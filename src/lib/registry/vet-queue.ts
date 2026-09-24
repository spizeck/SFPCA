// Veterinary work queue (#175) — the canonical cross-animal "what needs
// attention" read for staff. It composes four domains into ONE sorted
// action list:
//
//   - open follow_ups (rechecks) — the authoritative manual queue,
//     owned by the medical service; only animal-linked, non-registration
//     rows count as veterinary work;
//   - unresolved clinic_expectations (#194) — animals expected at an
//     upcoming clinic session; a still-'expected' row whose date has
//     passed means "failed to appear — resolve it";
//   - vaccinations due/overdue — DELEGATED to listDueVaccinations
//     (#173), never re-derived here, so the queue and the reminder
//     foundation (#172) can never disagree about what is due;
//   - active medical_alerts at 'critical'/'important' severity — 'info'
//     alerts are context on the record, not queue items.
//
// This module reads only; every mutation goes through the owning
// domain service. It sends nothing — #172 owns scheduling, delivery,
// and send history. #177's broader exception dashboard should compose
// vetQueueSummary() rather than re-querying these tables.
import "server-only";

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  animals,
  clinicExpectations,
  followUps,
  households,
  medicalAlerts,
  ownerships,
  persons,
  vetEncounters,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { clinicExpectationState, followUpState } from "../medical";
import {
  addDaysToIsoDate,
  isIsoDateString,
  todayIsoDate,
} from "../vaccinations";
import { listDueVaccinations } from "./vaccinations";
import { currentOwnershipSq } from "./ownership";
import type { RegistryDb } from "./public-animals";

// How far ahead the queue looks by default — matches the shared
// vaccination "due soon" window so both item kinds agree on "soon".
export const VET_QUEUE_WINDOW_DAYS = 30;

interface QueueAnimal {
  id: string;
  name: string;
  species: string;
}

// One actionable queue entry. `updatedAt` on follow-ups is the
// optimistic-concurrency token the complete/cancel mutations require.
export type VetQueueItem =
  | {
      kind: "follow-up";
      id: string;
      dueOn: string;
      state: "overdue" | "due" | "upcoming";
      reason: string | null;
      notes: string | null;
      encounterId: string | null;
      encounterOn: string | null;
      animal: QueueAnimal;
      // The CURRENT owner's display name — resolved live at read time,
      // deliberately NOT the person_id snapshot (which is history).
      currentOwnerName: string | null;
      updatedAt: string;
    }
  | {
      kind: "vaccination";
      id: string;
      effectiveDate: string;
      state: "overdue" | "due-soon";
      vaccineName: string;
      animal: QueueAnimal;
      currentOwnerName: string | null;
    }
  | {
      kind: "clinic";
      id: string;
      expectedOn: string;
      // 'overdue' here means "expected date passed and still
      // unresolved" — the animal likely failed to appear and staff
      // need to mark seen/no-show, not that work is late.
      state: "overdue" | "due" | "upcoming";
      reason: string;
      sessionLabel: string | null;
      notes: string | null;
      animal: QueueAnimal;
      currentOwnerName: string | null;
      updatedAt: string;
    }
  | {
      kind: "alert";
      id: string;
      severity: "critical" | "important";
      alertKind: string;
      summary: string;
      recordedOn: string;
      animal: QueueAnimal;
    };

// Urgency ordering for the flat list: overdue items first (most overdue
// first), then due today, then upcoming by date, then alerts (critical
// before important, longest-unattended first). Dated work outranks
// alerts because alerts are context for treatment, not deadlines — and
// they never leave the queue until resolved, so leading with them
// would bury the day's actionable items.
function itemRank(item: VetQueueItem, asOf: string): number {
  if (item.kind === "alert") return item.severity === "critical" ? 3 : 4;
  const date =
    item.kind === "follow-up"
      ? item.dueOn
      : item.kind === "vaccination"
        ? item.effectiveDate
        : item.expectedOn;
  if (date < asOf) return 0;
  if (date === asOf) return 1;
  return 2;
}

function itemDate(item: VetQueueItem): string | null {
  switch (item.kind) {
    case "follow-up":
      return item.dueOn;
    case "vaccination":
      return item.effectiveDate;
    case "clinic":
      return item.expectedOn;
    case "alert":
      return item.recordedOn;
  }
}

function compareQueueItems(asOf: string) {
  return (a: VetQueueItem, b: VetQueueItem): number => {
    const rankDiff = itemRank(a, asOf) - itemRank(b, asOf);
    if (rankDiff !== 0) return rankDiff;
    const dateDiff = (itemDate(a) ?? "").localeCompare(itemDate(b) ?? "");
    if (dateDiff !== 0) return dateDiff;
    const nameDiff = a.animal.name.localeCompare(b.animal.name);
    if (nameDiff !== 0) return nameDiff;
    return a.id.localeCompare(b.id);
  };
}

// "What needs veterinary attention, overdue through `withinDays` out?"
// asOf defaults to today; tests pass a fixed date. Rows whose animal
// row is gone (animal_id set-null'd) are dropped — a follow-up with no
// animal has nothing actionable left.
export async function listVetQueue(
  {
    asOf = todayIsoDate(),
    withinDays = VET_QUEUE_WINDOW_DAYS,
  }: { asOf?: string; withinDays?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<VetQueueItem[]> {
  if (!isIsoDateString(asOf)) {
    throw new Error("listVetQueue: asOf must be YYYY-MM-DD");
  }
  const horizon = addDaysToIsoDate(asOf, withinDays);

  // The canonical current-owner projection (#166's ownership.ts) — one
  // owner per animal at asOf, person preferred over household,
  // deterministic under inconsistent data. Only the NAME is projected:
  // the queue needs context, not contact details (#172 resolves
  // recipients when it sends).
  const currentOwnership = currentOwnershipSq(db, asOf, "vet_queue_ownership");

  const [followUpRows, clinicRows, alertRows, dueVaccinations] =
    await Promise.all([
      db
        .select({
          id: followUps.id,
          dueOn: followUps.dueOn,
          status: followUps.status,
          reason: followUps.reason,
          notes: followUps.notes,
          encounterId: followUps.encounterId,
          updatedAt: followUps.updatedAt,
          animalId: animals.id,
          animalName: animals.name,
          animalSpecies: animals.species,
          encounterOn: vetEncounters.occurredOn,
          ownerPersonName: persons.fullName,
          ownerHouseholdName: households.name,
        })
        .from(followUps)
        .innerJoin(animals, eq(followUps.animalId, animals.id))
        .leftJoin(vetEncounters, eq(followUps.encounterId, vetEncounters.id))
        .leftJoin(currentOwnership, eq(currentOwnership.animalId, animals.id))
        .leftJoin(persons, eq(currentOwnership.personId, persons.id))
        .leftJoin(households, eq(currentOwnership.householdId, households.id))
        .where(
          and(
            eq(followUps.status, "open"),
            // Registration-linked follow-ups are operational work for
            // #177's dashboard, not veterinary queue items.
            isNull(followUps.registrationId),
            lte(followUps.dueOn, horizon),
          ),
        )
        .orderBy(asc(followUps.dueOn), asc(followUps.id)),
      db
        .select({
          id: clinicExpectations.id,
          expectedOn: clinicExpectations.expectedOn,
          status: clinicExpectations.status,
          reason: clinicExpectations.reason,
          sessionLabel: clinicExpectations.sessionLabel,
          notes: clinicExpectations.notes,
          updatedAt: clinicExpectations.updatedAt,
          animalId: animals.id,
          animalName: animals.name,
          animalSpecies: animals.species,
          ownerPersonName: persons.fullName,
          ownerHouseholdName: households.name,
        })
        .from(clinicExpectations)
        .innerJoin(animals, eq(clinicExpectations.animalId, animals.id))
        .leftJoin(currentOwnership, eq(currentOwnership.animalId, animals.id))
        .leftJoin(persons, eq(currentOwnership.personId, persons.id))
        .leftJoin(households, eq(currentOwnership.householdId, households.id))
        .where(
          and(
            eq(clinicExpectations.status, "expected"),
            lte(clinicExpectations.expectedOn, horizon),
          ),
        )
        .orderBy(
          asc(clinicExpectations.expectedOn),
          asc(clinicExpectations.id),
        ),
      db
        .select({
          id: medicalAlerts.id,
          severity: medicalAlerts.severity,
          kind: medicalAlerts.kind,
          summary: medicalAlerts.summary,
          recordedOn: medicalAlerts.recordedOn,
          animalId: animals.id,
          animalName: animals.name,
          animalSpecies: animals.species,
        })
        .from(medicalAlerts)
        .innerJoin(animals, eq(medicalAlerts.animalId, animals.id))
        .where(
          and(
            eq(medicalAlerts.status, "active"),
            // Only actionable severities — 'info' alerts stay on the
            // animal record where they belong.
            inArray(medicalAlerts.severity, ["critical", "important"]),
          ),
        ),
      listDueVaccinations({ asOf, withinDays }, db),
    ]);

  const items: VetQueueItem[] = [
    ...followUpRows.map((r): VetQueueItem => ({
      kind: "follow-up",
      id: r.id,
      dueOn: r.dueOn,
      state: followUpState(r.dueOn, r.status, asOf) as
        "overdue" | "due" | "upcoming",
      reason: r.reason,
      notes: r.notes,
      encounterId: r.encounterId,
      encounterOn: r.encounterOn,
      animal: {
        id: r.animalId,
        name: r.animalName,
        species: r.animalSpecies,
      },
      currentOwnerName: r.ownerPersonName ?? r.ownerHouseholdName ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    // withinDays may exceed the 30-day due-soon window — a 'current'
    // row in that gap is not actionable yet, so filter rather than
    // trusting the SQL horizon to equal the state boundary.
    ...dueVaccinations
      .filter((d) => d.state === "overdue" || d.state === "due-soon")
      .map((d): VetQueueItem => ({
        kind: "vaccination",
        id: d.vaccination.id,
        effectiveDate: d.effectiveDate,
        // Narrowed by the filter above — 'current'/'unscheduled'
        // rows never reach this map.
        state: d.state === "overdue" ? "overdue" : "due-soon",
        vaccineName: d.vaccination.vaccineName,
        animal: {
          id: d.animal.id,
          name: d.animal.name,
          species: d.animal.species,
        },
        currentOwnerName: d.currentOwner?.name ?? null,
      })),
    ...clinicRows.map((r): VetQueueItem => ({
      kind: "clinic",
      id: r.id,
      expectedOn: r.expectedOn,
      // Status is 'expected' by the WHERE clause, so the derived
      // state is always date-relative — narrow like follow-ups do.
      state: clinicExpectationState(r.expectedOn, r.status, asOf) as
        "overdue" | "due" | "upcoming",
      reason: r.reason,
      sessionLabel: r.sessionLabel,
      notes: r.notes,
      animal: {
        id: r.animalId,
        name: r.animalName,
        species: r.animalSpecies,
      },
      currentOwnerName: r.ownerPersonName ?? r.ownerHouseholdName ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    ...alertRows.map((r): VetQueueItem => ({
      kind: "alert",
      id: r.id,
      severity: r.severity as "critical" | "important",
      alertKind: r.kind,
      summary: r.summary,
      recordedOn: r.recordedOn,
      animal: {
        id: r.animalId,
        name: r.animalName,
        species: r.animalSpecies,
      },
    })),
  ];

  items.sort(compareQueueItems(asOf));
  return items;
}

// Aggregate counts for the admin dashboard card — and the composition
// point #177's exception dashboard should reuse instead of re-deriving.
// Derived from listVetQueue so the two surfaces can never disagree
// about what counts as actionable.
export interface VetQueueSummary {
  overdueFollowUps: number;
  dueTodayFollowUps: number;
  upcomingFollowUps: number;
  // Still-'expected' rows whose clinic date already passed — the
  // "failed to appear, needs resolution" bucket.
  overdueExpectations: number;
  expectedToday: number;
  upcomingExpectations: number;
  overdueVaccinations: number;
  dueSoonVaccinations: number;
  criticalAlerts: number;
  importantAlerts: number;
  total: number;
}

export async function vetQueueSummary(
  opts: { asOf?: string; withinDays?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<VetQueueSummary> {
  const items = await listVetQueue(opts, db);
  const summary: VetQueueSummary = {
    overdueFollowUps: 0,
    dueTodayFollowUps: 0,
    upcomingFollowUps: 0,
    overdueExpectations: 0,
    expectedToday: 0,
    upcomingExpectations: 0,
    overdueVaccinations: 0,
    dueSoonVaccinations: 0,
    criticalAlerts: 0,
    importantAlerts: 0,
    total: items.length,
  };
  for (const item of items) {
    if (item.kind === "follow-up") {
      if (item.state === "overdue") summary.overdueFollowUps++;
      else if (item.state === "due") summary.dueTodayFollowUps++;
      else summary.upcomingFollowUps++;
    } else if (item.kind === "clinic") {
      if (item.state === "overdue") summary.overdueExpectations++;
      else if (item.state === "due") summary.expectedToday++;
      else summary.upcomingExpectations++;
    } else if (item.kind === "vaccination") {
      if (item.state === "overdue") summary.overdueVaccinations++;
      else summary.dueSoonVaccinations++;
    } else {
      if (item.severity === "critical") summary.criticalAlerts++;
      else summary.importantAlerts++;
    }
  }
  return summary;
}
