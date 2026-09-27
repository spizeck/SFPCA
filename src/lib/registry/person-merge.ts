// Human-confirmed duplicate-person merge (#211).
//
// Same staged workflow as the animal merge (#178), with the additional
// boundary that makes people different: AUTHENTICATION. A person's
// auth_identities row is a real user's login — detection can call two
// records "probably the same person", but only a human can decide, and
// the merge can never silently fuse two authenticated accounts.
//
// The auth gate (enforced in analyzePair, re-checked under row locks):
//   - retired has a linked identity AND survivor does too → BLOCKED
//     (dual-auth). Two independently authenticated accounts require
//     manual identity reconciliation — no merge path moves or deletes
//     a login.
//   - retired has a linked identity and survivor does not → BLOCKED
//     (auth-direction). The merge direction must keep the
//     authenticated record; staff swap survivor/retired. There is no
//     identity-transfer operation — deliberately.
//   - only the survivor may hold identities when the merge runs, so a
//     retired person is NEVER an authenticated account afterwards.
//     resolveOwnerSession therefore stays truthful without lineage
//     lookups: if a session resolves to a person, that person is
//     canonical.
//
// admin_users rows reparent to the survivor as bookkeeping ("this staff
// account belongs to this person") — role, email, and auth_identity_id
// are never touched, so a merge neither grants nor revokes staff
// access. If the retired person is a signed-in admin the auth gate
// blocks the merge first anyway.
//
// Retirement has no status column: a persons row is retired exactly
// when person_merges.retired_person_id references it. The row keeps its
// field values — snapshot columns elsewhere (registrations.owner_label,
// communications.recipient, owner_requests.detail) are immutable either
// way — and every relational reference reparents to the survivor inside
// one locked transaction.
//
// Merges never chain: person_merges.retired_person_id is unique, a
// retired person can never be a merge input, and the survivor is always
// a canonical person — so a retired alias resolves in exactly one hop.

import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  adminUsers,
  animals,
  auditEvents,
  authIdentities,
  clinicExpectations,
  communicationPreferences,
  communications,
  dataQualityReviews,
  followUps,
  householdMembers,
  households,
  ownerRequests,
  ownershipConfirmations,
  ownerships,
  payments,
  personMerges,
  persons,
  registrationSubmissions,
  registrations,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { todayIsoDate } from "../vaccinations";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Types -----------------------------------------------------------------------

export interface PersonMergeBlocker {
  code:
    | "self-merge"
    | "already-merged"
    | "dual-auth"
    | "auth-direction";
  message: string;
}

export type PersonMergeFieldName =
  | "email"
  | "phone"
  | "address"
  | "preferredChannel";

export interface PersonMergeFieldConflict {
  field: PersonMergeFieldName;
  label: string;
  survivorValue: string | null;
  retiredValue: string | null;
}

export interface PersonMergeReparentGroup {
  domain: string;
  label: string;
  count: number;
}

export interface PersonMergePreview {
  survivor: PersonMergeSide;
  retired: PersonMergeSide;
  blockers: PersonMergeBlocker[];
  // Contact fields where both sides disagree — staff MUST pick.
  fieldConflicts: PersonMergeFieldConflict[];
  // What the merge combines or keeps automatically, in plain language.
  autoNotes: string[];
  reparentCounts: PersonMergeReparentGroup[];
  fingerprint: string;
}

export type PersonMergeResult =
  | { ok: true; mergeId: string; survivorId: string; survivorName: string }
  | {
      ok: false;
      reason: "not-found" | "invalid" | "stale" | "blocked";
      blockers?: PersonMergeBlocker[];
      missingFields?: PersonMergeFieldName[];
    };

