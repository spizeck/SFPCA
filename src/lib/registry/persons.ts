// Person / identity / household domain service (#166).
//
// THE core rule of the registry: a login account is NOT the ownership
// record. Three separate concepts, always:
//
//   auth_identities — proves WHO signed in (Firebase provider + uid)
//   persons         — durable registry people (owners, contacts, staff)
//   households      — groups of persons sharing an address/animals
//
// A person survives losing portal access, changing email, transferring
// every animal, and leaving Saba — they are history. An auth identity
// only ever points at a person; it never IS the person.
//
// Linking rule (see ARCHITECTURE.md §"account claiming"): an auth
// identity is linked to a person ONLY by
//   - staff action (linkIdentityToPerson, e.g. resolving a claim), or
//   - the onboarding path creating a brand-NEW person for an identity
//     that matches nothing.
// A login is NEVER auto-linked to an existing person by email match —
// person emails can be typed in by staff or imported from registration
// forms, so a match is a hint for a staff-reviewed claim, not proof.
//
// Same invariants as the other registry services: server-only, DTOs
// out, mutations commit with their audit_events row.

import "server-only";

import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  animals,
  auditEvents,
  authIdentities,
  householdMembers,
  households,
  ownerships,
  persons,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import { EMAIL_RE } from "./communications";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME = 200;
const MAX_FIELD = 500;
const MAX_NOTE = 2000;

export const PREFERRED_CHANNELS = ["email", "phone", "whatsapp", "sms"] as const;
export const HOUSEHOLD_MEMBER_ROLES = ["member", "primary"] as const;

// --- DTOs ---------------------------------------------------------------------

export interface AuthIdentityRecord {
  id: string;
  provider: string;
  providerUid: string;
  email: string | null;
  personId: string | null;
  createdAt: string;
}

export interface PersonRecord {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  preferredChannel: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdRecord {
  id: string;
  name: string;
  address: string | null;
  members: { personId: string; fullName: string; role: string }[];
  createdAt: string;
}

// What the signed-in owner's session resolves to.
export interface OwnerSessionContext {
  identity: AuthIdentityRecord;
  // null while the account is unlinked (claim pending review) — the
  // portal renders its pending state for this, never animal data.
  person: PersonRecord | null;
}

const PERSON_COLUMNS = {
  id: persons.id,
  fullName: persons.fullName,
  email: persons.email,
  phone: persons.phone,
  address: persons.address,
  preferredChannel: persons.preferredChannel,
  notes: persons.notes,
  createdAt: persons.createdAt,
  updatedAt: persons.updatedAt,
} as const;

function toPersonDto(row: typeof persons.$inferSelect): PersonRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIdentityDto(row: typeof authIdentities.$inferSelect): AuthIdentityRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

const clean = (v: string | null | undefined) => v?.trim() || null;

// --- Auth identities --------------------------------------------------------------

// Session-time upsert: called on every verified login so an account
// always has a registry identity row to hang authorization on. The
// email column is a provider SNAPSHOT (refreshed on each login), not a
// link key — person_id is the only link and only staff action or the
// onboarding path sets it.
export async function upsertAuthIdentity(
  {
    provider = "firebase",
    providerUid,
    email,
  }: { provider?: string; providerUid: string; email: string | null },
  db: RegistryDb = getRegistryDb(),
): Promise<AuthIdentityRecord> {
  const [row] = await db
    .insert(authIdentities)
    .values({ provider, providerUid, email })
    .onConflictDoUpdate({
      target: [authIdentities.provider, authIdentities.providerUid],
      set: { email },
    })
    .returning();
  return toIdentityDto(row);
}

export async function getIdentityByProviderUid(
  providerUid: string,
  db: RegistryDb = getRegistryDb(),
): Promise<AuthIdentityRecord | null> {
  const [row] = await db
    .select()
    .from(authIdentities)
    .where(eq(authIdentities.providerUid, providerUid));
  return row ? toIdentityDto(row) : null;
}

// Resolve a signed-in account to its registry person. This is the whole
// owner authorization chain: session cookie → Firebase uid →
// auth_identities → persons. Nothing else — especially not an email or
// an animal id from the client — establishes "this is my record".
export async function resolveOwnerSession(
  providerUid: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnerSessionContext | null> {
  const identity = await getIdentityByProviderUid(providerUid, db);
  if (!identity) return null;
  if (!identity.personId) return { identity, person: null };
  const [person] = await db
    .select(PERSON_COLUMNS)
    .from(persons)
    .where(eq(persons.id, identity.personId));
  return { identity, person: person ? toPersonDto(person) : null };
}

// Persons whose email matches the login AND have no linked auth
// identity — claim candidates for staff review. An already-linked
// person is never a candidate: a second account must not attach to it.
export async function findClaimCandidates(
  email: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonRecord[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  const rows = await db
    .select(PERSON_COLUMNS)
    .from(persons)
    .where(
      and(
        sql`lower(${persons.email}) = ${normalized}`,
        isNull(
          sql`(SELECT ai.person_id FROM auth_identities ai WHERE ai.person_id = ${persons.id} LIMIT 1)`,
        ),
      ),
    )
    .orderBy(asc(persons.createdAt));
  return rows.map(toPersonDto);
}

// --- Persons -----------------------------------------------------------------

export interface PersonWriteInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  preferredChannel?: string | null;
  notes?: string | null;
}

export function validatePersonInput(input: PersonWriteInput): string | null {
  if (typeof input.fullName !== "string" || !input.fullName.trim()) {
    return "fullName";
  }
  if (input.fullName.length > MAX_NAME) return "fullName";
  const email = clean(input.email);
  if (email !== null && (email.length > MAX_FIELD || !EMAIL_RE.test(email))) {
    return "email";
  }
  for (const [field, value] of [
    ["phone", input.phone],
    ["address", input.address],
  ] as const) {
    if (value != null && value.length > MAX_FIELD) return field;
  }
  const channel = clean(input.preferredChannel);
  if (
    channel !== null &&
    !(PREFERRED_CHANNELS as readonly string[]).includes(channel)
  ) {
    return "preferredChannel";
  }
  if (input.notes != null && input.notes.length > MAX_NOTE) return "notes";
  return null;
}

function personWriteValues(input: PersonWriteInput) {
  return {
    fullName: input.fullName.trim(),
    email: clean(input.email),
    phone: clean(input.phone),
    address: clean(input.address),
    preferredChannel: clean(input.preferredChannel),
    notes: clean(input.notes),
  };
}

export type PersonMutationResult =
  | { ok: true; person: PersonRecord }
  | { ok: false; reason: "not-found" | "conflict" | "invalid"; field?: string };

export async function createPerson(
  input: PersonWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMutationResult> {
  const invalidField = validatePersonInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(persons)
      .values(personWriteValues(input))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "person",
      entityId: row.id,
      action: "create",
      // Audit carries field names + presence, not the PII values.
      after: { fullName: row.fullName, hasEmail: row.email !== null },
    });
    return { ok: true, person: toPersonDto(row) };
  });
}

