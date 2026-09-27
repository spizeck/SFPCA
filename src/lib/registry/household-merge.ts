// Human-confirmed duplicate-household merge (#211).
//
// A household is a shared contact group (name + address + members), not
// a login — so there is no auth gate here, but the merge is still an
// identity decision: staff choose the survivor explicitly, the server
// computes the preview, and execution revalidates under row locks.
//
// What moves: memberships (same person in both households dedupes —
// 'primary' survives if either record held it), ownership intervals
// (duplicate open intervals on the same animal close annotated rather
// than making the survivor a double current owner), and registration
// household links. registrations.owner_label and every other snapshot
// column keep their registration-time truth.
//
// Retirement mirrors persons: no status column — a households row is
// retired exactly when household_merges.retired_household_id references
// it. The unique retired key forbids chains; the survivor is always a
// canonical household.

import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  animals,
  auditEvents,
  authIdentities,
  dataQualityReviews,
  householdMembers,
  householdMerges,
  households,
  ownerships,
  persons,
  registrations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { todayIsoDate } from "../vaccinations";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Types -----------------------------------------------------------------------

export interface HouseholdMergeBlocker {
  code: "self-merge" | "already-merged";
  message: string;
}

export type HouseholdMergeFieldName = "address";

export interface HouseholdMergeFieldConflict {
  field: HouseholdMergeFieldName;
  label: string;
  survivorValue: string | null;
  retiredValue: string | null;
}

export interface HouseholdMergeReparentGroup {
  domain: string;
  label: string;
  count: number;
}

export interface HouseholdMergePreview {
  survivor: HouseholdMergeSide;
  retired: HouseholdMergeSide;
  blockers: HouseholdMergeBlocker[];
  fieldConflicts: HouseholdMergeFieldConflict[];
  autoNotes: string[];
  reparentCounts: HouseholdMergeReparentGroup[];
  fingerprint: string;
}

export type HouseholdMergeResult =
  | { ok: true; mergeId: string; survivorId: string; survivorName: string }
  | {
      ok: false;
      reason: "not-found" | "invalid" | "stale" | "blocked";
      blockers?: HouseholdMergeBlocker[];
      missingFields?: HouseholdMergeFieldName[];
    };

export interface HouseholdMergeSide {
  household: {
    id: string;
    name: string;
    address: string | null;
    createdAt: string;
    updatedAt: string;
  };
  members: { personId: string; fullName: string; role: string }[];
  // Current open ownerships — "owns <animal> now" context.
  currentAnimals: string[];
  merged: boolean;
}

// --- Pair analysis --------------------------------------------------------------

interface HouseholdRow {
  id: string;
  name: string;
  address: string | null;
  updatedAt: Date;
}

interface HouseholdPairAnalysis {
  blockers: HouseholdMergeBlocker[];
  fieldConflicts: HouseholdMergeFieldConflict[];
  autoNotes: string[];
  reparentCounts: HouseholdMergeReparentGroup[];
  membershipDedupes: number;
  duplicateOpenOwnerships: number;
}

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

async function isRetiredHouseholdRows(
  ids: string[],
  db: RegistryDb,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ retiredId: householdMerges.retiredHouseholdId })
    .from(householdMerges)
    .where(inArray(householdMerges.retiredHouseholdId, ids));
  return new Set(rows.map((r) => r.retiredId));
}

