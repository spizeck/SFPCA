// Canonical data-quality detection (#178).
//
// Detection is automated; identity decisions are not. Every detector is
// a cheap, deterministic, set-based query producing a typed FINDING —
// never a conclusion that rewrites data. Findings are computed live
// (no findings table): they are cheap on a registry of this size and
// recomputation means fixes clear themselves. The only persistence is
// data_quality_reviews — the human decision layer ("confirmed" /
// "dismissed") so volunteers don't re-triage the same pair forever.
//
// Duplicate-chip detection is deliberately NOT reimplemented here:
// #168's microchip_conflicts table is the evidence trail — this service
// surfaces its unresolved rows as findings, nothing more.
//
// A finding's `fingerprint` hashes its evidence. A persisted decision
// applies only while the fingerprint still matches — materially new
// evidence resurfaces a dismissed finding rather than permanently
// suppressing every future concern.

import "server-only";

import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  animals,
  auditEvents,
  clinicExpectations,
  dataQualityReviews,
  followUps,
  householdMembers,
  households,
  microchipConflicts,
  microchipRecords,
  ownerships,
  payments,
  persons,
  registrations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  DATA_QUALITY_DETECTOR_CATEGORY,
  isDataQualityDetector,
  isDataQualityReviewDecision,
  type DataQualityCategory,
  type DataQualityDetector,
  type DataQualityEntityType,
  type DataQualityReviewDecision,
  type DataQualitySeverity,
} from "../data-quality";
import { todayIsoDate } from "../vaccinations";
import { listOwnershipsRequiringConfirmation } from "./ownership";
import type { RegistryDb } from "./public-animals";

// --- Finding shape -------------------------------------------------------------

export interface DataQualityReview {
  decision: DataQualityReviewDecision;
  // The evidence fingerprint the decision was made against.
  fingerprint: string;
  decidedByLabel: string | null;
  decidedAt: string;
  note: string | null;
}

export interface DataQualityFinding {
  // Stable row key: detector + canonical entity ids.
  key: string;
  detector: DataQualityDetector;
  category: DataQualityCategory;
  severity: DataQualitySeverity;
  entityType: DataQualityEntityType;
  // Affected entities — one for single-record findings, a canonically
  // ordered pair for duplicate candidates.
  entityIds: string[];
  label: string;
  detail: string;
  evidence: string[];
  // Where the volunteer acts on it — a record page or the merge review.
  href: string;
  fingerprint: string;
  review: DataQualityReview | null;
  // A dismissal applies only while the evidence fingerprint matches.
  suppressed: boolean;
  confirmed: boolean;
  // A decision exists but the evidence changed — surfaced as "new
  // evidence since review" rather than silently re-opened.
  staleReview: boolean;
}

interface RawFinding {
  detector: DataQualityDetector;
  severity: DataQualitySeverity;
  entityType: DataQualityEntityType;
  entityIds: string[];
  label: string;
  detail: string;
  evidence: string[];
  href: string;
}

// uuid ordering: Postgres uuid < compares the same bytes a lowercase
// hex-string comparison does — canonicalize pair order so (A,B) and
// (B,A) are the same review row.
export function canonicalEntityIds(ids: string[]): string[] {
  return [...new Set(ids.map((s) => s.toLowerCase()))].sort();
}

function fingerprintOf(f: RawFinding): string {
  return createHash("sha256")
    .update(
      [f.detector, ...canonicalEntityIds(f.entityIds), ...f.evidence].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
}

function findingKey(f: RawFinding): string {
  return `${f.detector}:${canonicalEntityIds(f.entityIds).join("+")}`;
}

// --- Detectors -----------------------------------------------------------------
// Each returns findings for ONE detector. They run inside listDataQualityFindings
// with failure isolation at the caller (the dashboard gatherer) — a detector
// exception surfaces as a failed summary, never as a zero count.

// #168's conflict table IS the detector — this only projects open rows.
async function detectChipConflicts(db: RegistryDb): Promise<RawFinding[]> {
  const rows = await db
    .select({
      id: microchipConflicts.id,
      chipNumber: microchipConflicts.chipNumber,
      claimedAnimalId: microchipConflicts.claimedAnimalId,
      existingAnimalId: microchipConflicts.existingAnimalId,
      detail: microchipConflicts.detail,
    })
    .from(microchipConflicts)
    .where(eq(microchipConflicts.status, "open"))
    .orderBy(asc(microchipConflicts.createdAt));
  const animalIds = [
    ...new Set(
      rows.flatMap((r) =>
        [r.claimedAnimalId, r.existingAnimalId].filter(
          (v): v is string => v != null,
        ),
      ),
    ),
  ];
  const names = await loadAnimalLabels(animalIds, db);
  return rows.map((r) => {
    const ids = canonicalEntityIds(
      [r.claimedAnimalId, r.existingAnimalId].filter(
        (v): v is string => v != null,
      ),
    );
    return {
      detector: "microchip-conflict",
      severity: "blocking",
      entityType: "animal",
      entityIds: ids,
      label: `Microchip conflict on ${r.chipNumber}`,
      detail: `Two animals are associated with chip ${r.chipNumber}: ${ids
        .map((id) => names.get(id) ?? id)
        .join(" and ")}. A chip number must identify exactly one animal.`,
      evidence: [
        `chip ${r.chipNumber}`,
        ...(r.detail ? [r.detail] : []),
        ...ids.map((id) => `animal ${names.get(id) ?? id}`),
      ],
      href: "/admin/chip-lookup#conflicts",
    };
  });
}

async function loadAnimalLabels(
  ids: string[],
  db: RegistryDb,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: animals.id, name: animals.name, ref: animals.registryRef })
    .from(animals)
    .where(inArray(animals.id, ids));
  for (const r of rows) map.set(r.id, `${r.name} (${r.ref})`);
  return map;
}