// Staff edit. Optimistic concurrency via the rendered updatedAt token.
export async function updatePerson(
  id: string,
  input: PersonWriteInput,
  expectedUpdatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMutationResult> {
  const invalidField = validatePersonInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };
  const expectedMs = new Date(expectedUpdatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(persons)
      .where(eq(persons.id, id))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.updatedAt.getTime() !== expectedMs) {
      return { ok: false as const, reason: "conflict" as const };
    }
    const [row] = await tx
      .update(persons)
      .set({ ...personWriteValues(input), updatedAt: new Date() })
      .where(eq(persons.id, id))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "person",
      entityId: id,
      action: "update",
      before: { fullName: before.fullName, hasEmail: before.email !== null },
      after: { fullName: row.fullName, hasEmail: row.email !== null },
    });
    return { ok: true, person: toPersonDto(row) };
  });
}

// Owner self-edit — the portal's profile form. `notes` is staff-only
// scratch space and is deliberately not writable through this path.
export async function updateOwnerProfile(
  personId: string,
  input: Omit<PersonWriteInput, "notes">,
  actorIdentityId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonMutationResult> {
  const invalidField = validatePersonInput(input);
  if (invalidField) return { ok: false, reason: "invalid", field: invalidField };
  if (!UUID_RE.test(personId)) return { ok: false, reason: "not-found" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(persons)
      .where(eq(persons.id, personId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    const { notes: _notes, ...values } = personWriteValues(input);
    const [row] = await tx
      .update(persons)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(persons.id, personId))
      .returning();
    await tx.insert(auditEvents).values({
      actorIdentityId,
      actorLabel,
      entityType: "person",
      entityId: personId,
      action: "owner-profile-update",
      // Which contact fields changed — never the values themselves.
      before: { hasEmail: before.email !== null, hasPhone: before.phone !== null },
      after: { hasEmail: row.email !== null, hasPhone: row.phone !== null },
    });
    return { ok: true, person: toPersonDto(row) };
  });
}

// --- Staff reads ------------------------------------------------------------------

export async function listPersons(
  { limit = 200 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<PersonRecord[]> {
  const rows = await db
    .select(PERSON_COLUMNS)
    .from(persons)
    .orderBy(asc(persons.fullName), asc(persons.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toPersonDto);
}

// Staff person picker — name or email substring. Returns a bounded
// list; the picker narrows further client-side.
export async function searchPersons(
  query: string,
  { limit = 20 }: { limit?: number } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<PersonRecord[]> {
  const q = query.trim();
  if (!q) return listPersons({ limit }, db);
  const rows = await db
    .select(PERSON_COLUMNS)
    .from(persons)
    .where(
      or(ilike(persons.fullName, `%${q}%`), ilike(persons.email, `%${q}%`)),
    )
    .orderBy(asc(persons.fullName), asc(persons.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(toPersonDto);
}

export interface PersonDetail {
  person: PersonRecord;
  identities: AuthIdentityRecord[];
  households: HouseholdRecord[];
  // Current + historical ownership rows, newest first — staff see the
  // whole chain, owners only ever see current rows.
  ownerships: {
    id: string;
    animalId: string;
    animalName: string;
    validFrom: string;
    validTo: string | null;
  }[];
}

export async function getPersonDetail(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<PersonDetail | null> {
  if (!UUID_RE.test(personId)) return null;
  const [person] = await db
    .select(PERSON_COLUMNS)
    .from(persons)
    .where(eq(persons.id, personId));
  if (!person) return null;

  const [identityRows, householdRows, ownershipRows] = await Promise.all([
    db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.personId, personId)),
    db
      .select({
        id: households.id,
        name: households.name,
        address: households.address,
        role: householdMembers.role,
        createdAt: households.createdAt,
      })
      .from(householdMembers)
      .innerJoin(households, eq(householdMembers.householdId, households.id))
      .where(eq(householdMembers.personId, personId)),
    db
      .select({
        id: ownerships.id,
        animalId: ownerships.animalId,
        animalName: animals.name,
        validFrom: ownerships.validFrom,
        validTo: ownerships.validTo,
      })
      .from(ownerships)
      .innerJoin(animals, eq(ownerships.animalId, animals.id))
      .where(eq(ownerships.personId, personId))
      .orderBy(desc(ownerships.validFrom)),
  ]);

  return {
    person: toPersonDto(person),
    identities: identityRows.map(toIdentityDto),
    households: householdRows.map((h) => ({
      id: h.id,
      name: h.name,
      address: h.address,
      members: [],
      createdAt: h.createdAt.toISOString(),
    })),
    ownerships: ownershipRows,
  };
}

// --- Identity linking (staff only) --------------------------------------------------

export type LinkResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "conflict" | "invalid" };

// Attach an auth identity to a person — the ONLY way an existing person
// gains portal access. Used by claim resolution and direct staff action.
// Fails closed if the identity is already linked to a different person:
// staff must unlink first so the change is two deliberate steps.
export async function linkIdentityToPerson(
  identityId: string,
  personId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LinkResult> {
  if (!UUID_RE.test(identityId) || !UUID_RE.test(personId)) {
    return { ok: false, reason: "invalid" };
  }
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, identityId))
      .for("update");
    if (!identity) return { ok: false as const, reason: "not-found" as const };
    const [person] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, personId));
    if (!person) return { ok: false as const, reason: "not-found" as const };
    if (identity.personId !== null && identity.personId !== personId) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (identity.personId === personId) {
      return { ok: true as const }; // already linked — idempotent
    }
    await tx
      .update(authIdentities)
      .set({ personId })
      .where(eq(authIdentities.id, identityId));
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "auth_identity",
      entityId: identityId,
      action: "link-person",
      // Provider uid is the link key; emails stay out of the audit row.
      before: { personId: identity.personId, provider: identity.provider },
      after: { personId, provider: identity.provider },
    });
    return { ok: true as const };
  });
}