// Whether a household is a retired merge duplicate — shared by the
// persons service so retired households stay out of pickers and edits.
export async function isRetiredHousehold(
  householdId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<boolean> {
  if (!UUID_RE.test(householdId)) return false;
  const [row] = await db
    .select({ id: householdMerges.id })
    .from(householdMerges)
    .where(eq(householdMerges.retiredHouseholdId, householdId));
  return !!row;
}

async function analyzeHouseholdPair(
  survivor: HouseholdRow,
  retired: HouseholdRow,
  db: RegistryDb,
): Promise<HouseholdPairAnalysis> {
  const blockers: HouseholdMergeBlocker[] = [];
  const fieldConflicts: HouseholdMergeFieldConflict[] = [];
  const autoNotes: string[] = [];
  const ids = [survivor.id, retired.id];

  if (survivor.id === retired.id) {
    blockers.push({
      code: "self-merge",
      message: "A household cannot be merged into itself.",
    });
  }
  const retiredSet = await isRetiredHouseholdRows(ids, db);
  if (retiredSet.has(retired.id)) {
    blockers.push({
      code: "already-merged",
      message: `${retired.name} is already a merged record — merge into the canonical household instead.`,
    });
  }
  if (retiredSet.has(survivor.id)) {
    blockers.push({
      code: "already-merged",
      message: `${survivor.name} is itself a merged record — merge into a canonical household.`,
    });
  }

  // --- Field conflicts ---
  if (
    survivor.address != null &&
    retired.address != null &&
    norm(survivor.address) !== norm(retired.address)
  ) {
    fieldConflicts.push({
      field: "address",
      label: "Address",
      survivorValue: survivor.address,
      retiredValue: retired.address,
    });
  }
  if (survivor.address == null && retired.address != null) {
    autoNotes.push("Address is filled from the retired household.");
  }
  if (norm(survivor.name) !== norm(retired.name)) {
    autoNotes.push(
      `The name stays "${survivor.name}" — "${retired.name}" is preserved on the retired record and in the audit trail.`,
    );
  }

  // --- Membership dedupe -----------------------------------------------------------
  const memberRows = await db
    .select()
    .from(householdMembers)
    .where(inArray(householdMembers.householdId, ids));
  const survivorMemberIds = new Map(
    memberRows
      .filter((m) => m.householdId === survivor.id)
      .map((m) => [m.personId, m]),
  );
  const retiredMemberships = memberRows.filter(
    (m) => m.householdId === retired.id,
  );
  let membershipDedupes = 0;
  let roleUpgrade = false;
  for (const m of retiredMemberships) {
    const existing = survivorMemberIds.get(m.personId);
    if (existing) {
      membershipDedupes += 1;
      if (m.role === "primary" && existing.role !== "primary") {
        roleUpgrade = true;
      }
    }
  }
  if (membershipDedupes > 0) {
    autoNotes.push(
      `${membershipDedupes} member${membershipDedupes === 1 ? "" : "s"} appear in both households — they stay once on the survivor.${roleUpgrade ? " A 'primary' role is kept where either record had it." : ""}`,
    );
  }

  // --- Ownership collisions --------------------------------------------------------
  const openOwnerships = await db
    .select({
      id: ownerships.id,
      animalId: ownerships.animalId,
      householdId: ownerships.householdId,
      validFrom: ownerships.validFrom,
    })
    .from(ownerships)
    .where(
      and(inArray(ownerships.householdId, ids), isNull(ownerships.validTo)),
    );
  const survivorOpenAnimals = new Set(
    openOwnerships
      .filter((o) => o.householdId === survivor.id)
      .map((o) => o.animalId),
  );
  const duplicateOpenOwnerships = openOwnerships.filter(
    (o) =>
      o.householdId === retired.id &&
      survivorOpenAnimals.has(o.animalId) &&
      o.validFrom < todayIsoDate(),
  ).length;

  const countTable = async (
    table: PgTable,
    column: AnyPgColumn,
  ): Promise<number> => {
    const [r] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(column, retired.id));
    return r?.c ?? 0;
  };

  const reparentCounts: HouseholdMergeReparentGroup[] = [
    {
      domain: "household_members",
      label:
        membershipDedupes > 0
          ? `Members (${membershipDedupes} merge into existing)`
          : "Members",
      count: retiredMemberships.length,
    },
    {
      domain: "ownerships",
      label:
        duplicateOpenOwnerships > 0
          ? `Ownership intervals (${duplicateOpenOwnerships} duplicate open close annotated)`
          : "Ownership intervals",
      count: await countTable(ownerships, ownerships.householdId as never),
    },
    {
      domain: "registrations",
      label: "Registrations (household link)",
      count: await countTable(registrations, registrations.householdId as never),
    },
  ];

  return {
    blockers,
    fieldConflicts,
    autoNotes,
    reparentCounts,
    membershipDedupes,
    duplicateOpenOwnerships,
  };
}