// What the merge page renders for one side — enough identifying context
// (contact details, login state, households, owned animals) for staff to
// tell the records apart.
export interface PersonMergeSide {
  person: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    preferredChannel: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
  };
  // Linked sign-in accounts — the auth gate's evidence. Email is the
  // provider snapshot, displayed so staff recognize the account.
  identities: { id: string; provider: string; email: string | null }[];
  // admin_users rows linked to this person — access itself is keyed by
  // email there; the link is bookkeeping the merge reparents.
  adminLinks: number;
  households: { id: string; name: string; role: string }[];
  // Current open ownerships — "owns <animal> now" context.
  currentAnimals: string[];
  // Whether this record is already a retired merge duplicate.
  merged: boolean;
}

// --- Pair analysis ---------------------------------------------------------------
// Shared by preview and execute — execute re-runs it under row locks so
// the plan staff confirmed is the plan that executes (or it refuses).

interface PersonRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  preferredChannel: string | null;
  notes: string | null;
  updatedAt: Date;
}

interface PersonPairAnalysis {
  blockers: PersonMergeBlocker[];
  fieldConflicts: PersonMergeFieldConflict[];
  autoNotes: string[];
  reparentCounts: PersonMergeReparentGroup[];
  // Retired memberships that collapse into an existing survivor
  // membership in the same household (dedupe, role = primary if either).
  membershipDedupes: number;
  // Retired open ownership intervals closed because the survivor side
  // already owns the same animal — history preserved, no duplicate
  // current owner.
  duplicateOpenOwnerships: number;
  // communication_preferences rows that collide on (channel, kind) and
  // merge into the survivor's row with the opt-out union.
  preferenceCollisions: number;
}

const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