export async function unlinkIdentity(
  identityId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<LinkResult> {
  if (!UUID_RE.test(identityId)) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.id, identityId))
      .for("update");
    if (!identity) return { ok: false as const, reason: "not-found" as const };
    if (identity.personId === null) return { ok: true as const };
    await tx
      .update(authIdentities)
      .set({ personId: null })
      .where(eq(authIdentities.id, identityId));
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "auth_identity",
      entityId: identityId,
      action: "unlink-person",
      before: { personId: identity.personId },
      after: { personId: null },
    });
    return { ok: true as const };
  });
}

// --- Households -----------------------------------------------------------------

export async function listHouseholds(
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdRecord[]> {
  const householdRows = await db
    .select()
    .from(households)
    .orderBy(asc(households.name), asc(households.id));
  const memberRows = await db
    .select({
      householdId: householdMembers.householdId,
      personId: householdMembers.personId,
      role: householdMembers.role,
      fullName: persons.fullName,
    })
    .from(householdMembers)
    .innerJoin(persons, eq(householdMembers.personId, persons.id))
    .orderBy(asc(persons.fullName));
  return householdRows.map((h) => ({
    id: h.id,
    name: h.name,
    address: h.address,
    createdAt: h.createdAt.toISOString(),
    members: memberRows
      .filter((m) => m.householdId === h.id)
      .map((m) => ({ personId: m.personId, fullName: m.fullName, role: m.role })),
  }));
}

// The households a person belongs to — the portal shows this context.
export async function householdsForPerson(
  personId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdRecord[]> {
  if (!UUID_RE.test(personId)) return [];
  const ids = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.personId, personId));
  if (ids.length === 0) return [];
  const all = await listHouseholds(db);
  const wanted = new Set(ids.map((r) => r.householdId));
  return all.filter((h) => wanted.has(h.id));
}