function householdAnalysisFingerprint(
  survivor: HouseholdRow,
  retired: HouseholdRow,
  a: HouseholdPairAnalysis,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        s: survivor.id,
        r: retired.id,
        su: survivor.updatedAt.toISOString(),
        ru: retired.updatedAt.toISOString(),
        blockers: a.blockers.map((b) => b.code),
        conflicts: a.fieldConflicts.map(
          (c) => `${c.field}:${c.survivorValue}<>${c.retiredValue}`,
        ),
        counts: a.reparentCounts.map((c) => `${c.domain}:${c.count}`),
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

async function loadHouseholdRow(
  id: string,
  db: RegistryDb,
): Promise<HouseholdRow | undefined> {
  const [row] = await db
    .select()
    .from(households)
    .where(eq(households.id, id));
  return row;
}

async function householdMergeSide(
  householdId: string,
  db: RegistryDb,
): Promise<HouseholdMergeSide | null> {
  const [household] = await db
    .select()
    .from(households)
    .where(eq(households.id, householdId));
  if (!household) return null;

  const [memberRows, ownershipRows, mergedRows] = await Promise.all([
    db
      .select({
        personId: householdMembers.personId,
        role: householdMembers.role,
        fullName: persons.fullName,
      })
      .from(householdMembers)
      .innerJoin(persons, eq(householdMembers.personId, persons.id))
      .where(eq(householdMembers.householdId, householdId))
      .orderBy(asc(persons.fullName)),
    db
      .select({ animalName: animals.name })
      .from(ownerships)
      .innerJoin(animals, eq(ownerships.animalId, animals.id))
      .where(
        and(
          eq(ownerships.householdId, householdId),
          isNull(ownerships.validTo),
        ),
      ),
    db
      .select({ id: householdMerges.id })
      .from(householdMerges)
      .where(eq(householdMerges.retiredHouseholdId, householdId)),
  ]);

  return {
    household: {
      id: household.id,
      name: household.name,
      address: household.address,
      createdAt: household.createdAt.toISOString(),
      updatedAt: household.updatedAt.toISOString(),
    },
    members: memberRows.map((m) => ({
      personId: m.personId,
      fullName: m.fullName,
      role: m.role,
    })),
    currentAnimals: ownershipRows.map((o) => o.animalName),
    merged: mergedRows.length > 0,
  };
}

export async function getHouseholdMergePair(
  aId: string,
  bId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ a: HouseholdMergeSide; b: HouseholdMergeSide } | null> {
  if (!UUID_RE.test(aId) || !UUID_RE.test(bId)) return null;
  const [a, b] = await Promise.all([
    householdMergeSide(aId, db),
    householdMergeSide(bId, db),
  ]);
  if (!a || !b) return null;
  return { a, b };
}

// --- Preview ------------------------------------------------------------------------

export type HouseholdMergePreviewResult =
  | { ok: true; preview: HouseholdMergePreview }
  | { ok: false; reason: "not-found" | "invalid"; message: string };

export async function previewHouseholdMerge(
  survivorId: string,
  retiredId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdMergePreviewResult> {
  if (!UUID_RE.test(survivorId) || !UUID_RE.test(retiredId)) {
    return { ok: false, reason: "invalid", message: "Unknown household id." };
  }
  if (survivorId === retiredId) {
    return {
      ok: false,
      reason: "invalid",
      message: "A household cannot be merged into itself.",
    };
  }
  const [survivor, retired] = await Promise.all([
    loadHouseholdRow(survivorId, db),
    loadHouseholdRow(retiredId, db),
  ]);
  if (!survivor || !retired) {
    return { ok: false, reason: "not-found", message: "Household not found." };
  }
  const analysis = await analyzeHouseholdPair(survivor, retired, db);
  const [sSide, rSide] = await Promise.all([
    householdMergeSide(survivorId, db),
    householdMergeSide(retiredId, db),
  ]);
  return {
    ok: true,
    preview: {
      survivor: sSide!,
      retired: rSide!,
      blockers: analysis.blockers,
      fieldConflicts: analysis.fieldConflicts,
      autoNotes: analysis.autoNotes,
      reparentCounts: analysis.reparentCounts.filter((c) => c.count > 0),
      fingerprint: householdAnalysisFingerprint(survivor, retired, analysis),
    },
  };
}

// --- Execute ---------------------------------------------------------------------------

export interface HouseholdMergeInput {
  survivorId: string;
  retiredId: string;
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
  actorLabel: string;
  actorIdentityId?: string | null;
}

export async function executeHouseholdMerge(
  input: HouseholdMergeInput,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdMergeResult> {
  if (!UUID_RE.test(input.survivorId) || !UUID_RE.test(input.retiredId)) {
    return { ok: false, reason: "invalid" };
  }
  if (input.survivorId === input.retiredId) {
    return {
      ok: false,
      reason: "invalid",
      blockers: [
        {
          code: "self-merge",
          message: "A household cannot be merged into itself.",
        },
      ],
    };
  }
  const today = todayIsoDate();

  return db.transaction(async (tx) => {
    const [first, second] = [input.survivorId, input.retiredId].sort();
    await tx
      .select({ id: households.id })
      .from(households)
      .where(inArray(households.id, [first, second]))
      .for("update");

    const survivor = await loadHouseholdRow(input.survivorId, tx);
    const retired = await loadHouseholdRow(input.retiredId, tx);
    if (!survivor || !retired) {
      return { ok: false as const, reason: "not-found" as const };
    }

    const analysis = await analyzeHouseholdPair(survivor, retired, tx);
    if (analysis.blockers.length > 0) {
      return {
        ok: false as const,
        reason: "blocked" as const,
        blockers: analysis.blockers,
      };
    }
    const freshFingerprint = householdAnalysisFingerprint(
      survivor,
      retired,
      analysis,
    );
    if (freshFingerprint !== input.fingerprint) {
      return { ok: false as const, reason: "stale" as const };
    }

    const missing = analysis.fieldConflicts
      .filter(
        (c) =>
          input.fieldChoices[c.field] !== "survivor" &&
          input.fieldChoices[c.field] !== "retired",
      )
      .map((c) => c.field);
    if (missing.length > 0) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        missingFields: missing,
      };
    }

    const moved: Record<string, number> = {};

    // --- Memberships ----------------------------------------------------------------------
    // Move the retired household's members to the survivor; a person in
    // both keeps ONE row — 'primary' wins where either record had it.
    const retiredMemberships = await tx
      .select()
      .from(householdMembers)
      .where(eq(householdMembers.householdId, retired.id));
    let membershipDedupes = 0;
    for (const m of retiredMemberships) {
      const [existing] = await tx
        .select()
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, survivor.id),
            eq(householdMembers.personId, m.personId),
          ),
        );
      if (existing) {
        membershipDedupes += 1;
        if (m.role === "primary" && existing.role !== "primary") {
          await tx
            .update(householdMembers)
            .set({ role: "primary" })
            .where(
              and(
                eq(householdMembers.householdId, survivor.id),
                eq(householdMembers.personId, m.personId),
              ),
            );
        }
        await tx
          .delete(householdMembers)
          .where(
            and(
              eq(householdMembers.householdId, retired.id),
              eq(householdMembers.personId, m.personId),
            ),
          );
      } else {
        await tx
          .update(householdMembers)
          .set({ householdId: survivor.id })
          .where(
            and(
              eq(householdMembers.householdId, retired.id),
              eq(householdMembers.personId, m.personId),
            ),
          );
      }
    }
    moved["household_members"] = retiredMemberships.length - membershipDedupes;
    moved["household_members_merged"] = membershipDedupes;

    // --- Ownerships ---------------------------------------------------------------------------
    const survivorOpenAnimals = new Set(
      (
        await tx
          .select({ animalId: ownerships.animalId })
          .from(ownerships)
          .where(
            and(
              eq(ownerships.householdId, survivor.id),
              isNull(ownerships.validTo),
            ),
          )
      ).map((o) => o.animalId),
    );
    const retiredOpen = await tx
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.householdId, retired.id),
          isNull(ownerships.validTo),
        ),
      );
    const closedIds = new Set<string>();
    for (const o of retiredOpen) {
      if (survivorOpenAnimals.has(o.animalId) && o.validFrom < today) {
        await tx
          .update(ownerships)
          .set({
            validTo: today,
            note: [o.note, `Closed by household merge — duplicate interval`]
              .filter(Boolean)
              .join(" "),
          })
          .where(eq(ownerships.id, o.id));
        closedIds.add(o.id);
      }
    }
    // Intervals closed by this merge stay on the retired household.
    const movedOwnerships = await tx
      .update(ownerships)
      .set({ householdId: survivor.id })
      .where(
        and(
          eq(ownerships.householdId, retired.id),
          closedIds.size
            ? notInArray(ownerships.id, [...closedIds])
            : undefined,
        ),
      )
      .returning();
    moved["ownerships"] = movedOwnerships.length;
    moved["ownerships_closed"] = closedIds.size;

    // --- Registrations -------------------------------------------------------------------------
    // Relational link reparents; owner_label snapshots keep the
    // registration-time truth.
    const movedRegs = await tx
      .update(registrations)
      .set({ householdId: survivor.id, updatedAt: new Date() })
      .where(eq(registrations.householdId, retired.id))
      .returning();
    moved["registrations"] = movedRegs.length;

    // --- Identity fields ---------------------------------------------------------------------
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.fieldChoices.address === "retired") {
      updates.address = retired.address;
    } else if (survivor.address == null && retired.address != null) {
      updates.address = retired.address;
    }
    await tx
      .update(households)
      .set(updates)
      .where(eq(households.id, survivor.id));

    // --- Retire the duplicate ------------------------------------------------------------------
    const [merge] = await tx
      .insert(householdMerges)
      .values({
        retiredHouseholdId: retired.id,
        survivorHouseholdId: survivor.id,
        retiredName: retired.name,
        retiredAddress: retired.address,
        fieldChoices: input.fieldChoices,
        movedCounts: moved,
        note: input.note?.trim() || null,
        mergedByLabel: input.actorLabel,
        mergedByIdentityId: input.actorIdentityId ?? null,
      })
      .returning();

    await tx.insert(auditEvents).values([
      {
        actorLabel: input.actorLabel,
        actorIdentityId: input.actorIdentityId ?? null,
        entityType: "household",
        entityId: retired.id,
        action: "merge-retire",
        after: {
          mergedInto: survivor.id,
          survivorName: survivor.name,
          fieldChoices: input.fieldChoices,
          moved,
        },
      },
      {
        actorLabel: input.actorLabel,
        actorIdentityId: input.actorIdentityId ?? null,
        entityType: "household",
        entityId: survivor.id,
        action: "merge-absorb",
        after: {
          retiredId: retired.id,
          retiredName: retired.name,
          fieldChoices: input.fieldChoices,
          moved,
        },
      },
    ]);

    // A successful merge IS the confirmed review for the duplicate pair.
    const [a, b] = [survivor.id, retired.id].sort();
    await tx
      .insert(dataQualityReviews)
      .values({
        detector: "duplicate-household",
        entityType: "household",
        entityA: a,
        entityB: b,
        fingerprint: "merge",
        decision: "confirmed",
        note: `Merged into ${survivor.name} (merge ${merge.id})`,
        decidedByLabel: input.actorLabel,
        decidedByIdentityId: input.actorIdentityId ?? null,
      })
      .onConflictDoNothing();

    return {
      ok: true as const,
      mergeId: merge.id,
      survivorId: survivor.id,
      survivorName: survivor.name,
    };
  });
}