async function analyzePersonPair(
  survivor: PersonRow,
  retired: PersonRow,
  db: RegistryDb,
): Promise<PersonPairAnalysis> {
  const blockers: PersonMergeBlocker[] = [];
  const fieldConflicts: PersonMergeFieldConflict[] = [];
  const autoNotes: string[] = [];
  const ids = [survivor.id, retired.id];

  // --- Hard blockers ---
  if (survivor.id === retired.id) {
    blockers.push({
      code: "self-merge",
      message: "A person cannot be merged into themselves.",
    });
  }
  const retiredMerge = await isRetiredPersonRows(ids, db);
  if (retiredMerge.has(retired.id)) {
    blockers.push({
      code: "already-merged",
      message: `${retired.fullName} is already a merged record — merge into the canonical person instead.`,
    });
  }
  if (retiredMerge.has(survivor.id)) {
    blockers.push({
      code: "already-merged",
      message: `${survivor.fullName} is itself a merged record — merge into a canonical person.`,
    });
  }

  // --- Authentication gate -----------------------------------------------------
  // auth_identities are real logins. Two authenticated records can
  // never silently fuse; an identity on the retired side means the
  // direction is wrong. Neither rule moves or deletes a login.
  const identityRows = await db
    .select({
      personId: authIdentities.personId,
      provider: authIdentities.provider,
      email: authIdentities.email,
    })
    .from(authIdentities)
    .where(inArray(authIdentities.personId, ids));
  const survivorIdentities = identityRows.filter(
    (r) => r.personId === survivor.id,
  );
  const retiredIdentities = identityRows.filter(
    (r) => r.personId === retired.id,
  );
  if (survivorIdentities.length > 0 && retiredIdentities.length > 0) {
    blockers.push({
      code: "dual-auth",
      message:
        "Both records are linked to sign-in accounts. Two independently authenticated people can never be merged automatically — reconcile the accounts manually first (or mark this pair not duplicates).",
    });
  } else if (retiredIdentities.length > 0) {
    blockers.push({
      code: "auth-direction",
      message: `${retired.fullName} has a linked sign-in account and ${survivor.fullName} does not. A merge never moves a login — swap the direction so the authenticated record is the one kept.`,
    });
  }

  // --- Field conflicts (both sides set and disagreeing) ---
  const conflict = (
    field: PersonMergeFieldName,
    label: string,
    a: string | null,
    b: string | null,
  ) => {
    if (a != null && b != null && norm(a) !== norm(b)) {
      fieldConflicts.push({
        field,
        label,
        survivorValue: a,
        retiredValue: b,
      });
      return true;
    }
    return false;
  };

  conflict("email", "Email", survivor.email, retired.email);
  conflict("phone", "Phone", survivor.phone, retired.phone);
  conflict("address", "Address", survivor.address, retired.address);
  conflict(
    "preferredChannel",
    "Preferred contact",
    survivor.preferredChannel,
    retired.preferredChannel,
  );

  // --- Automatic combinations (shown, not chosen) ---
  for (const [label, s, r] of [
    ["Email", survivor.email, retired.email],
    ["Phone", survivor.phone, retired.phone],
    ["Address", survivor.address, retired.address],
    ["Preferred contact", survivor.preferredChannel, retired.preferredChannel],
  ] as const) {
    if (s == null && r != null) {
      autoNotes.push(`${label} is filled from the retired record.`);
    }
  }
  if (norm(survivor.fullName) !== norm(retired.fullName)) {
    autoNotes.push(
      `The name stays "${survivor.fullName}" — "${retired.fullName}" is preserved on the retired record and in the audit trail.`,
    );
  }
  if (retired.notes && norm(retired.notes) !== norm(survivor.notes)) {
    autoNotes.push(
      survivor.notes
        ? "Staff notes from both records are kept, separated."
        : "Staff notes are filled from the retired record.",
    );
  }

  // --- Household membership dedupe ---------------------------------------------
  const memberRows = await db
    .select()
    .from(householdMembers)
    .where(inArray(householdMembers.personId, ids));
  const survivorHouseholds = new Map(
    memberRows
      .filter((m) => m.personId === survivor.id)
      .map((m) => [m.householdId, m]),
  );
  const retiredMemberships = memberRows.filter(
    (m) => m.personId === retired.id,
  );
  let membershipDedupes = 0;
  for (const m of retiredMemberships) {
    const existing = survivorHouseholds.get(m.householdId);
    if (existing) {
      membershipDedupes += 1;
      if (existing.role !== m.role) {
        autoNotes.push(
          `Both records are members of the same household — the merged person keeps the 'primary' role where either record had it.`,
        );
      }
    }
  }

  // --- Ownership collisions ------------------------------------------------------
  // Reparenting every open interval blindly could leave the SAME person
  // holding two open intervals on one animal — a duplicate current
  // owner. Retired-side open intervals duplicating a survivor-side one
  // close today annotated 'merge'; the historical row survives.
  const openOwnerships = await db
    .select({
      id: ownerships.id,
      animalId: ownerships.animalId,
      personId: ownerships.personId,
      validFrom: ownerships.validFrom,
    })
    .from(ownerships)
    .where(
      and(inArray(ownerships.personId, ids), isNull(ownerships.validTo)),
    );
  const survivorOpenAnimals = new Set(
    openOwnerships
      .filter((o) => o.personId === survivor.id)
      .map((o) => o.animalId),
  );
  const duplicateOpenOwnerships = openOwnerships.filter(
    (o) =>
      o.personId === retired.id &&
      survivorOpenAnimals.has(o.animalId) &&
      o.validFrom < todayIsoDate(),
  ).length;

  // --- Reparent counts ---------------------------------------------------------
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

  const retiredPrefs = await db
    .select()
    .from(communicationPreferences)
    .where(eq(communicationPreferences.personId, retired.id));
  const survivorPrefs = await db
    .select({ channel: communicationPreferences.channel, kind: communicationPreferences.kind })
    .from(communicationPreferences)
    .where(eq(communicationPreferences.personId, survivor.id));
  const prefKeys = new Set(survivorPrefs.map((p) => `${p.channel}|${p.kind}`));
  const preferenceCollisions = retiredPrefs.filter((p) =>
    prefKeys.has(`${p.channel}|${p.kind}`),
  ).length;

  const reparentCounts: PersonMergeReparentGroup[] = [
    {
      domain: "ownerships",
      label:
        duplicateOpenOwnerships > 0
          ? `Ownership intervals (${duplicateOpenOwnerships} duplicate open close annotated)`
          : "Ownership intervals",
      count: await countTable(ownerships, ownerships.personId as never),
    },
    {
      domain: "ownership_confirmations",
      label: "Ownership confirmations",
      count: await countTable(
        ownershipConfirmations,
        ownershipConfirmations.personId as never,
      ),
    },
    {
      domain: "household_members",
      label:
        membershipDedupes > 0
          ? `Household memberships (${membershipDedupes} merge into existing)`
          : "Household memberships",
      count: retiredMemberships.length,
    },
    {
      domain: "owner_requests",
      label: "Owner requests",
      count: await countTable(ownerRequests, ownerRequests.personId as never),
    },
    {
      domain: "registration_submissions",
      label: "Registration submissions",
      count: await countTable(
        registrationSubmissions,
        registrationSubmissions.personId as never,
      ),
    },
    {
      domain: "registrations",
      label: "Registrations (owner link)",
      count: await countTable(registrations, registrations.personId as never),
    },
    {
      domain: "payments",
      label: "Payments (payer link — amounts unchanged)",
      count: await countTable(payments, payments.personId as never),
    },
    {
      domain: "follow_ups",
      label: "Follow-ups",
      count: await countTable(followUps, followUps.personId as never),
    },
    {
      domain: "clinic_expectations",
      label: "Clinic expectations",
      count: await countTable(
        clinicExpectations,
        clinicExpectations.personId as never,
      ),
    },
    {
      domain: "communications",
      label: "Communications",
      count: await countTable(communications, communications.personId as never),
    },
    {
      domain: "communication_preferences",
      label:
        preferenceCollisions > 0
          ? `Communication preferences (${preferenceCollisions} merge into existing — opt-outs kept)`
          : "Communication preferences",
      count: retiredPrefs.length,
    },
    {
      domain: "admin_users",
      label: "Staff account links (access itself is unchanged)",
      count: await countTable(adminUsers, adminUsers.personId as never),
    },
  ];

  return {
    blockers,
    fieldConflicts,
    autoNotes,
    reparentCounts,
    membershipDedupes,
    duplicateOpenOwnerships,
    preferenceCollisions,
  };
}