// --- Probable duplicate animals ---
// Conservative evidence: a shared non-'corrected' microchip record is
// strong; shared open ownership is strong; a normalized name match needs
// corroboration (same species plus owner, birth date, or sex+near-birth).
// Two animals named "Bella" alone never become a candidate.
async function detectDuplicateAnimals(db: RegistryDb): Promise<RawFinding[]> {
  const animalRows = await db
    .select({
      id: animals.id,
      name: animals.name,
      species: animals.species,
      sex: animals.sex,
      birthDate: animals.birthDate,
      registryRef: animals.registryRef,
    })
    .from(animals)
    .where(ne(animals.lifecycleStatus, "merged"));
  const byId = new Map(animalRows.map((r) => [r.id, r]));

  // Same chip number on two different live animals (any history row —
  // 'corrected' rows are excluded: that chip was never truly theirs).
  const m1 = alias(microchipRecords, "m1");
  const m2 = alias(microchipRecords, "m2");
  const chipPairs = await db
    .select({ a: m1.animalId, b: m2.animalId, chip: m1.chipNumber })
    .from(m1)
    .innerJoin(
      m2,
      and(eq(m1.chipNumber, m2.chipNumber), lt(m1.animalId, m2.animalId)),
    )
    .where(
      and(
        sql`${m1.closedReason} IS DISTINCT FROM 'corrected'`,
        sql`${m2.closedReason} IS DISTINCT FROM 'corrected'`,
      ),
    );

  // Shared open ownership — one person/household recorded as the
  // current owner of two records is strong corroboration.
  const o1 = alias(ownerships, "o1");
  const o2 = alias(ownerships, "o2");
  const ownerPairs = await db
    .select({
      a: o1.animalId,
      b: o2.animalId,
      personId: o1.personId,
      householdId: o1.householdId,
      personName: persons.fullName,
      householdName: households.name,
    })
    .from(o1)
    .innerJoin(
      o2,
      and(
        lt(o1.animalId, o2.animalId),
        or(
          and(
            isNotNull(o1.personId),
            eq(o1.personId, o2.personId),
          ),
          and(
            isNotNull(o1.householdId),
            eq(o1.householdId, o2.householdId),
          ),
        ),
      ),
    )
    .leftJoin(persons, eq(o1.personId, persons.id))
    .leftJoin(households, eq(o1.householdId, households.id))
    .where(and(isNull(o1.validTo), isNull(o2.validTo)));

  interface PairSignals {
    chips: Set<string>;
    owners: Set<string>;
  }
  const pairs = new Map<string, PairSignals>();
  const bump = (a: string, b: string): PairSignals => {
    const [x, y] = canonicalEntityIds([a, b]);
    const key = `${x}+${y}`;
    const entry = pairs.get(key) ?? { chips: new Set(), owners: new Set() };
    pairs.set(key, entry);
    return entry;
  };

  for (const r of chipPairs) {
    if (!byId.has(r.a) || !byId.has(r.b)) continue; // merged side excluded
    bump(r.a, r.b).chips.add(r.chip);
  }
  for (const r of ownerPairs) {
    if (!byId.has(r.a) || !byId.has(r.b)) continue;
    const label = r.personName ?? r.householdName ?? "same owner";
    bump(r.a, r.b).owners.add(label);
  }

  // Normalized-name + species candidate pairs computed in memory — the
  // set is small (registry-scale) and the corroboration rule is easier
  // to audit in code than in SQL.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const nameGroups = new Map<string, typeof animalRows>();
  for (const a of animalRows) {
    const key = `${a.species}|${norm(a.name)}`;
    if (!key.endsWith("|")) {
      const list = nameGroups.get(key) ?? [];
      list.push(a);
      nameGroups.set(key, list);
    }
  }

  const closeBirth = (x: string | null, y: string | null): boolean => {
    if (!x || !y) return false;
    return Math.abs(new Date(x).getTime() - new Date(y).getTime()) <= 400 * 86400000;
  };

  const findings: RawFinding[] = [];
  const handled = new Set<string>();

  const emit = (aId: string, bId: string, sig: PairSignals | null) => {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b) return;
    const [x, y] = canonicalEntityIds([aId, bId]);
    const key = `${x}+${y}`;
    if (handled.has(key)) return;
    const evidence: string[] = [];
    let qualifies = false;
    if (sig && sig.chips.size > 0) {
      qualifies = true;
      for (const c of sig.chips) evidence.push(`same microchip ${c}`);
    }
    if (sig && sig.owners.size > 0) {
      for (const o of sig.owners) evidence.push(`same current owner (${o})`);
    }
    const sameName = norm(a.name) !== "" && norm(a.name) === norm(b.name);
    if (sameName) evidence.push(`same name "${a.name}"`);
    if (a.species === b.species) evidence.push(`same species (${a.species})`);
    const sameBirth = a.birthDate != null && a.birthDate === b.birthDate;
    const nearBirth = closeBirth(a.birthDate, b.birthDate);
    if (sameBirth) evidence.push(`same birth date (${a.birthDate})`);
    else if (nearBirth) evidence.push("similar birth dates");
    if (a.sex === b.sex && a.sex !== "unknown") {
      evidence.push(`same sex (${a.sex})`);
    }
    if (!qualifies) {
      // Name+species alone is NOT enough — require corroboration:
      // shared owner, identical birth date, or sex + near-identical age.
      qualifies =
        sameName &&
        a.species === b.species &&
        ((sig?.owners.size ?? 0) > 0 ||
          sameBirth ||
          (a.sex === b.sex && a.sex !== "unknown" && nearBirth));
    }
    if (!qualifies) return;
    handled.add(key);
    findings.push({
      detector: "duplicate-animal",
      severity: "review",
      entityType: "animal",
      entityIds: [x, y],
      label: `Possible duplicate animals: ${a.name} and ${b.name}`,
      detail:
        `${a.registryRef} and ${b.registryRef} may be the same animal. ` +
        "Compare the records side by side before deciding — never merge on a name match alone.",
      evidence,
      href: `/admin/data-quality/merge?a=${x}&b=${y}`,
    });
  };

  for (const [key, sig] of pairs) {
    const [a, b] = key.split("+");
    emit(a, b, sig);
  }
  for (const group of nameGroups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [x, y] = canonicalEntityIds([group[i].id, group[j].id]);
        emit(x, y, pairs.get(`${x}+${y}`) ?? null);
      }
    }
  }
  return findings;
}