// --- Retired-identity resolution ------------------------------------------------

export interface HouseholdMergeInfo {
  status: "merged" | "canonical";
  survivor: { id: string; name: string } | null;
  mergedAt: string | null;
  mergedByLabel: string | null;
  absorbed: { id: string; name: string; mergedAt: string }[];
}

export async function getHouseholdMergeInfo(
  householdId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdMergeInfo | null> {
  if (!UUID_RE.test(householdId)) return null;
  const [asRetired] = await db
    .select({
      survivorId: householdMerges.survivorHouseholdId,
      survivorName: households.name,
      mergedAt: householdMerges.createdAt,
      mergedByLabel: householdMerges.mergedByLabel,
    })
    .from(householdMerges)
    .innerJoin(households, eq(householdMerges.survivorHouseholdId, households.id))
    .where(eq(householdMerges.retiredHouseholdId, householdId));
  if (asRetired) {
    return {
      status: "merged",
      survivor: { id: asRetired.survivorId, name: asRetired.survivorName },
      mergedAt: asRetired.mergedAt.toISOString(),
      mergedByLabel: asRetired.mergedByLabel,
      absorbed: [],
    };
  }
  const absorbedRows = await db
    .select({
      retiredId: householdMerges.retiredHouseholdId,
      retiredName: householdMerges.retiredName,
      mergedAt: householdMerges.createdAt,
    })
    .from(householdMerges)
    .where(eq(householdMerges.survivorHouseholdId, householdId))
    .orderBy(asc(householdMerges.createdAt));
  return {
    status: "canonical",
    survivor: null,
    mergedAt: null,
    mergedByLabel: null,
    absorbed: absorbedRows.map((r) => ({
      id: r.retiredId,
      name: r.retiredName,
      mergedAt: r.mergedAt.toISOString(),
    })),
  };
}

export async function resolveHouseholdMergeTarget(
  householdId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ canonicalId: string; wasMerged: boolean } | null> {
  const [row] = await db
    .select({ id: households.id })
    .from(households)
    .where(eq(households.id, householdId));
  if (!row) return null;
  const merge = await getHouseholdMergeInfo(householdId, db);
  if (merge?.status === "merged" && merge.survivor) {
    return { canonicalId: merge.survivor.id, wasMerged: true };
  }
  return { canonicalId: householdId, wasMerged: false };
}
