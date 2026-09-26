// Owner-originated request service (#166) — the durable record of
// everything an authenticated owner asks the registry to change, plus
// the staff decision. This is the boundary that keeps the portal safe:
//
//   - portal actions NEVER apply ownership, identity, or lifecycle
//     changes directly for ambiguous/high-impact cases — they write a
//     'pending' row here and staff resolve it;
//   - a request never silently assigns an animal to another person
//     based on a typed name/email — the target is free text for staff
//     to verify and pick from the registry at resolution;
//   - resolving applies the real change (close/transfer ownership,
//     link an identity) through the canonical services in the same
//     transaction as the status flip, so a request can never read as
//     "approved" while its effect didn't land.
//
// This is also where #167's lifecycle authority meets the portal:
// approving 'lifecycle-deceased'/'lifecycle-moved-off-saba' now performs
// the authoritative animal lifecycle transition through
// transitionAnimalLifecycle (which closes every open ownership interval
// and preserves the transition in animal_lifecycle_events), so the
// approved report, the registry state, and the history row can never
// diverge.
//
// The pending-queue read (listOwnerRequests) is the canonical
// owner/registry exception query #177's dashboard should compose.

import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  authIdentities,
  ownerRequests,
  ownerships,
  persons,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { isIsoDateString, todayIsoDate } from "../vaccinations";
import {
  closeOwnership,
  transferOwnership,
} from "./ownership";
import { transitionAnimalLifecycle } from "./animals";
import {
  createPerson,
  findClaimCandidates,
  getIdentityByProviderUid,
  linkIdentityToPerson,
  type AuthIdentityRecord,
  type PersonRecord,
} from "./persons";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DETAIL = 2000;

// Kinds/labels live in owner-request-kinds.ts (dependency-free) so
// client components can render them without importing this server-only
// module. Re-exported here for server-side callers.
export {
  OWNER_REQUEST_KINDS,
  OWNER_REQUEST_KIND_LABELS,
} from "./owner-request-kinds";
export type { OwnerRequestKind } from "./owner-request-kinds";
import {
  OWNER_REQUEST_KINDS,
  type OwnerRequestKind,
} from "./owner-request-kinds";

// Animal-scoped kinds carry an ownership the reporter currently holds.
const ANIMAL_REQUEST_KINDS: readonly OwnerRequestKind[] = [
  "no-longer-mine",
  "transfer",
  "lifecycle-deceased",
  "lifecycle-moved-off-saba",
];

// --- DTO -----------------------------------------------------------------------