// --- Probable duplicate people ---
// Shared normalized email is strong (a typo'd duplicate record is the
// usual cause); same name plus same phone corroborates. Name-only and
// phone-only never qualify — household members legitimately share
// contact channels.
async function detectDuplicatePersons(db: RegistryDb): Promise<RawFinding[]> {
  const rows = await db
    .select({
      id: persons.id,
      fullName: persons.fullName,
      email: persons.email,
      phone: persons.phone,
    })
    .from(persons);
  const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normPhone = (s: string | null) => (s ?? "").replace(/\D+/g, "");

  const byEmail = new Map<string, typeof rows>();
  const byNamePhone = new Map<string, typeof rows>();
  for (const p of rows) {
    const email = p.email?.trim().toLowerCase();
    if (email) {
      const list = byEmail.get(email) ?? [];
      list.push(p);
      byEmail.set(email, list);
    }
    const phone = normPhone(p.phone);
    if (normName(p.fullName) && phone.length >= 5) {
      const key = `${normName(p.fullName)}|${phone}`;
      const list = byNamePhone.get(key) ?? [];
      list.push(p);
      byNamePhone.set(key, list);
    }
  }

  const pairEvidence = new Map<string, Set<string>>();
  const add = (a: string, b: string, evidence: string) => {
    const key = canonicalEntityIds([a, b]).join("+");
    const set = pairEvidence.get(key) ?? new Set<string>();
    set.add(evidence);
    pairEvidence.set(key, set);
  };
  for (const [email, list] of byEmail) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        add(list[i].id, list[j].id, `same email (${email})`);
      }
    }
  }
  for (const [key, list] of byNamePhone) {
    const phone = key.split("|")[1];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        add(list[i].id, list[j].id, `same name and phone (${phone})`);
      }
    }
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...pairEvidence.entries()].map(([key, evidence]) => {
    const [a, b] = key.split("+");
    const pa = byId.get(a);
    const pb = byId.get(b);
    return {
      detector: "duplicate-person" as const,
      severity: "review" as const,
      entityType: "person" as const,
      entityIds: [a, b],
      label: `Possible duplicate people: ${pa?.fullName} and ${pb?.fullName}`,
      detail:
        "These person records share identifying details. Check whether they are the same person — people are never merged automatically, and household members legitimately share contact details.",
      evidence: [...evidence].sort(),
      href: "/admin/persons",
    };
  });
}