async function isRetiredPersonRows(
  ids: string[],
  db: RegistryDb,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ retiredId: personMerges.retiredPersonId })
    .from(personMerges)
    .where(inArray(personMerges.retiredPersonId, ids));
  return new Set(rows.map((r) => r.retiredId));
}

// Whether a person is a retired merge duplicate — shared by the persons
// service so retired rows stay out of pickers and edits.
export async function isRetiredPerson(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<boolean> {
  if (!UUID_RE.test(personId)) return false;
  const [row] = await db
    .select({ id: personMerges.id })
    .from(personMerges)
    .where(eq(personMerges.retiredPersonId, personId));
  return !!row;
}

function personAnalysisFingerprint(
  survivor: PersonRow,
  retired: PersonRow,
  a: PersonPairAnalysis,
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

async function loadPersonRow(
  id: string,
  db: RegistryDb,
): Promise<PersonRow | undefined> {
  const [row] = await db.select().from(persons).where(eq(persons.id, id));
  return row;
}

async function personMergeSide(
  personId: string,
  db: RegistryDb,
): Promise<PersonMergeSide | null> {
  const [person] = await db
    .select()
    .from(persons)
    .where(eq(persons.id, personId));
  if (!person) return null;

  const [identityRows, adminRows, memberRows, ownershipRows, mergedRows] =
    await Promise.all([
      db
        .select({
          id: authIdentities.id,
          provider: authIdentities.provider,
          email: authIdentities.email,
        })
        .from(authIdentities)
        .where(eq(authIdentities.personId, personId)),
      db
        .select({ id: adminUsers.id })
        .from(adminUsers)
        .where(eq(adminUsers.personId, personId)),
      db
        .select({
          householdId: householdMembers.householdId,
          role: householdMembers.role,
          name: households.name,
        })
        .from(householdMembers)
        .innerJoin(households, eq(householdMembers.householdId, households.id))
        .where(eq(householdMembers.personId, personId)),
      db
        .select({ animalName: animals.name })
        .from(ownerships)
        .innerJoin(animals, eq(ownerships.animalId, animals.id))
        .where(
          and(eq(ownerships.personId, personId), isNull(ownerships.validTo)),
        ),
      db
        .select({ id: personMerges.id })
        .from(personMerges)
        .where(eq(personMerges.retiredPersonId, personId)),
    ]);

  return {
    person: {
      id: person.id,
      fullName: person.fullName,
      email: person.email,
      phone: person.phone,
      address: person.address,
      preferredChannel: person.preferredChannel,
      notes: person.notes,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
    },
    identities: identityRows,
    adminLinks: adminRows.length,
    households: memberRows.map((m) => ({
      id: m.householdId,
      name: m.name,
      role: m.role,
    })),
    currentAnimals: ownershipRows.map((o) => o.animalName),
    merged: mergedRows.length > 0,
  };
}

export async function getPersonMergePair(
  aId: string,
  bId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ a: PersonMergeSide; b: PersonMergeSide } | null> {
  if (!UUID_RE.test(aId) || !UUID_RE.test(bId)) return null;
  const [a, b] = await Promise.all([
    personMergeSide(aId, db),
    personMergeSide(bId, db),
  ]);
  if (!a || !b) return null;
  return { a, b };
}

// --- Preview ---------------------------------------------------------------------

export type PersonMergePreviewResult =
  | { ok: true; preview: PersonMergePreview }
  | { ok: false; reason: "not-found" | "invalid"; message: string };

export async function previewPersonMerge(
  survivorId: string,
  retiredId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMergePreviewResult> {
  if (!UUID_RE.test(survivorId) || !UUID_RE.test(retiredId)) {
    return { ok: false, reason: "invalid", message: "Unknown person id." };
  }
  if (survivorId === retiredId) {
    return {
      ok: false,
      reason: "invalid",
      message: "A person cannot be merged into themselves.",
    };
  }
  const [survivor, retired] = await Promise.all([
    loadPersonRow(survivorId, db),
    loadPersonRow(retiredId, db),
  ]);
  if (!survivor || !retired) {
    return { ok: false, reason: "not-found", message: "Person not found." };
  }
  const analysis = await analyzePersonPair(survivor, retired, db);
  const [sSide, rSide] = await Promise.all([
    personMergeSide(survivorId, db),
    personMergeSide(retiredId, db),
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
      fingerprint: personAnalysisFingerprint(survivor, retired, analysis),
    },
  };
}

// --- Execute -----------------------------------------------------------------------

export interface PersonMergeInput {
  survivorId: string;
  retiredId: string;
  // Field conflict resolutions: field → 'survivor' | 'retired'.
  fieldChoices: Record<string, "survivor" | "retired">;
  fingerprint: string;
  note?: string | null;
  actorLabel: string;
  actorIdentityId?: string | null;
}

// Staff-chosen conflict values plus automatic fill-the-blank combines —
// returns the persons update set. fullName always keeps the survivor's;
// the retired name lives on the retired row and the merge record.
function personSurvivorUpdates(
  survivor: PersonRow,
  retired: PersonRow,
  analysis: PersonPairAnalysis,
  choices: Record<string, "survivor" | "retired">,
): Record<string, unknown> {
  const pick = <T>(field: PersonMergeFieldName, a: T, b: T): T =>
    choices[field] === "retired" ? b : a;

  const updates: Record<string, unknown> = {};
  for (const c of analysis.fieldConflicts) {
    if (c.field === "email") updates.email = pick(c.field, survivor.email, retired.email);
    if (c.field === "phone") updates.phone = pick(c.field, survivor.phone, retired.phone);
    if (c.field === "address") updates.address = pick(c.field, survivor.address, retired.address);
    if (c.field === "preferredChannel") {
      updates.preferredChannel = pick(c.field, survivor.preferredChannel, retired.preferredChannel);
    }
  }
  // Fill-the-blank combines.
  if (survivor.email == null && retired.email != null) updates.email = retired.email;
  if (survivor.phone == null && retired.phone != null) updates.phone = retired.phone;
  if (survivor.address == null && retired.address != null) updates.address = retired.address;
  if (survivor.preferredChannel == null && retired.preferredChannel != null) {
    updates.preferredChannel = retired.preferredChannel;
  }
  const notes = [survivor.notes, retired.notes]
    .filter((v): v is string => v != null)
    .filter(
      (v, i, a) => a.findIndex((x) => norm(x) === norm(v)) === i,
    );
  if (notes.length > (survivor.notes ? 1 : 0)) {
    updates.notes = notes.join(" | ");
  }
  updates.updatedAt = new Date();
  return updates;
}

export async function executePersonMerge(
  input: PersonMergeInput,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMergeResult> {
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
          message: "A person cannot be merged into themselves.",
        },
      ],
    };
  }
  const today = todayIsoDate();

  return db.transaction(async (tx) => {
    // Lock both person rows in deterministic order — a concurrent merge,
    // identity link, or ownership write waits and then sees the
    // committed outcome rather than interleaving.
    const [first, second] = [input.survivorId, input.retiredId].sort();
    await tx
      .select({ id: persons.id })
      .from(persons)
      .where(inArray(persons.id, [first, second]))
      .for("update");

    const survivor = await loadPersonRow(input.survivorId, tx);
    const retired = await loadPersonRow(input.retiredId, tx);
    if (!survivor || !retired) {
      return { ok: false as const, reason: "not-found" as const };
    }

    const analysis = await analyzePersonPair(survivor, retired, tx);
    if (analysis.blockers.length > 0) {
      return {
        ok: false as const,
        reason: "blocked" as const,
        blockers: analysis.blockers,
      };
    }
    const freshFingerprint = personAnalysisFingerprint(
      survivor,
      retired,
      analysis,
    );
    if (freshFingerprint !== input.fingerprint) {
      // Something changed since the preview — staff must look again.
      return { ok: false as const, reason: "stale" as const };
    }

    // Every displayed conflict must have an explicit staff choice.
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

    // --- Household memberships ---------------------------------------------------
    // Reparent; where the survivor is already in the same household the
    // rows merge — 'primary' survives if either record held it.
    const retiredMemberships = await tx
      .select()
      .from(householdMembers)
      .where(eq(householdMembers.personId, retired.id));
    let membershipDedupes = 0;
    for (const m of retiredMemberships) {
      const [existing] = await tx
        .select()
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, m.householdId),
            eq(householdMembers.personId, survivor.id),
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
                eq(householdMembers.householdId, m.householdId),
                eq(householdMembers.personId, survivor.id),
              ),
            );
        }
        await tx
          .delete(householdMembers)
          .where(
            and(
              eq(householdMembers.householdId, m.householdId),
              eq(householdMembers.personId, retired.id),
            ),
          );
      } else {
        await tx
          .update(householdMembers)
          .set({ personId: survivor.id })
          .where(
            and(
              eq(householdMembers.householdId, m.householdId),
              eq(householdMembers.personId, retired.id),
            ),
          );
      }
    }
    moved["household_members"] = retiredMemberships.length - membershipDedupes;
    moved["household_members_merged"] = membershipDedupes;

    // --- Ownership -----------------------------------------------------------------
    // Retired-side open intervals duplicating a survivor open interval
    // on the same animal close annotated — the merged person must not
    // become a duplicate current owner. Everything else reparents.
    const survivorOpenAnimals = new Set(
      (
        await tx
          .select({ animalId: ownerships.animalId })
          .from(ownerships)
          .where(
            and(eq(ownerships.personId, survivor.id), isNull(ownerships.validTo)),
          )
      ).map((o) => o.animalId),
    );
    const retiredOpen = await tx
      .select()
      .from(ownerships)
      .where(
        and(eq(ownerships.personId, retired.id), isNull(ownerships.validTo)),
      );
    const closedIds = new Set<string>();
    for (const o of retiredOpen) {
      if (survivorOpenAnimals.has(o.animalId) && o.validFrom < today) {
        await tx
          .update(ownerships)
          .set({
            validTo: today,
            note: [o.note, `Closed by person merge — duplicate interval`]
              .filter(Boolean)
              .join(" "),
          })
          .where(eq(ownerships.id, o.id));
        closedIds.add(o.id);
      }
    }
    // Intervals closed by this merge stay on the retired person — they
    // document the duplicate, not a real relationship change.
    const movedOwnerships = await tx
      .update(ownerships)
      .set({ personId: survivor.id })
      .where(
        and(
          eq(ownerships.personId, retired.id),
          closedIds.size
            ? notInArray(ownerships.id, [...closedIds])
            : undefined,
        ),
      )
      .returning();
    moved["ownerships"] = movedOwnerships.length;
    moved["ownerships_closed"] = closedIds.size;

    // --- Wholesale reparents -----------------------------------------------------------
    const reparent = async (
      table: PgTable & { id: AnyPgColumn; personId: AnyPgColumn },
      domain: string,
    ) => {
      const rows = await tx
        .update(table)
        .set({ personId: survivor.id })
        .where(eq(table.personId, retired.id))
        .returning();
      moved[domain] = rows.length;
    };

    // Attestor, requester, submitter, registrant, payer, contact —
    // each is the same domain person, so the link follows. Snapshot
    // columns (owner_label, recipient, detail) never change.
    await reparent(ownershipConfirmations, "ownership_confirmations");
    await reparent(ownerRequests, "owner_requests");
    await reparent(registrationSubmissions, "registration_submissions");
    await reparent(registrations, "registrations");
    // Money rows reparent by person link only — amounts, statuses, and
    // registration links are untouched, so ledger projections are
    // identical before and after.
    await reparent(payments, "payments");
    await reparent(followUps, "follow_ups");
    await reparent(clinicExpectations, "clinic_expectations");
    await reparent(communications, "communications");
    // Staff-account bookkeeping — role/email/identity never change.
    await reparent(adminUsers, "admin_users");

    // --- Communication preferences -------------------------------------------------------
    // Unique (person, channel, kind): a colliding row folds into the
    // survivor's with the OPT-OUT UNION — an opt-out on either record
    // must never be lost (re-subscribing someone who opted out is the
    // failure mode, not the reverse).
    const retiredPrefs = await tx
      .select()
      .from(communicationPreferences)
      .where(eq(communicationPreferences.personId, retired.id));
    let prefCollisions = 0;
    for (const p of retiredPrefs) {
      const [existing] = await tx
        .select()
        .from(communicationPreferences)
        .where(
          and(
            eq(communicationPreferences.personId, survivor.id),
            eq(communicationPreferences.channel, p.channel),
            eq(communicationPreferences.kind, p.kind),
          ),
        );
      if (existing) {
        prefCollisions += 1;
        if (p.optedOut && !existing.optedOut) {
          await tx
            .update(communicationPreferences)
            .set({ optedOut: true, updatedAt: new Date() })
            .where(eq(communicationPreferences.id, existing.id));
        }
        await tx
          .delete(communicationPreferences)
          .where(eq(communicationPreferences.id, p.id));
      } else {
        await tx
          .update(communicationPreferences)
          .set({ personId: survivor.id })
          .where(eq(communicationPreferences.id, p.id));
      }
    }
    moved["communication_preferences"] = retiredPrefs.length - prefCollisions;
    moved["communication_preferences_merged"] = prefCollisions;

    // --- Identity fields -------------------------------------------------------------------
    await tx
      .update(persons)
      .set(personSurvivorUpdates(survivor, retired, analysis, input.fieldChoices))
      .where(eq(persons.id, survivor.id));

    // --- Retire the duplicate -------------------------------------------------------------
    // No delete, no status flip — the person_merges row IS the
    // retirement. The persons row keeps its field values as the
    // historical record of the duplicate.
    const [merge] = await tx
      .insert(personMerges)
      .values({
        retiredPersonId: retired.id,
        survivorPersonId: survivor.id,
        retiredFullName: retired.fullName,
        retiredEmail: retired.email,
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
        entityType: "person",
        entityId: retired.id,
        action: "merge-retire",
        after: {
          mergedInto: survivor.id,
          survivorName: survivor.fullName,
          fieldChoices: input.fieldChoices,
          moved,
        },
      },
      {
        actorLabel: input.actorLabel,
        actorIdentityId: input.actorIdentityId ?? null,
        entityType: "person",
        entityId: survivor.id,
        action: "merge-absorb",
        after: {
          retiredId: retired.id,
          retiredName: retired.fullName,
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
        detector: "duplicate-person",
        entityType: "person",
        entityA: a,
        entityB: b,
        fingerprint: "merge",
        decision: "confirmed",
        note: `Merged into ${survivor.fullName} (merge ${merge.id})`,
        decidedByLabel: input.actorLabel,
        decidedByIdentityId: input.actorIdentityId ?? null,
      })
      .onConflictDoNothing();

    return {
      ok: true as const,
      mergeId: merge.id,
      survivorId: survivor.id,
      survivorName: survivor.fullName,
    };
  });
}