export interface HouseholdWriteInput {
  name: string;
  address?: string | null;
}

export type HouseholdMutationResult =
  | { ok: true; household: HouseholdRecord }
  | { ok: false; reason: "not-found" | "invalid"; field?: string };

export async function createHousehold(
  input: HouseholdWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdMutationResult> {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > MAX_NAME) {
    return { ok: false, reason: "invalid", field: "name" };
  }
  if (input.address != null && input.address.length > MAX_FIELD) {
    return { ok: false, reason: "invalid", field: "address" };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(households)
      .values({ name: input.name.trim(), address: clean(input.address) })
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "household",
      entityId: row.id,
      action: "create",
      after: { name: row.name },
    });
    return {
      ok: true,
      household: {
        id: row.id,
        name: row.name,
        address: row.address,
        members: [],
        createdAt: row.createdAt.toISOString(),
      },
    };
  });
}

export async function updateHousehold(
  id: string,
  input: HouseholdWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<HouseholdMutationResult> {
  if (!UUID_RE.test(id)) return { ok: false, reason: "not-found" };
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > MAX_NAME) {
    return { ok: false, reason: "invalid", field: "name" };
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(households)
      .where(eq(households.id, id))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    const [row] = await tx
      .update(households)
      .set({ name: input.name.trim(), address: clean(input.address), updatedAt: new Date() })
      .where(eq(households.id, id))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "household",
      entityId: id,
      action: "update",
      before: { name: before.name },
      after: { name: row.name },
    });
    return {
      ok: true,
      household: {
        id: row.id,
        name: row.name,
        address: row.address,
        members: [],
        createdAt: row.createdAt.toISOString(),
      },
    };
  });
}

// Membership is a live list, not history — joining/leaving a household
// changes what the member can act on going forward but never rewrites
// ownership intervals. Removing the last member leaves the household
// intact (its ownership history still needs a home).
export async function setHouseholdMember(
  householdId: string,
  personId: string,
  role: "member" | "primary",
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "invalid" }> {
  if (!UUID_RE.test(householdId) || !UUID_RE.test(personId)) {
    return { ok: false, reason: "invalid" };
  }
  if (!(HOUSEHOLD_MEMBER_ROLES as readonly string[]).includes(role)) {
    return { ok: false, reason: "invalid" };
  }
  return db.transaction(async (tx) => {
    const [household] = await tx
      .select({ id: households.id })
      .from(households)
      .where(eq(households.id, householdId));
    const [person] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, personId));
    if (!household || !person) return { ok: false as const, reason: "not-found" as const };

    await tx
      .insert(householdMembers)
      .values({ householdId, personId, role })
      .onConflictDoUpdate({
        target: [householdMembers.householdId, householdMembers.personId],
        set: { role },
      });
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "household_member",
      entityId: `${householdId}:${personId}`,
      action: "add",
      after: { householdId, personId, role },
    });
    return { ok: true as const };
  });
}

export async function removeHouseholdMember(
  householdId: string,
  personId: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "invalid" }> {
  if (!UUID_RE.test(householdId) || !UUID_RE.test(personId)) {
    return { ok: false, reason: "invalid" };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.personId, personId),
        ),
      )
      .returning();
    if (!row) return { ok: false as const, reason: "not-found" as const };
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "household_member",
      entityId: `${householdId}:${personId}`,
      action: "remove",
      before: { householdId, personId, role: row.role },
    });
    return { ok: true as const };
  });
}