// --- Probable duplicate households ---
// A household is a shared contact group (name + address + members), not
// a login. Evidence: a shared member (strong — one person in two
// "households" usually means a split record) or an identical normalized
// address. Name-only similarity never qualifies.
async function detectDuplicateHouseholds(
  db: RegistryDb,
): Promise<RawFinding[]> {
  const houseRows = await db
    .select({ id: households.id, name: households.name, address: households.address })
    .from(households);
  const memberRows = await db
    .select({
      householdId: householdMembers.householdId,
      personId: householdMembers.personId,
      personName: persons.fullName,
    })
    .from(householdMembers)
    .innerJoin(persons, eq(householdMembers.personId, persons.id));
  const byId = new Map(houseRows.map((r) => [r.id, r]));

  const pairEvidence = new Map<string, Set<string>>();
  const add = (a: string, b: string, evidence: string) => {
    const key = canonicalEntityIds([a, b]).join("+");
    const set = pairEvidence.get(key) ?? new Set<string>();
    set.add(evidence);
    pairEvidence.set(key, set);
  };

  const byMember = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = byMember.get(m.personId) ?? [];
    list.push(m.householdId);
    byMember.set(m.personId, list);
  }
  for (const [personId, houseIds] of byMember) {
    const name =
      memberRows.find((m) => m.personId === personId)?.personName ??
      personId;
    for (let i = 0; i < houseIds.length; i++) {
      for (let j = i + 1; j < houseIds.length; j++) {
        add(houseIds[i], houseIds[j], `shared member (${name})`);
      }
    }
  }
  const norm = (s: string | null) =>
    (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < houseRows.length; i++) {
    for (let j = i + 1; j < houseRows.length; j++) {
      const a = houseRows[i];
      const b = houseRows[j];
      if (norm(a.address) && norm(a.address) === norm(b.address)) {
        add(a.id, b.id, `same address (${a.address})`);
      }
    }
  }

  return [...pairEvidence.entries()].map(([key, evidence]) => {
    const [a, b] = key.split("+");
    return {
      detector: "duplicate-household" as const,
      severity: "review" as const,
      entityType: "household" as const,
      entityIds: [a, b],
      label: `Possible duplicate households: ${byId.get(a)?.name} and ${byId.get(b)?.name}`,
      detail:
        "These households may be the same household recorded twice. Review memberships before deciding — households are never merged automatically.",
      evidence: [...evidence].sort(),
      href: "/admin/persons",
    };
  });
}

// --- Lifecycle & ownership integrity ---
const TERMINAL_LIFECYCLES = ["deceased", "moved-off-saba", "merged"];

async function detectOwnerlessActive(db: RegistryDb): Promise<RawFinding[]> {
  // Active animals with no open ownership interval. Adoption-listed
  // animals legitimately have no owner of record — they surface as
  // advisory context, not a defect. Unlisted active animals are the
  // "probably missing data" case.
  const rows = await db
    .select({
      id: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      adoptionStatus: animals.adoptionStatus,
    })
    .from(animals)
    .where(
      and(
        eq(animals.lifecycleStatus, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM ownerships o
          WHERE o.animal_id = ${animals.id} AND o.valid_to IS NULL
        )`,
      ),
    )
    .orderBy(asc(animals.name));
  return rows.map((r) => {
    const listed = r.adoptionStatus !== "not-listed";
    return {
      detector: "animal-no-owner",
      severity: listed ? "advisory" : "review",
      entityType: "animal",
      entityIds: [r.id],
      label: `${r.name} (${r.registryRef}) has no current owner`,
      detail: listed
        ? "Active and adoption-listed with no owner — expected for animals awaiting adoption; shown for awareness."
        : "Active but no open ownership record — if this animal has an owner, the ownership is missing.",
      evidence: [`lifecycle: active`, `listing: ${r.adoptionStatus}`],
      href: `/admin/animals/${r.id}`,
    };
  });
}

async function detectTerminalOpenOwnership(
  db: RegistryDb,
): Promise<RawFinding[]> {
  // Open ownership intervals on terminal animals — the lifecycle
  // transition is supposed to close these; leftovers are contradictory.
  const rows = await db
    .select({
      animalId: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
      ownershipId: ownerships.id,
      personName: persons.fullName,
      householdName: households.name,
      validFrom: ownerships.validFrom,
    })
    .from(ownerships)
    .innerJoin(animals, eq(ownerships.animalId, animals.id))
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        inArray(animals.lifecycleStatus, TERMINAL_LIFECYCLES),
        isNull(ownerships.validTo),
      ),
    );
  return rows.map((r) => ({
    detector: "terminal-open-ownership",
    severity: "review" as const,
    entityType: "animal" as const,
    entityIds: [r.animalId],
    label: `${r.name} (${r.registryRef}) is ${r.lifecycleStatus} but still has an open ownership`,
    detail: `An open ownership to ${r.personName ?? r.householdName ?? "unknown"} since ${r.validFrom} contradicts the animal's ${r.lifecycleStatus} status.`,
    evidence: [
      `lifecycle: ${r.lifecycleStatus}`,
      `open ownership since ${r.validFrom}`,
    ],
    href: `/admin/animals/${r.animalId}`,
  }));
}