export interface OwnerRequestRecord {
  id: string;
  kind: string;
  status: string;
  authIdentityId: string | null;
  // The login's email snapshot at submission — display context for
  // staff, never a link key.
  submitterEmail: string | null;
  personId: string | null;
  personName: string | null;
  animalId: string | null;
  animalName: string | null;
  ownershipId: string | null;
  detail: string | null;
  payload: Record<string, unknown> | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

function toRequestDto(row: {
  id: string;
  kind: string;
  status: string;
  authIdentityId: string | null;
  submitterEmail: string | null;
  personId: string | null;
  personName: string | null;
  animalId: string | null;
  animalName: string | null;
  ownershipId: string | null;
  detail: string | null;
  payload: unknown;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}): OwnerRequestRecord {
  return {
    ...row,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const REQUEST_SELECT = {
  id: ownerRequests.id,
  kind: ownerRequests.kind,
  status: ownerRequests.status,
  authIdentityId: ownerRequests.authIdentityId,
  submitterEmail: authIdentities.email,
  personId: ownerRequests.personId,
  personName: persons.fullName,
  animalId: ownerRequests.animalId,
  animalName: animals.name,
  ownershipId: ownerRequests.ownershipId,
  detail: ownerRequests.detail,
  payload: ownerRequests.payload,
  resolutionNote: ownerRequests.resolutionNote,
  resolvedBy: ownerRequests.resolvedBy,
  resolvedAt: ownerRequests.resolvedAt,
  createdAt: ownerRequests.createdAt,
} as const;

// --- Creation ------------------------------------------------------------

export type SubmitRequestResult =
  | { ok: true; request: OwnerRequestRecord }
  | { ok: false; reason: "invalid" | "duplicate" | "not-found"; field?: string };

interface SubmitRequestInput {
  kind: OwnerRequestKind;
  authIdentityId: string;
  // The reporting owner — required for animal-scoped kinds (the portal
  // resolved it from the session), null for account-claim (the claim is
  // precisely that there is no person yet).
  personId: string | null;
  animalId?: string | null;
  ownershipId?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
}

function validateRequestInput(input: SubmitRequestInput): string | null {
  if (!(OWNER_REQUEST_KINDS as readonly string[]).includes(input.kind)) {
    return "kind";
  }
  if (!UUID_RE.test(input.authIdentityId)) return "authIdentityId";
  if (input.personId !== null && input.personId !== undefined && !UUID_RE.test(input.personId)) {
    return "personId";
  }
  if (input.animalId != null && !UUID_RE.test(input.animalId)) return "animalId";
  if (input.ownershipId != null && !UUID_RE.test(input.ownershipId)) {
    return "ownershipId";
  }
  if (ANIMAL_REQUEST_KINDS.includes(input.kind)) {
    if (!input.animalId || !input.ownershipId || !input.personId) {
      return "animalId";
    }
  }
  if (input.detail != null && input.detail.length > MAX_DETAIL) return "detail";
  return null;
}

// The single insert path for owner requests. The partial unique index
// (one pending request per account+kind+animal) makes a resubmission a
// no-op rather than a second work item.
async function insertOwnerRequest(
  input: SubmitRequestInput,
  db: RegistryDb,
): Promise<SubmitRequestResult> {
  const invalidField = validateRequestInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  try {
    const [row] = await db
      .insert(ownerRequests)
      .values({
        kind: input.kind,
        authIdentityId: input.authIdentityId,
        personId: input.personId ?? null,
        animalId: input.animalId ?? null,
        ownershipId: input.ownershipId ?? null,
        detail: input.detail?.trim() || null,
        payload: input.payload ?? null,
        status: "pending",
      })
      .returning();
    return {
      ok: true,
      request: toRequestDto({
        ...row,
        submitterEmail: null,
        personName: null,
        animalName: null,
      }),
    };
  } catch (error) {
    const code =
      (error as { code?: unknown })?.code ??
      (error as { cause?: { code?: unknown } })?.cause?.code;
    if (code === "23505") return { ok: false, reason: "duplicate" };
    if (code === "23503") return { ok: false, reason: "not-found" };
    throw error;
  }
}

// Portal path — caller has already verified the ownership is current
// AND held by personId (via getOwnedOwnership); this records the
// request and audits it. A duplicate pending request resolves to the
// existing row: to the owner it is "already submitted", not an error.
export async function submitOwnerRequest(
  input: SubmitRequestInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<SubmitRequestResult> {
  const result = await insertOwnerRequest(input, db);
  if (!result.ok) return result;
  await db.insert(auditEvents).values({
    actorIdentityId: input.authIdentityId,
    actorLabel,
    entityType: "owner_request",
    entityId: result.request.id,
    action: "submit",
    after: {
      kind: input.kind,
      animalId: input.animalId ?? null,
      ownershipId: input.ownershipId ?? null,
    },
  });
  return result;
}

// --- Onboarding / account claiming -------------------------------------------------

// What a verified login resolves to on the owner side.
export type OwnerLinkResult =
  | { status: "linked"; person: PersonRecord }
  | { status: "created"; person: PersonRecord }
  | { status: "pending-claim" };

// The owner-side provisioning step of session creation. Safe rules:
//
//   - linked identity → done, every time;
//   - unlinked with NO email-matched, unclaimed person candidates →
//     create a brand-new person and link it. A fresh record exposes
//     nothing that isn't the caller's own;
//   - unlinked WITH candidates → file an 'account-claim' request for
//     staff. An email match alone is NOT identity proof (person emails
//     arrive via staff entry and registration forms), so linking is a
//     human decision — prefer review over exposing someone else's
//     animal records.
export async function provisionOwnerLink(
  identity: AuthIdentityRecord,
  { displayName, actorLabel }: { displayName?: string | null; actorLabel: string },
  db: RegistryDb = getRegistryDb(),
): Promise<OwnerLinkResult> {
  if (identity.personId) {
    const [person] = await db
      .select()
      .from(persons)
      .where(eq(persons.id, identity.personId));
    if (person) {
      return {
        status: "linked",
        person: {
          ...person,
          createdAt: person.createdAt.toISOString(),
          updatedAt: person.updatedAt.toISOString(),
        },
      };
    }
  }

  const candidates = identity.email
    ? await findClaimCandidates(identity.email, db)
    : [];

  if (candidates.length === 0) {
    const created = await createPerson(
      {
        fullName: displayName?.trim() || identity.email || "New owner",
        email: identity.email,
      },
      actorLabel,
      db,
    );
    if (!created.ok) {
      // Validation can't fail on this input shape; a person write
      // failure is an infra problem — surface it.
      throw new Error(`provisionOwnerLink: person create failed (${created.reason})`);
    }
    const linked = await linkIdentityToPerson(
      identity.id,
      created.person.id,
      actorLabel,
      db,
    );
    if (!linked.ok) {
      throw new Error(`provisionOwnerLink: identity link failed (${linked.reason})`);
    }
    return { status: "created", person: created.person };
  }

  // Ambiguous: a registry person claims this email. Queue the claim —
  // the dedup index makes repeat logins idempotent.
  await insertOwnerRequest(
    {
      kind: "account-claim",
      authIdentityId: identity.id,
      personId: null,
      payload: {
        candidatePersonIds: candidates.map((c) => c.id),
        candidateNames: candidates.map((c) => c.fullName),
      },
    },
    db,
  );
  return { status: "pending-claim" };
}

// --- Reads --------------------------------------------------------------------

// The staff exception queue — pending first (oldest first: longest-
// waiting work surfaces), then resolved history. #177's dashboard
// should compose this rather than re-query owner_requests.
export async function listOwnerRequests(
  { status, limit = 200 }: { status?: "pending" | "resolved"; limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<OwnerRequestRecord[]> {
  const bounded = Math.min(Math.max(limit, 1), 500);
  const where =
    status === "pending"
      ? eq(ownerRequests.status, "pending")
      : status === "resolved"
        ? sql`${ownerRequests.status} <> 'pending'`
        : undefined;
  const rows = await db
    .select(REQUEST_SELECT)
    .from(ownerRequests)
    .leftJoin(persons, eq(ownerRequests.personId, persons.id))
    .leftJoin(animals, eq(ownerRequests.animalId, animals.id))
    .leftJoin(authIdentities, eq(ownerRequests.authIdentityId, authIdentities.id))
    .where(where)
    .orderBy(asc(ownerRequests.createdAt))
    .limit(bounded);
  return rows.map(toRequestDto);
}

// Aggregate count for the #177 dashboard — pending-only so the summary
// stays a single indexed aggregate, never a row fetch to count.
export async function countPendingOwnerRequests(
  db: RegistryDb = getRegistryDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ownerRequests)
    .where(eq(ownerRequests.status, "pending"));
  return row?.n ?? 0;
}

// The owner's own request history — the portal's "pending requests"
// list. Scoped by person (linked account) — an unlinked identity's only
// possible request is its claim, which the pending state already shows.
export async function listOwnerRequestsForPerson(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnerRequestRecord[]> {
  if (!UUID_RE.test(personId)) return [];
  const rows = await db
    .select(REQUEST_SELECT)
    .from(ownerRequests)
    .leftJoin(persons, eq(ownerRequests.personId, persons.id))
    .leftJoin(animals, eq(ownerRequests.animalId, animals.id))
    .leftJoin(authIdentities, eq(ownerRequests.authIdentityId, authIdentities.id))
    .where(eq(ownerRequests.personId, personId))
    .orderBy(desc(ownerRequests.createdAt))
    .limit(100);
  return rows.map(toRequestDto);
}

// --- Owner cancel -----------------------------------------------------------------

// An owner withdraws their own still-pending request. Resolved rows are
// staff history — never touched here.
export async function cancelOwnerRequest(
  requestId: string,
  personId: string,
  actorIdentityId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-pending" | "invalid" }> {
  if (!UUID_RE.test(requestId) || !UUID_RE.test(personId)) {
    return { ok: false, reason: "invalid" };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(ownerRequests)
      .where(eq(ownerRequests.id, requestId))
      .for("update");
    if (!row || row.personId !== personId) {
      return { ok: false as const, reason: "not-found" as const };
    }
    if (row.status !== "pending") {
      return { ok: false as const, reason: "not-pending" as const };
    }
    await tx
      .update(ownerRequests)
      .set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(ownerRequests.id, requestId));
    await tx.insert(auditEvents).values({
      actorIdentityId,
      entityType: "owner_request",
      entityId: requestId,
      action: "cancel",
      before: { status: "pending" },
      after: { status: "cancelled" },
    });
    return { ok: true as const };
  });
}

// --- Staff resolution ----------------------------------------------------------------

export type ResolveResult =
  | { ok: true; request: OwnerRequestRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-pending"
        | "invalid"
        | "apply-failed"
        | "conflict";
      field?: string;
    };

export interface ResolveInput {
  decision: "approved" | "rejected";
  resolutionNote?: string | null;
  // approve('account-claim'): the person the account links to.
  // approve('transfer'): the receiving person/household.
  targetPersonId?: string | null;
  targetHouseholdId?: string | null;
  // The date the change is effective — defaults to today. For
  // lifecycle/no-longer-mine reports the owner may report a past date.
  effectiveOn?: string | null;
}

// Staff resolution. The status flip and the real-world effect commit in
// one transaction; if applying the effect fails the request stays
// pending so staff can correct inputs and retry rather than reconciling
// a half-applied "approval".
export async function resolveOwnerRequest(
  requestId: string,
  input: ResolveInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ResolveResult> {
  if (!UUID_RE.test(requestId)) return { ok: false, reason: "not-found" };
  if (input.decision !== "approved" && input.decision !== "rejected") {
    return { ok: false, reason: "invalid" };
  }
  const effectiveOn = input.effectiveOn?.trim() || todayIsoDate();
  if (!isIsoDateString(effectiveOn)) {
    return { ok: false, reason: "invalid", field: "effectiveOn" };
  }
  const targetPersonId = input.targetPersonId?.trim() || null;
  const targetHouseholdId = input.targetHouseholdId?.trim() || null;
  if (
    (targetPersonId !== null && !UUID_RE.test(targetPersonId)) ||
    (targetHouseholdId !== null && !UUID_RE.test(targetHouseholdId))
  ) {
    return { ok: false, reason: "invalid", field: "target" };
  }

  // --- Apply the approved effect first; on failure nothing resolves. --
  // These run through the canonical services so every effect gets its
  // own audit row AND the request's resolution row.
  if (input.decision === "approved") {
    const applied = await applyApproval(requestId, {
      targetPersonId,
      targetHouseholdId,
      effectiveOn,
      actorLabel,
      db,
    });
    if (applied !== null) return applied;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(ownerRequests)
      .where(eq(ownerRequests.id, requestId))
      .for("update");
    if (!row) return { ok: false as const, reason: "not-found" as const };
    if (row.status !== "pending") {
      return { ok: false as const, reason: "not-pending" as const };
    }
    const [updated] = await tx
      .update(ownerRequests)
      .set({
        status: input.decision,
        resolutionNote: input.resolutionNote?.trim() || null,
        resolvedBy: actorLabel,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ownerRequests.id, requestId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "owner_request",
      entityId: requestId,
      action: `resolve-${input.decision}`,
      before: { status: "pending" },
      after: {
        status: input.decision,
        targetPersonId,
        targetHouseholdId,
        effectiveOn: input.decision === "approved" ? effectiveOn : null,
      },
    });
    return {
      ok: true,
      request: toRequestDto({
        ...updated,
        submitterEmail: null,
        personName: null,
        animalName: null,
      }),
    };
  });
}

// The effect half of an approval. Returns null on success — the caller
// then flips the status; returns a failure result to leave the request
// pending. Kept outside the status transaction deliberately: the inner
// services open their own transactions, and a failed apply must not
// resolve the request.
async function applyApproval(
  requestId: string,
  {
    targetPersonId,
    targetHouseholdId,
    effectiveOn,
    actorLabel,
    db,
  }: {
    targetPersonId: string | null;
    targetHouseholdId: string | null;
    effectiveOn: string;
    actorLabel: string;
    db: RegistryDb;
  },
): Promise<ResolveResult | null> {
  const [row] = await db
    .select()
    .from(ownerRequests)
    .where(eq(ownerRequests.id, requestId));
  if (!row) return { ok: false, reason: "not-found" };

  switch (row.kind) {
    case "account-claim": {
      if (!targetPersonId || !row.authIdentityId) {
        return { ok: false, reason: "invalid", field: "targetPersonId" };
      }
      const linked = await linkIdentityToPerson(
        row.authIdentityId,
        targetPersonId,
        actorLabel,
        db,
      );
      if (!linked.ok) {
        return {
          ok: false,
          reason: linked.reason === "conflict" ? "conflict" : "apply-failed",
        };
      }
      // The resolved request records which person the account linked to.
      await db
        .update(ownerRequests)
        .set({ personId: targetPersonId, updatedAt: new Date() })
        .where(eq(ownerRequests.id, requestId));
      return null;
    }
    case "no-longer-mine": {
      // Close the reporter's interval if still open — an already-closed
      // row means staff handled it another way; still resolvable.
      if (row.ownershipId) {
        const [o] = await db
          .select({ validTo: ownerships.validTo })
          .from(ownerships)
          .where(eq(ownerships.id, row.ownershipId));
        if (o && o.validTo === null) {
          const closed = await closeOwnership(
            row.ownershipId,
            effectiveOn,
            actorLabel,
            db,
          );
          if (!closed.ok && closed.reason !== "conflict") {
            return { ok: false, reason: "apply-failed" };
          }
        }
      }
      return null;
    }
    case "transfer": {
      if (!row.ownershipId || (!targetPersonId && !targetHouseholdId)) {
        return { ok: false, reason: "invalid", field: "target" };
      }
      const [o] = await db
        .select({ validTo: ownerships.validTo })
        .from(ownerships)
        .where(eq(ownerships.id, row.ownershipId));
      if (!o) return { ok: false, reason: "not-found" };
      if (o.validTo === null) {
        const moved = await transferOwnership(
          {
            ownershipId: row.ownershipId,
            validTo: effectiveOn,
            newOwner: { personId: targetPersonId, householdId: targetHouseholdId },
            note: `Transfer approved via owner request ${requestId}`,
          },
          actorLabel,
          db,
        );
        if (!moved.ok) {
          return {
            ok: false,
            reason: moved.reason === "conflict" ? "conflict" : "apply-failed",
          };
        }
      }
      return null;
    }
    case "lifecycle-deceased":
    case "lifecycle-moved-off-saba": {
      // #167: approving the report performs the authoritative
      // whole-animal transition. The transition closes EVERY open
      // ownership interval (a deceased/off-island animal has no
      // on-island owner of record) — co-owners' intervals close too,
      // which is why the report requires staff approval rather than
      // applying on submission. All intervals are preserved as history.
      const toStatus =
        row.kind === "lifecycle-deceased" ? "deceased" : "moved-off-saba";
      if (!row.animalId) return { ok: false, reason: "invalid", field: "kind" };
      const [animal] = await db
        .select({ lifecycleStatus: animals.lifecycleStatus })
        .from(animals)
        .where(eq(animals.id, row.animalId));
      if (!animal) return { ok: false, reason: "not-found" };
      if (animal.lifecycleStatus === toStatus) {
        // Already in the target state (another owner's report already
        // resolved it) — nothing to apply; still resolvable.
        return null;
      }
      const transitioned = await transitionAnimalLifecycle(
        row.animalId,
        {
          toStatus,
          effectiveOn,
          reason: row.detail,
          source: "owner-request",
          sourceRef: requestId,
          actorLabel,
        },
        db,
      );
      if (!transitioned.ok) {
        return {
          ok: false,
          reason:
            transitioned.reason === "invalid" ? "invalid" : "apply-failed",
        };
      }
      return null;
    }
    default:
      return { ok: false, reason: "invalid", field: "kind" };
  }
}