// --- Retired-identity resolution ------------------------------------------------

export interface PersonMergeInfo {
  status: "merged" | "canonical";
  // For 'merged': where the record went.
  survivor: { id: string; fullName: string } | null;
  mergedAt: string | null;
  mergedByLabel: string | null;
  // For 'canonical': retired identities absorbed into this record.
  absorbed: { id: string; fullName: string; mergedAt: string }[];
}

export async function getPersonMergeInfo(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMergeInfo | null> {
  if (!UUID_RE.test(personId)) return null;
  const [asRetired] = await db
    .select({
      survivorId: personMerges.survivorPersonId,
      survivorName: persons.fullName,
      mergedAt: personMerges.createdAt,
      mergedByLabel: personMerges.mergedByLabel,
    })
    .from(personMerges)
    .innerJoin(persons, eq(personMerges.survivorPersonId, persons.id))
    .where(eq(personMerges.retiredPersonId, personId));
  if (asRetired) {
    return {
      status: "merged",
      survivor: { id: asRetired.survivorId, fullName: asRetired.survivorName },
      mergedAt: asRetired.mergedAt.toISOString(),
      mergedByLabel: asRetired.mergedByLabel,
      absorbed: [],
    };
  }
  const absorbedRows = await db
    .select({
      retiredId: personMerges.retiredPersonId,
      retiredName: personMerges.retiredFullName,
      mergedAt: personMerges.createdAt,
    })
    .from(personMerges)
    .where(eq(personMerges.survivorPersonId, personId))
    .orderBy(asc(personMerges.createdAt));
  return {
    status: "canonical",
    survivor: null,
    mergedAt: null,
    mergedByLabel: null,
    absorbed: absorbedRows.map((r) => ({
      id: r.retiredId,
      fullName: r.retiredName,
      mergedAt: r.mergedAt.toISOString(),
    })),
  };
}

// Where does a possibly-retired person id resolve? Retired uuids point
// at the canonical survivor — old links and merge-lineage references
// land on the right record in one hop.
export async function resolvePersonMergeTarget(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ canonicalId: string; wasMerged: boolean } | null> {
  const [row] = await db
    .select({ id: persons.id })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!row) return null;
  const merge = await getPersonMergeInfo(personId, db);
  if (merge?.status === "merged" && merge.survivor) {
    return { canonicalId: merge.survivor.id, wasMerged: true };
  }
  return { canonicalId: personId, wasMerged: false };
}