async function detectTerminalOpenWork(db: RegistryDb): Promise<RawFinding[]> {
  const followUpRows = await db
    .select({
      animalId: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(followUps)
    .innerJoin(animals, eq(followUps.animalId, animals.id))
    .where(
      and(
        inArray(animals.lifecycleStatus, TERMINAL_LIFECYCLES),
        eq(followUps.status, "open"),
      ),
    )
    .groupBy(animals.id, animals.name, animals.registryRef, animals.lifecycleStatus);
  const expectationRows = await db
    .select({
      animalId: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(clinicExpectations)
    .innerJoin(animals, eq(clinicExpectations.animalId, animals.id))
    .where(
      and(
        inArray(animals.lifecycleStatus, TERMINAL_LIFECYCLES),
        eq(clinicExpectations.status, "expected"),
      ),
    )
    .groupBy(animals.id, animals.name, animals.registryRef, animals.lifecycleStatus);
  return [...followUpRows, ...expectationRows].map((r) => ({
    detector: "terminal-open-work" as const,
    severity: "advisory" as const,
    entityType: "animal" as const,
    entityIds: [r.animalId],
    label: `${r.name} (${r.registryRef}) has ${r.count} open work item(s) but is ${r.lifecycleStatus}`,
    detail:
      "Deceased/off-island animals normally have follow-ups and clinic expectations cancelled by the lifecycle transition — these were left open.",
    evidence: [`lifecycle: ${r.lifecycleStatus}`, `open items: ${r.count}`],
    href: `/admin/animals/${r.animalId}`,
  }));
}

async function detectLifecycleMismatch(db: RegistryDb): Promise<RawFinding[]> {
  // Current lifecycle_status vs the latest history event — divergence
  // means the row was mutated outside the transition write path.
  const current = await db
    .select({
      id: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
    })
    .from(animals);
  const latest = await db
    .select({
      animalId: sql<string>`e.animal_id`,
      toStatus: sql<string>`e.to_status`,
    })
    .from(
      sql`(SELECT DISTINCT ON (animal_id) animal_id, to_status
           FROM animal_lifecycle_events
           ORDER BY animal_id, effective_on DESC, created_at DESC) AS e`,
    );
  const latestByAnimal = new Map(latest.map((r) => [r.animalId, r.toStatus]));
  return current
    .filter((r) => {
      const to = latestByAnimal.get(r.id);
      return to != null && to !== r.lifecycleStatus;
    })
    .map((r) => ({
      detector: "lifecycle-history-mismatch" as const,
      severity: "review" as const,
      entityType: "animal" as const,
      entityIds: [r.id],
      label: `${r.name} (${r.registryRef}) current status doesn't match its history`,
      detail: `The record says "${r.lifecycleStatus}" but the most recent lifecycle event set "${latestByAnimal.get(r.id)}" — the row was changed outside the recorded transition path.`,
      evidence: [
        `current: ${r.lifecycleStatus}`,
        `latest event: ${latestByAnimal.get(r.id)}`,
      ],
      href: `/admin/animals/${r.id}`,
    }));
}

async function detectImpossibleDates(db: RegistryDb): Promise<RawFinding[]> {
  const today = todayIsoDate();
  const rows = await db
    .select({
      id: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      birthDate: animals.birthDate,
      lifecycleEffectiveOn: animals.lifecycleEffectiveOn,
    })
    .from(animals)
    .where(
      or(
        and(isNotNull(animals.birthDate), gt(animals.birthDate, today)),
        and(
          isNotNull(animals.lifecycleEffectiveOn),
          gt(animals.lifecycleEffectiveOn, today),
        ),
      ),
    );
  return rows.map((r) => {
    const evidence: string[] = [];
    if (r.birthDate && r.birthDate > today) {
      evidence.push(`birth date ${r.birthDate} is in the future`);
    }
    if (r.lifecycleEffectiveOn && r.lifecycleEffectiveOn > today) {
      evidence.push(
        `status effective date ${r.lifecycleEffectiveOn} is in the future`,
      );
    }
    return {
      detector: "impossible-dates" as const,
      severity: "review" as const,
      entityType: "animal" as const,
      entityIds: [r.id],
      label: `${r.name} (${r.registryRef}) has an impossible date`,
      detail: "A recorded date is in the future — check the entry.",
      evidence,
      href: `/admin/animals/${r.id}`,
    };
  });
}

// --- Registration & payment integrity ---
async function detectIneligibleRegistrations(
  db: RegistryDb,
): Promise<RawFinding[]> {
  const rows = await db
    .select({
      registrationId: registrations.id,
      animalId: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      lifecycleStatus: animals.lifecycleStatus,
      year: registrations.year,
    })
    .from(registrations)
    .innerJoin(animals, eq(registrations.animalId, animals.id))
    .where(
      and(
        eq(registrations.status, "active"),
        inArray(animals.lifecycleStatus, TERMINAL_LIFECYCLES),
      ),
    );
  return rows.map((r) => ({
    detector: "registration-on-ineligible" as const,
    severity: "review" as const,
    entityType: "animal" as const,
    entityIds: [r.animalId],
    label: `${r.name} (${r.registryRef}) has an active ${r.year} registration but is ${r.lifecycleStatus}`,
    detail:
      "A cancelled-status lifecycle can't hold an active registration — the registration likely needs cancellation or the status is wrong.",
    evidence: [`registration ${r.year}: active`, `lifecycle: ${r.lifecycleStatus}`],
    href: `/admin/animals/${r.animalId}`,
  }));
}

async function detectMoneyOnCancelled(db: RegistryDb): Promise<RawFinding[]> {
  // Confirmed money (payments minus refunds plus signed adjustments)
  // attached to a cancelled registration — either the cancellation was
  // wrong or the ledger needs a reconciling adjustment.
  const net = sql<number>`coalesce(sum(
      CASE ${payments.kind} WHEN 'refund' THEN -${payments.amountCents}
      ELSE ${payments.amountCents} END
    ) FILTER (WHERE ${payments.status} = 'confirmed'), 0)`;
  const rows = await db
    .select({
      registrationId: registrations.id,
      animalId: registrations.animalId,
      year: registrations.year,
      net: sql<number>`${net}::int`,
    })
    .from(registrations)
    .leftJoin(payments, eq(payments.registrationId, registrations.id))
    .where(eq(registrations.status, "cancelled"))
    .groupBy(registrations.id, registrations.animalId, registrations.year)
    .having(sql`${net} <> 0`);
  const names = await loadAnimalLabels(
    rows.map((r) => r.animalId),
    db,
  );
  return rows.map((r) => ({
    detector: "money-on-cancelled-registration" as const,
    severity: "review" as const,
    entityType: "registration" as const,
    entityIds: [r.animalId],
    label: `Cancelled ${r.year} registration for ${names.get(r.animalId) ?? r.animalId} still carries confirmed money`,
    detail: `Confirmed ledger rows net ${(r.net / 100).toFixed(2)} on a cancelled registration — the cancellation or the money needs reconciling.`,
    evidence: [`registration year ${r.year}`, `net confirmed: ${r.net} cents`],
    href: `/admin/animals/${r.animalId}`,
  }));
}

// --- Identifier integrity ---
async function detectMalformedMicrochips(
  db: RegistryDb,
): Promise<RawFinding[]> {
  // Stored chip_number must already be normalized (uppercase A-Z0-9,
  // 4–32 chars). Anything else bypassed write-time validation.
  const rows = await db
    .select({
      id: microchipRecords.id,
      animalId: microchipRecords.animalId,
      chipNumber: microchipRecords.chipNumber,
    })
    .from(microchipRecords)
    .where(sql`${microchipRecords.chipNumber} !~ '^[A-Z0-9]{4,32}$'`);
  const names = await loadAnimalLabels(
    rows.map((r) => r.animalId),
    db,
  );
  return rows.map((r) => ({
    detector: "malformed-microchip" as const,
    severity: "blocking" as const,
    entityType: "animal" as const,
    entityIds: [r.animalId],
    label: `Malformed microchip "${r.chipNumber}" on ${names.get(r.animalId) ?? r.animalId}`,
    detail:
      "This stored chip number violates the canonical normalization — lookups and dedupe can't trust it.",
    evidence: [`stored value: "${r.chipNumber}"`],
    href: `/admin/animals/${r.animalId}`,
  }));
}

const PHOTO_URL_RE = /^(\/|https:\/\/|http:\/\/)\S+$/;

async function detectInvalidPhotos(db: RegistryDb): Promise<RawFinding[]> {
  const rows = await db
    .select({
      id: animals.id,
      name: animals.name,
      registryRef: animals.registryRef,
      photoUrls: animals.photoUrls,
    })
    .from(animals)
    .where(sql`cardinality(${animals.photoUrls}) > 0`);
  return rows
    .map((r): RawFinding | null => {
      const bad = (r.photoUrls ?? []).filter((u) => !PHOTO_URL_RE.test(u));
      if (bad.length === 0) return null;
      return {
        detector: "invalid-animal-photo" as const,
        severity: "review" as const,
        entityType: "animal" as const,
        entityIds: [r.id],
        label: `${r.name} (${r.registryRef}) has an invalid photo URL`,
        detail:
          "A stored photo URL wouldn't pass today's write validation — fix or remove it.",
        evidence: bad.map((u) => `bad URL: ${u.slice(0, 60)}`),
        href: `/admin/animals/${r.id}`,
      };
    })
    .filter((f): f is RawFinding => f != null);
}

// --- Stale confirmations ---
// #166's eligibility query is THE authoritative stale-relationship
// calculation — this only projects its result as findings.
async function detectStaleConfirmations(db: RegistryDb): Promise<RawFinding[]> {
  const rows = await listOwnershipsRequiringConfirmation({}, db);
  return rows.map((r) => ({
    detector: "confirmation-overdue" as const,
    severity: "advisory" as const,
    entityType: "ownership" as const,
    entityIds: [r.ownershipId],
    label: `${r.animalName}'s ownership was due for confirmation on ${r.dueOn}`,
    detail: `The ${r.personName ?? r.householdName ?? "recorded"} relationship hasn't been confirmed this cycle.`,
    evidence: [
      `due ${r.dueOn}`,
      r.lastConfirmedOn
        ? `last confirmed ${r.lastConfirmedOn}`
        : "never confirmed",
    ],
    href: `/admin/animals/${r.animalId}`,
  }));
}

// --- Assembly -------------------------------------------------------------------

const DETECTORS: Record<
  DataQualityDetector,
  (db: RegistryDb) => Promise<RawFinding[]>
> = {
  "microchip-conflict": detectChipConflicts,
  "duplicate-animal": detectDuplicateAnimals,
  "duplicate-person": detectDuplicatePersons,
  "duplicate-household": detectDuplicateHouseholds,
  "animal-no-owner": detectOwnerlessActive,
  "terminal-open-ownership": detectTerminalOpenOwnership,
  "terminal-open-work": detectTerminalOpenWork,
  "lifecycle-history-mismatch": detectLifecycleMismatch,
  "impossible-dates": detectImpossibleDates,
  "registration-on-ineligible": detectIneligibleRegistrations,
  "money-on-cancelled-registration": detectMoneyOnCancelled,
  "malformed-microchip": detectMalformedMicrochips,
  "invalid-animal-photo": detectInvalidPhotos,
  "confirmation-overdue": detectStaleConfirmations,
};

export interface DataQualityFilters {
  category?: DataQualityCategory | "all";
  severity?: DataQualitySeverity | "all";
  entityType?: DataQualityEntityType | "all";
  // 'open' (default) hides suppressed findings; 'suppressed' shows only
  // dismissed ones; 'all' shows everything.
  status?: "open" | "suppressed" | "all";
}

// The workspace read: compute every finding, join persisted review
// decisions in one batch, and mark suppression/staleness.
export async function listDataQualityFindings(
  filters: DataQualityFilters = {},
  db: RegistryDb = getRegistryDb(),
): Promise<DataQualityFinding[]> {
  const raw = (
    await Promise.all(Object.values(DETECTORS).map((run) => run(db)))
  ).flat();

  const reviews = await db.select().from(dataQualityReviews);
  const reviewByKey = new Map(
    reviews.map((r) => [
      `${r.detector}:${[r.entityA, r.entityB].filter(Boolean).join("+")}`,
      r,
    ]),
  );

  const findings: DataQualityFinding[] = raw.map((f) => {
    const fingerprint = fingerprintOf(f);
    const reviewRow = reviewByKey.get(findingKey(f));
    const review: DataQualityReview | null = reviewRow
      ? {
          decision: reviewRow.decision as DataQualityReviewDecision,
          fingerprint: reviewRow.fingerprint,
          decidedByLabel: reviewRow.decidedByLabel,
          decidedAt: reviewRow.updatedAt.toISOString(),
          note: reviewRow.note,
        }
      : null;
    const current = review?.fingerprint === fingerprint;
    return {
      key: findingKey(f),
      detector: f.detector,
      category: DATA_QUALITY_DETECTOR_CATEGORY[f.detector],
      severity: f.severity,
      entityType: f.entityType,
      entityIds: canonicalEntityIds(f.entityIds),
      label: f.label,
      detail: f.detail,
      evidence: f.evidence,
      href: f.href,
      fingerprint,
      review,
      suppressed: review?.decision === "dismissed" && current,
      confirmed: review?.decision === "confirmed" && current,
      staleReview: review != null && !current,
    };
  });

  const status = filters.status ?? "open";
  return findings
    .filter((f) => (status === "suppressed" ? f.suppressed : status === "all" || !f.suppressed))
    .filter((f) => !filters.category || filters.category === "all" || f.category === filters.category)
    .filter((f) => !filters.severity || filters.severity === "all" || f.severity === filters.severity)
    .filter((f) => !filters.entityType || filters.entityType === "all" || f.entityType === filters.entityType)
    .sort((a, b) => {
      const sev =
        DATA_QUALITY_SEVERITY_ORDER[a.severity] -
        DATA_QUALITY_SEVERITY_ORDER[b.severity];
      return sev !== 0 ? sev : a.label.localeCompare(b.label);
    });
}

const DATA_QUALITY_SEVERITY_ORDER: Record<DataQualitySeverity, number> = {
  blocking: 0,
  review: 1,
  advisory: 2,
};

// --- Dashboard summary -----------------------------------------------------------
// #177 seam: one summary source. Open microchip conflicts already have
// their own dashboard item (they're also surfaced here in the workspace),
// so the summary excludes that detector to avoid double-counting.
export interface DataQualitySummary {
  blocking: number;
  review: number;
  advisory: number;
  suppressed: number;
}

export async function getDataQualitySummary(
  db: RegistryDb = getRegistryDb(),
): Promise<DataQualitySummary> {
  const findings = await listDataQualityFindings({ status: "all" }, db);
  const summary: DataQualitySummary = {
    blocking: 0,
    review: 0,
    advisory: 0,
    suppressed: 0,
  };
  for (const f of findings) {
    if (f.detector === "microchip-conflict") continue;
    if (f.suppressed) {
      summary.suppressed += 1;
      continue;
    }
    summary[f.severity] += 1;
  }
  return summary;
}

// --- Human review ----------------------------------------------------------------

export interface RecordReviewInput {
  detector: string;
  entityType: string;
  entityIds: string[];
  fingerprint: string;
  decision: string;
  note?: string | null;
  actorLabel: string;
  actorIdentityId?: string | null;
}

export type ReviewResult =
  | { ok: true }
  | { ok: false; reason: "invalid" };

// Persist a human decision on a finding. The fingerprint is stored so a
// dismissal applies to THIS evidence, not to the pair forever — when the
// detector's evidence materially changes the finding resurfaces.
export async function recordDataQualityReview(
  input: RecordReviewInput,
  db: RegistryDb = getRegistryDb(),
): Promise<ReviewResult> {
  if (
    !isDataQualityDetector(input.detector) ||
    !isDataQualityReviewDecision(input.decision) ||
    typeof input.fingerprint !== "string" ||
    input.fingerprint.length === 0 ||
    input.fingerprint.length > 64
  ) {
    return { ok: false, reason: "invalid" };
  }
  const ids = canonicalEntityIds(input.entityIds);
  if (ids.length < 1 || ids.length > 2) return { ok: false, reason: "invalid" };
  const [entityA, entityB = null] = ids;
  const now = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(dataQualityReviews)
      .where(
        and(
          eq(dataQualityReviews.detector, input.detector),
          eq(dataQualityReviews.entityType, input.entityType),
          eq(dataQualityReviews.entityA, entityA),
          entityB
            ? eq(dataQualityReviews.entityB, entityB)
            : isNull(dataQualityReviews.entityB),
        ),
      );
    if (existing) {
      await tx
        .update(dataQualityReviews)
        .set({
          fingerprint: input.fingerprint,
          decision: input.decision,
          note: input.note?.trim() || null,
          decidedByLabel: input.actorLabel,
          decidedByIdentityId: input.actorIdentityId ?? null,
          updatedAt: now,
        })
        .where(eq(dataQualityReviews.id, existing.id));
    } else {
      await tx.insert(dataQualityReviews).values({
        detector: input.detector,
        entityType: input.entityType,
        entityA,
        entityB,
        fingerprint: input.fingerprint,
        decision: input.decision,
        note: input.note?.trim() || null,
        decidedByLabel: input.actorLabel,
        decidedByIdentityId: input.actorIdentityId ?? null,
      });
    }
    await tx.insert(auditEvents).values({
      actorLabel: input.actorLabel,
      actorIdentityId: input.actorIdentityId ?? null,
      entityType: "data-quality-review",
      entityId: `${input.detector}:${ids.join("+")}`,
      action: `review-${input.decision}`,
      after: {
        detector: input.detector,
        entityIds: ids,
        decision: input.decision,
      },
    });
  });
  return { ok: true };
}

// Reopen a previously decided finding — removes the decision row so the
// finding stands on its current evidence again.
export async function clearDataQualityReview(
  input: Omit<RecordReviewInput, "decision" | "fingerprint">,
  db: RegistryDb = getRegistryDb(),
): Promise<ReviewResult> {
  if (!isDataQualityDetector(input.detector)) {
    return { ok: false, reason: "invalid" };
  }
  const ids = canonicalEntityIds(input.entityIds);
  const [entityA, entityB = null] = ids;
  await db
    .delete(dataQualityReviews)
    .where(
      and(
        eq(dataQualityReviews.detector, input.detector),
        eq(dataQualityReviews.entityType, input.entityType),
        eq(dataQualityReviews.entityA, entityA),
        entityB
          ? eq(dataQualityReviews.entityB, entityB)
          : isNull(dataQualityReviews.entityB),
      ),
    );
  return { ok: true };
}


