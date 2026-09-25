// Canonical ownership service (#166) — the ONE place that defines what
// "owns this animal" means. Everything that needs the current owner —
// the owner portal, the vet queue, vaccination due lists, reminder
// recipient resolution, follow-up snapshots — reads through this
// module's projections so the definitions can never drift apart.
//
// Model (see ARCHITECTURE.md):
//   - ownerships rows are immutable INTERVALS [valid_from, valid_to).
//     A change closes valid_to on the old row and opens a new row;
//     history is never rewritten. An open-ended valid_to is "current".
//   - exactly one of person_id / household_id is set per row (DB CHECK).
//     Household ownership means the household unit owns the animal —
//     its current members may act on it in the portal, but membership
//     alone never creates person-level ownership history.
//   - multiple simultaneously-valid rows are legitimate co-ownership.
//     Display projections pick ONE deterministic row (person over
//     household, earliest valid_from, id tiebreak); send/authorization
//     paths treat >1 valid row as ambiguous data and fail closed.
//   - the same-owner overlap guard rejects a new interval that overlaps
//     an existing interval for the SAME animal+owner side — that shape
//     is always contradictory data, never a real state.
//
// Every mutation commits with its audit_events row in one transaction,
// same as the other registry services.

import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  animals,
  auditEvents,
  householdMembers,
  households,
  microchipRecords,
  ownershipConfirmations,
  ownerships,
  persons,
} from "../db/schema";
import { getRegistryDb } from "../db/client";
import {
  addDaysToIsoDate,
  isIsoDateString,
  todayIsoDate,
} from "../vaccinations";
import { formatAnimalAge } from "../animal-lifecycle";
import type { RegistryDb } from "./public-animals";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NOTE = 500;

// A read handle — the db itself or a transaction inside it. Matches
// the Queryable/Tx pattern in medical.ts.
type Queryable = Pick<RegistryDb, "select">;

// --- DTOs -------------------------------------------------------------------

export interface OwnershipRecord {
  id: string;
  animalId: string;
  personId: string | null;
  householdId: string | null;
  // Display-side owner identity — exactly one is populated, matching
  // the person/household CHECK.
  ownerName: string;
  ownerKind: "person" | "household";
  validFrom: string;
  validTo: string | null;
  note: string | null;
  createdAt: string;
}

// The shared "one current owner per animal" shape used by due
// projections and queues. person rows carry contact details; household
// rows carry only a name — contact resolution for households goes
// through householdContactFor() (primary member).
export interface CurrentOwnerRef {
  id: string;
  kind: "person" | "household";
  name: string;
  email: string | null;
  phone: string | null;
}

export interface OwnershipConfirmation {
  id: string;
  ownershipId: string;
  animalId: string;
  personId: string;
  personName: string | null;
  confirmedOn: string;
  method: string;
  actorLabel: string | null;
  notes: string | null;
  createdAt: string;
}

// --- Canonical current-owner projections ---------------------------------------

// The deterministic single-owner-per-animal subquery shared by every
// projection that needs "the" owner for display: DISTINCT ON animal_id
// over the ownerships valid at `asOf`, preferring a person row (person
// rows carry contact details) then earliest valid_from, with id as the
// stable tiebreak. Embeddable in larger joins via the returned alias.
export function currentOwnershipSq(
  db: RegistryDb,
  asOf: string,
  alias = "current_ownership",
) {
  return db
    .selectDistinctOn([ownerships.animalId], {
      animalId: ownerships.animalId,
      personId: ownerships.personId,
      householdId: ownerships.householdId,
    })
    .from(ownerships)
    .where(
      and(
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .orderBy(
      ownerships.animalId,
      asc(sql`(${ownerships.personId} IS NULL)`),
      asc(ownerships.validFrom),
      asc(ownerships.id),
    )
    .as(alias);
}

// The current person-side owner id — the snapshot follow_ups /
// clinic_expectations take at creation so the queue knows who to reach
// without re-deriving ownership. Household ownership has no personId to
// snapshot (contact resolution is the sender's problem, not the
// snapshot's).
export async function currentOwnerPersonIdAt(
  tx: Queryable,
  animalId: string,
  asOf: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ personId: ownerships.personId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.animalId, animalId),
        sql`${ownerships.personId} IS NOT NULL`,
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .orderBy(asc(ownerships.validFrom), asc(ownerships.id))
    .limit(1);
  return row?.personId ?? null;
}

// A household's contactable member: the 'primary' member first, else the
// earliest-added member with an email. Households have no contact
// channel of their own — reminders and confirmations reach a person.
export async function householdContactFor(
  householdIds: string[],
  db: RegistryDb = getRegistryDb(),
): Promise<
  Map<string, { personId: string; name: string; email: string | null }>
> {
  const result = new Map<
    string,
    { personId: string; name: string; email: string | null }
  >();
  const ids = householdIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      householdId: householdMembers.householdId,
      personId: persons.id,
      name: persons.fullName,
      email: persons.email,
      role: householdMembers.role,
      memberSince: householdMembers.createdAt,
    })
    .from(householdMembers)
    .innerJoin(persons, eq(householdMembers.personId, persons.id))
    .where(inArray(householdMembers.householdId, ids));

  // Deterministic pick per household: 'primary' beats 'member', then
  // earliest membership row.
  const sorted = [...rows].sort((a, b) => {
    if (a.householdId !== b.householdId)
      return a.householdId.localeCompare(b.householdId);
    if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
    return a.memberSince.getTime() - b.memberSince.getTime();
  });
  for (const row of sorted) {
    if (!result.has(row.householdId)) {
      result.set(row.householdId, {
        personId: row.personId,
        name: row.name,
        email: row.email,
      });
    }
  }
  return result;
}

// Strict current-owner resolution for SENDING — deliberately stricter
// than the display projection: more than one simultaneously-valid
// ownership is ambiguous data, not a recipient. Moved from
// communications.ts so every sender shares one definition.
export type ResolvedOwner =
  | { status: "ok"; personId: string; name: string; email: string | null }
  | {
      status: "skip";
      detail:
        | "no-owner"
        | "ambiguous-ownership"
        | "household-no-contact"
        | "missing-email";
      personId: string | null;
    };

export async function resolveAnimalOwner(
  animalId: string,
  asOf: string,
  db: RegistryDb = getRegistryDb(),
): Promise<ResolvedOwner> {
  if (!UUID_RE.test(animalId)) {
    return { status: "skip", detail: "no-owner", personId: null };
  }
  const rows = await db
    .select({
      personId: ownerships.personId,
      householdId: ownerships.householdId,
      name: persons.fullName,
      email: persons.email,
    })
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .where(
      and(
        eq(ownerships.animalId, animalId),
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    );
  if (rows.length === 0) {
    return { status: "skip", detail: "no-owner", personId: null };
  }
  if (rows.length > 1) {
    return { status: "skip", detail: "ambiguous-ownership", personId: null };
  }
  const row = rows[0];
  if (row.personId) {
    return {
      status: "ok",
      personId: row.personId,
      name: row.name ?? "Owner",
      email: row.email,
    };
  }
  // Household ownership resolves through its contactable member.
  const contacts = await householdContactFor([row.householdId!], db);
  const contact = contacts.get(row.householdId!);
  if (!contact) {
    return { status: "skip", detail: "household-no-contact", personId: null };
  }
  return {
    status: "ok",
    personId: contact.personId,
    name: contact.name,
    email: contact.email,
  };
}

// --- Ownership reads ------------------------------------------------------------

const OWNERSHIP_COLUMNS = {
  id: ownerships.id,
  animalId: ownerships.animalId,
  personId: ownerships.personId,
  householdId: ownerships.householdId,
  validFrom: ownerships.validFrom,
  validTo: ownerships.validTo,
  note: ownerships.note,
  createdAt: ownerships.createdAt,
  personName: persons.fullName,
  householdName: households.name,
} as const;

function toOwnershipDto(row: {
  id: string;
  animalId: string;
  personId: string | null;
  householdId: string | null;
  validFrom: string;
  validTo: string | null;
  note: string | null;
  createdAt: Date;
  personName: string | null;
  householdName: string | null;
}): OwnershipRecord {
  return {
    id: row.id,
    animalId: row.animalId,
    personId: row.personId,
    householdId: row.householdId,
    ownerName: row.personName ?? row.householdName ?? "Unknown",
    ownerKind: row.personId ? "person" : "household",
    validFrom: row.validFrom,
    validTo: row.validTo,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

// Full ownership history for one animal — the staff view. Newest
// interval first; both open and closed rows are history.
export async function listOwnershipHistory(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipRecord[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select(OWNERSHIP_COLUMNS)
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(eq(ownerships.animalId, animalId))
    .orderBy(desc(ownerships.validFrom), desc(ownerships.createdAt));
  return rows.map(toOwnershipDto);
}

// Every ownership interval currently valid for an animal — the real
// co-ownership list, not the deterministic single-owner projection.
export async function listCurrentOwnerships(
  animalId: string,
  asOf: string = todayIsoDate(),
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipRecord[]> {
  if (!UUID_RE.test(animalId) || !isIsoDateString(asOf)) return [];
  const rows = await db
    .select(OWNERSHIP_COLUMNS)
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        eq(ownerships.animalId, animalId),
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .orderBy(asc(ownerships.validFrom), asc(ownerships.id));
  return rows.map(toOwnershipDto);
}

// --- Owner-portal reads -----------------------------------------------------------

// One animal the owner can act on today: the current ownership row plus
// the animal's public-safe identity fields and the confirmation state.
export interface PortalAnimal {
  ownershipId: string;
  animalId: string;
  name: string;
  species: string;
  sex: string;
  // Derived display age from birth_date (formatAnimalAge) — '~' prefix
  // marks an estimate; null means unknown. Never a stored column.
  approxAge: string | null;
  photoUrl: string | null;
  // How the signed-in person holds this animal — directly, or through
  // a household they belong to.
  basis: "person" | "household";
  householdName: string | null;
  validFrom: string;
  // The animal's CURRENT chip, display-formatted as recorded (#168) —
  // read-only for owners; chip changes stay staff-controlled. Only the
  // owner's own animals ever reach this projection.
  chipNumber: string | null;
  // Annual-confirmation state (#166): the latest deliberate
  // confirmation on this relationship and the date the next one falls
  // due. Never derived from updated_at or profile edits.
  lastConfirmedOn: string | null;
  confirmationDueOn: string;
  confirmationDue: boolean;
}

// The households a person currently belongs to — the basis for
// household-basis portal access.
async function householdIdsForPerson(
  personId: string,
  db: RegistryDb,
): Promise<string[]> {
  const rows = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.personId, personId));
  return rows.map((r) => r.householdId);
}

// Every animal the person can see in the portal: current ownership rows
// where they are the person-side owner OR a member of the owning
// household. Historical ownership grants NO portal access — former
// owners cannot see or act on an animal they no longer own.
export async function listPortalAnimals(
  personId: string,
  asOf: string = todayIsoDate(),
  db: RegistryDb = getRegistryDb(),
): Promise<PortalAnimal[]> {
  if (!UUID_RE.test(personId)) return [];
  const householdIds = await householdIdsForPerson(personId, db);
  const ownerPredicate =
    householdIds.length > 0
      ? or(
          eq(ownerships.personId, personId),
          inArray(ownerships.householdId, householdIds),
        )
      : eq(ownerships.personId, personId);

  const lastConfirmed = db
    .select({
      ownershipId: ownershipConfirmations.ownershipId,
      confirmedOn: sql<string>`max(${ownershipConfirmations.confirmedOn})`.as(
        "last_confirmed_on",
      ),
    })
    .from(ownershipConfirmations)
    .groupBy(ownershipConfirmations.ownershipId)
    .as("last_confirmed");

  const rows = await db
    .select({
      ownershipId: ownerships.id,
      animalId: animals.id,
      name: animals.name,
      species: animals.species,
      sex: animals.sex,
      birthDate: animals.birthDate,
      birthDateEstimated: animals.birthDateEstimated,
      photoUrls: animals.photoUrls,
      validFrom: ownerships.validFrom,
      personId: ownerships.personId,
      householdId: ownerships.householdId,
      householdName: households.name,
      lastConfirmedOn: lastConfirmed.confirmedOn,
    })
    .from(ownerships)
    .innerJoin(animals, eq(ownerships.animalId, animals.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .leftJoin(lastConfirmed, eq(lastConfirmed.ownershipId, ownerships.id))
    .where(
      and(
        ownerPredicate,
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .orderBy(asc(animals.name), asc(ownerships.id));

  // Current chip per animal — one batch query; the partial unique
  // index guarantees at most one open record per animal.
  const animalIds = [...new Set(rows.map((r) => r.animalId))];
  const chipRows =
    animalIds.length > 0
      ? await db
          .select({
            animalId: microchipRecords.animalId,
            chipNumber: microchipRecords.chipNumber,
            chipDisplay: microchipRecords.chipDisplay,
          })
          .from(microchipRecords)
          .where(
            and(
              inArray(microchipRecords.animalId, animalIds),
              isNull(microchipRecords.assignedTo),
            ),
          )
      : [];
  const chipByAnimal = new Map(
    chipRows.map((c) => [c.animalId, c.chipDisplay ?? c.chipNumber]),
  );

  // One card per animal: when a person reaches the same animal through
  // both a direct and a household ownership, the direct relationship
  // wins — the household row is still real history, just redundant for
  // display.
  const seen = new Set<string>();
  const animals_: PortalAnimal[] = [];
  const sorted = [...rows].sort((a, b) => {
    if (a.animalId !== b.animalId) return a.name.localeCompare(b.name);
    return a.personId === personId ? -1 : 1;
  });
  for (const row of sorted) {
    if (seen.has(row.animalId)) continue;
    seen.add(row.animalId);
    // A freshly-recorded ownership counts as affirmed at valid_from —
    // staff knowledge established it — so the first annual confirmation
    // falls due one year after the interval opened, not immediately.
    const affirmed = row.lastConfirmedOn ?? row.validFrom;
    const dueOn = addDaysToIsoDate(affirmed, CONFIRMATION_PERIOD_DAYS);
    animals_.push({
      ownershipId: row.ownershipId,
      animalId: row.animalId,
      name: row.name,
      species: row.species,
      sex: row.sex,
      approxAge: formatAnimalAge(row.birthDate, row.birthDateEstimated),
      photoUrl: row.photoUrls?.[0] ?? null,
      basis: row.personId === personId ? "person" : "household",
      householdName: row.personId === personId ? null : row.householdName,
      validFrom: row.validFrom,
      chipNumber: chipByAnimal.get(row.animalId) ?? null,
      lastConfirmedOn: row.lastConfirmedOn,
      confirmationDueOn: dueOn,
      confirmationDue: dueOn <= asOf,
    });
  }
  return animals_;
}

// A CLOSED ownership interval the person was part of — the portal's
// "past animals" view (#167). When an animal dies or leaves Saba its
// ownerships close, but the association is real history the owner should
// still see — not a disappearance. Carries the registry lifecycle label
// so a deceased animal reads as deceased; no medical/internal data.
export interface PortalPastAnimal {
  animalId: string;
  name: string;
  species: string;
  sex: string;
  approxAge: string | null;
  photoUrl: string | null;
  lifecycleStatus: string;
  basis: "person" | "household";
  householdName: string | null;
  validFrom: string;
  validTo: string;
}

export async function listPortalPastAnimals(
  personId: string,
  asOf: string = todayIsoDate(),
  db: RegistryDb = getRegistryDb(),
): Promise<PortalPastAnimal[]> {
  if (!UUID_RE.test(personId)) return [];
  const householdIds = await householdIdsForPerson(personId, db);
  const ownerPredicate =
    householdIds.length > 0
      ? or(
          eq(ownerships.personId, personId),
          inArray(ownerships.householdId, householdIds),
        )
      : eq(ownerships.personId, personId);

  const rows = await db
    .select({
      animalId: animals.id,
      name: animals.name,
      species: animals.species,
      sex: animals.sex,
      birthDate: animals.birthDate,
      birthDateEstimated: animals.birthDateEstimated,
      lifecycleStatus: animals.lifecycleStatus,
      photoUrls: animals.photoUrls,
      validFrom: ownerships.validFrom,
      validTo: ownerships.validTo,
      personId: ownerships.personId,
      householdName: households.name,
    })
    .from(ownerships)
    .innerJoin(animals, eq(ownerships.animalId, animals.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        ownerPredicate,
        lte(ownerships.validFrom, asOf),
        // Closed = valid_to set and already reached. An interval that
        // merely HAS an end date but ends tomorrow is still current.
        sql`${ownerships.validTo} IS NOT NULL AND ${ownerships.validTo} <= ${asOf}`,
      ),
    )
    .orderBy(desc(ownerships.validTo), asc(animals.name), asc(ownerships.id));

  // One card per animal — same dedup rule as listPortalAnimals.
  const seen = new Set<string>();
  const past: PortalPastAnimal[] = [];
  const sorted = [...rows].sort((a, b) => {
    if (a.animalId !== b.animalId) return b.validTo!.localeCompare(a.validTo!);
    return a.personId === personId ? -1 : 1;
  });
  for (const row of sorted) {
    if (seen.has(row.animalId) || !row.validTo) continue;
    seen.add(row.animalId);
    past.push({
      animalId: row.animalId,
      name: row.name,
      species: row.species,
      sex: row.sex,
      approxAge: formatAnimalAge(row.birthDate, row.birthDateEstimated),
      photoUrl: row.photoUrls?.[0] ?? null,
      lifecycleStatus: row.lifecycleStatus,
      basis: row.personId === personId ? "person" : "household",
      householdName: row.personId === personId ? null : row.householdName,
      validFrom: row.validFrom,
      validTo: row.validTo,
    });
  }
  return past;
}

// --- Portal authorization --------------------------------------------------------

// THE owner-side authorization check: "is this ownership currently
// valid AND held by this person — directly or via household
// membership?" Every portal mutation resolves the relationship through
// here; an animal/ownership id supplied by the client is never trusted
// as proof of ownership.
export async function getOwnedOwnership(
  ownershipId: string,
  personId: string,
  asOf: string = todayIsoDate(),
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipRecord | null> {
  if (!UUID_RE.test(ownershipId) || !UUID_RE.test(personId)) return null;
  const householdIds = await householdIdsForPerson(personId, db);
  const ownerPredicate =
    householdIds.length > 0
      ? or(
          eq(ownerships.personId, personId),
          inArray(ownerships.householdId, householdIds),
        )
      : eq(ownerships.personId, personId);
  const rows = await db
    .select(OWNERSHIP_COLUMNS)
    .from(ownerships)
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        eq(ownerships.id, ownershipId),
        ownerPredicate,
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
      ),
    )
    .limit(1);
  return rows[0] ? toOwnershipDto(rows[0]) : null;
}

// --- Staff mutations --------------------------------------------------------------

export type OwnershipMutationResult =
  | { ok: true; ownership: OwnershipRecord }
  | {
      ok: false;
      reason: "not-found" | "invalid" | "conflict" | "overlap";
      field?: string;
    };

export interface OwnershipWriteInput {
  animalId: string;
  personId?: string | null;
  householdId?: string | null;
  validFrom: string;
  validTo?: string | null;
  note?: string | null;
}

export function validateOwnershipInput(
  input: OwnershipWriteInput,
): string | null {
  if (!UUID_RE.test(input.animalId)) return "animalId";
  const personId = input.personId?.trim() || null;
  const householdId = input.householdId?.trim() || null;
  if ((personId === null) === (householdId === null)) return "owner";
  if (personId !== null && !UUID_RE.test(personId)) return "personId";
  if (householdId !== null && !UUID_RE.test(householdId)) return "householdId";
  if (!isIsoDateString(input.validFrom)) return "validFrom";
  const validTo = input.validTo?.trim() || null;
  if (validTo !== null) {
    if (!isIsoDateString(validTo)) return "validTo";
    if (validTo <= input.validFrom) return "validTo";
  }
  if (input.note != null && input.note.length > MAX_NOTE) return "note";
  return null;
}

// Same-owner overlap guard: an interval overlapping an existing
// interval for the SAME animal+owner side is contradictory data. Runs
// inside the caller's transaction so concurrent writers serialize on
// the overlapping rows they would touch. Co-ownership by DIFFERENT
// owners overlapping is legitimate and unaffected.
async function sameOwnerOverlapExists(
  tx: Queryable,
  input: { animalId: string; personId: string | null; householdId: string | null; validFrom: string; validTo: string | null },
  excludeId?: string,
): Promise<boolean> {
  const newTo = input.validTo ?? "9999-12-31";
  const rows = await tx
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.animalId, input.animalId),
        input.personId
          ? eq(ownerships.personId, input.personId)
          : eq(ownerships.householdId, input.householdId!),
        excludeId ? sql`${ownerships.id} <> ${excludeId}` : undefined,
        // [valid_from, valid_to) overlap: existing starts before the new
        // interval ends AND ends after the new interval starts.
        lt(ownerships.validFrom, newTo),
        or(
          isNull(ownerships.validTo),
          gt(ownerships.validTo, input.validFrom),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Staff-opened ownership — the write side of "who owns this animal".
// Every current-owner projection in the system reads what this writes.
export async function createOwnership(
  input: OwnershipWriteInput,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipMutationResult> {
  const invalidField = validateOwnershipInput(input);
  if (invalidField) {
    return { ok: false, reason: "invalid", field: invalidField };
  }
  const personId = input.personId?.trim() || null;
  const householdId = input.householdId?.trim() || null;
  const validTo = input.validTo?.trim() || null;

  return db.transaction(async (tx) => {
    const [animal] = await tx
      .select({ id: animals.id })
      .from(animals)
      .where(eq(animals.id, input.animalId));
    if (!animal) return { ok: false as const, reason: "not-found" as const };

    if (personId) {
      const [person] = await tx
        .select({ id: persons.id })
        .from(persons)
        .where(eq(persons.id, personId));
      if (!person)
        return { ok: false as const, reason: "invalid" as const, field: "personId" };
    } else {
      const [household] = await tx
        .select({ id: households.id })
        .from(households)
        .where(eq(households.id, householdId!));
      if (!household)
        return { ok: false as const, reason: "invalid" as const, field: "householdId" };
    }

    if (
      await sameOwnerOverlapExists(tx, {
        animalId: input.animalId,
        personId,
        householdId,
        validFrom: input.validFrom,
        validTo,
      })
    ) {
      return { ok: false as const, reason: "overlap" as const };
    }

    const [row] = await tx
      .insert(ownerships)
      .values({
        animalId: input.animalId,
        personId,
        householdId,
        validFrom: input.validFrom,
        validTo,
        note: input.note?.trim() || null,
      })
      .returning();
    const dto = toOwnershipDto({ ...row, personName: null, householdName: null });
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "ownership",
      entityId: row.id,
      action: "create",
      after: {
        animalId: row.animalId,
        personId: row.personId,
        householdId: row.householdId,
        validFrom: row.validFrom,
        validTo: row.validTo,
      },
    });
    return { ok: true, ownership: dto };
  });
}

// Close an ownership interval — the "ownership ended" half of every
// transfer. validTo is the first day the relationship no longer holds.
export async function closeOwnership(
  ownershipId: string,
  validTo: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipMutationResult> {
  if (!UUID_RE.test(ownershipId)) return { ok: false, reason: "not-found" };
  if (!isIsoDateString(validTo)) {
    return { ok: false, reason: "invalid", field: "validTo" };
  }
  return db.transaction(async (tx) => {
    // Lock the row itself (no join — FOR UPDATE with joined tables
    // needs an OF clause and only locks what it names).
    const [locked] = await tx
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, ownershipId))
      .for("update");
    if (!locked) return { ok: false as const, reason: "not-found" as const };
    if (locked.validTo !== null) {
      // Already closed — closing again is a conflict, not a rewrite.
      return { ok: false as const, reason: "conflict" as const };
    }
    if (validTo <= locked.validFrom) {
      return { ok: false as const, reason: "invalid" as const, field: "validTo" };
    }
    const before = locked;
    const [row] = await tx
      .update(ownerships)
      .set({ validTo })
      .where(eq(ownerships.id, ownershipId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "ownership",
      entityId: ownershipId,
      action: "close",
      before: { validFrom: before.validFrom, validTo: before.validTo },
      after: { validFrom: before.validFrom, validTo },
    });
    return {
      ok: true,
      ownership: toOwnershipDto({ ...row, personName: null, householdName: null }),
    };
  });
}

// Transfer = close the old interval + open the new one in ONE
// transaction — the registry never has a gap where neither row is
// committed, and the old owner row is preserved as history.
export async function transferOwnership(
  {
    ownershipId,
    validTo,
    newOwner,
    note,
  }: {
    ownershipId: string;
    validTo: string;
    newOwner: { personId?: string | null; householdId?: string | null };
    note?: string | null;
  },
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipMutationResult> {
  if (!UUID_RE.test(ownershipId)) return { ok: false, reason: "not-found" };
  if (!isIsoDateString(validTo)) {
    return { ok: false, reason: "invalid", field: "validTo" };
  }
  const personId = newOwner.personId?.trim() || null;
  const householdId = newOwner.householdId?.trim() || null;
  if ((personId === null) === (householdId === null)) {
    return { ok: false, reason: "invalid", field: "owner" };
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, ownershipId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.validTo !== null) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (validTo <= before.validFrom) {
      return { ok: false as const, reason: "invalid" as const, field: "validTo" };
    }

    // New interval opens the day the old one closes — contiguous, no
    // overlap, no gap.
    if (
      await sameOwnerOverlapExists(tx, {
        animalId: before.animalId,
        personId,
        householdId,
        validFrom: validTo,
        validTo: null,
      })
    ) {
      return { ok: false as const, reason: "overlap" as const };
    }

    await tx
      .update(ownerships)
      .set({ validTo })
      .where(eq(ownerships.id, ownershipId));
    const [row] = await tx
      .insert(ownerships)
      .values({
        animalId: before.animalId,
        personId,
        householdId,
        validFrom: validTo,
        note: note?.trim() || null,
      })
      .returning();

    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "ownership",
      entityId: row.id,
      action: "transfer",
      before: {
        ownershipId: before.id,
        animalId: before.animalId,
        personId: before.personId,
        householdId: before.householdId,
        validFrom: before.validFrom,
      },
      after: {
        animalId: row.animalId,
        personId: row.personId,
        householdId: row.householdId,
        validFrom: row.validFrom,
        closedOwnershipId: before.id,
        closedValidTo: validTo,
      },
    });
    return {
      ok: true,
      ownership: toOwnershipDto({ ...row, personName: null, householdName: null }),
    };
  });
}

// Staff correction of an erroneous interval (wrong dates/note on a row
// that was never right). History-preserving changes go through
// close/transfer; this exists for fixing bad data, guarded by the
// created_at token the caller rendered.
export async function correctOwnership(
  ownershipId: string,
  input: { validFrom: string; validTo?: string | null; note?: string | null },
  expectedCreatedAt: string,
  actorLabel: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipMutationResult> {
  if (!UUID_RE.test(ownershipId)) return { ok: false, reason: "not-found" };
  if (!isIsoDateString(input.validFrom)) {
    return { ok: false, reason: "invalid", field: "validFrom" };
  }
  const validTo = input.validTo?.trim() || null;
  if (validTo !== null && (!isIsoDateString(validTo) || validTo <= input.validFrom)) {
    return { ok: false, reason: "invalid", field: "validTo" };
  }
  const expectedMs = new Date(expectedCreatedAt).getTime();
  if (Number.isNaN(expectedMs)) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, ownershipId))
      .for("update");
    if (!before) return { ok: false as const, reason: "not-found" as const };
    if (before.createdAt.getTime() !== expectedMs) {
      return { ok: false as const, reason: "conflict" as const };
    }
    if (
      await sameOwnerOverlapExists(
        tx,
        {
          animalId: before.animalId,
          personId: before.personId,
          householdId: before.householdId,
          validFrom: input.validFrom,
          validTo,
        },
        ownershipId,
      )
    ) {
      return { ok: false as const, reason: "overlap" as const };
    }
    const [row] = await tx
      .update(ownerships)
      .set({
        validFrom: input.validFrom,
        validTo,
        note: input.note?.trim() || null,
      })
      .where(eq(ownerships.id, ownershipId))
      .returning();
    await tx.insert(auditEvents).values({
      actorLabel,
      entityType: "ownership",
      entityId: ownershipId,
      action: "correct",
      before: {
        validFrom: before.validFrom,
        validTo: before.validTo,
        note: before.note,
      },
      after: { validFrom: row.validFrom, validTo: row.validTo, note: row.note },
    });
    return {
      ok: true,
      ownership: toOwnershipDto({ ...row, personName: null, householdName: null }),
    };
  });
}

// --- Annual confirmations -----------------------------------------------------------

// The deliberate-confirmation cadence: a relationship must be
// re-affirmed once per year. The value lives here — the eligibility
// query, the portal DTO, and the reminder policy all read the same
// constant so they can never disagree on "annual".
export const CONFIRMATION_PERIOD_DAYS = 365;

export type ConfirmationResult =
  | { ok: true; confirmation: OwnershipConfirmation }
  | { ok: false; reason: "not-found" | "invalid" | "not-current" | "not-owner" };

// Record a deliberate "this animal is still living on Saba and
// associated with this owner" attestation. The write validates that the
// ownership is current on confirmed_on and that personId is actually a
// party to it (the person-side owner, or a member of the owning
// household) — a confirmation can never be filed against a relationship
// the confirmer isn't part of. History is append-only.
export async function recordOwnershipConfirmation(
  {
    ownershipId,
    personId,
    method,
    confirmedByIdentityId,
    actorLabel,
    notes,
    confirmedOn = todayIsoDate(),
  }: {
    ownershipId: string;
    personId: string;
    method: "owner-portal" | "staff";
    confirmedByIdentityId?: string | null;
    actorLabel?: string | null;
    notes?: string | null;
    confirmedOn?: string;
  },
  db: RegistryDb = getRegistryDb(),
): Promise<ConfirmationResult> {
  if (!UUID_RE.test(ownershipId) || !UUID_RE.test(personId)) {
    return { ok: false, reason: "invalid" };
  }
  if (!isIsoDateString(confirmedOn) || confirmedOn > todayIsoDate()) {
    return { ok: false, reason: "invalid" };
  }
  if (method !== "owner-portal" && method !== "staff") {
    return { ok: false, reason: "invalid" };
  }

  return db.transaction(async (tx) => {
    const [ownership] = await tx
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, ownershipId))
      .for("update");
    if (!ownership) return { ok: false as const, reason: "not-found" as const };

    // The relationship must be current on the confirmation date —
    // confirming a closed interval would assert a falsehood.
    if (
      ownership.validFrom > confirmedOn ||
      (ownership.validTo !== null && ownership.validTo <= confirmedOn)
    ) {
      return { ok: false as const, reason: "not-current" as const };
    }

    // The confirmer must be a party to the relationship: the
    // person-side owner, or a member of the owning household.
    if (ownership.personId) {
      if (ownership.personId !== personId) {
        return { ok: false as const, reason: "not-owner" as const };
      }
    } else {
      const [membership] = await tx
        .select({ personId: householdMembers.personId })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, ownership.householdId!),
            eq(householdMembers.personId, personId),
          ),
        );
      if (!membership) return { ok: false as const, reason: "not-owner" as const };
    }

    const [row] = await tx
      .insert(ownershipConfirmations)
      .values({
        ownershipId,
        animalId: ownership.animalId,
        personId,
        confirmedByIdentityId: confirmedByIdentityId ?? null,
        confirmedOn,
        method,
        actorLabel: actorLabel ?? null,
        notes: notes?.trim() || null,
      })
      .returning();

    const [person] = await tx
      .select({ fullName: persons.fullName })
      .from(persons)
      .where(eq(persons.id, personId));

    await tx.insert(auditEvents).values({
      actorIdentityId: confirmedByIdentityId ?? null,
      actorLabel: actorLabel ?? null,
      entityType: "ownership_confirmation",
      entityId: row.id,
      action: "confirm",
      after: {
        ownershipId,
        animalId: ownership.animalId,
        personId,
        confirmedOn,
        method,
      },
    });

    return {
      ok: true,
      confirmation: {
        id: row.id,
        ownershipId: row.ownershipId,
        animalId: row.animalId,
        personId: row.personId,
        personName: person?.fullName ?? null,
        confirmedOn: row.confirmedOn,
        method: row.method,
        actorLabel: row.actorLabel,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
      },
    };
  });
}

// Confirmation history for one animal (staff view) — newest first.
export async function listConfirmationsForAnimal(
  animalId: string,
  db: RegistryDb = getRegistryDb(),
): Promise<OwnershipConfirmation[]> {
  if (!UUID_RE.test(animalId)) return [];
  const rows = await db
    .select({
      id: ownershipConfirmations.id,
      ownershipId: ownershipConfirmations.ownershipId,
      animalId: ownershipConfirmations.animalId,
      personId: ownershipConfirmations.personId,
      personName: persons.fullName,
      confirmedOn: ownershipConfirmations.confirmedOn,
      method: ownershipConfirmations.method,
      actorLabel: ownershipConfirmations.actorLabel,
      notes: ownershipConfirmations.notes,
      createdAt: ownershipConfirmations.createdAt,
    })
    .from(ownershipConfirmations)
    .leftJoin(persons, eq(ownershipConfirmations.personId, persons.id))
    .where(eq(ownershipConfirmations.animalId, animalId))
    .orderBy(desc(ownershipConfirmations.confirmedOn), desc(ownershipConfirmations.createdAt));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

// --- #172 eligibility source -------------------------------------------------------

// One relationship that needs its annual re-affirmation — the canonical
// input to the 'annual-confirmation-reminder' evaluator and to #177's
// "confirmations outstanding" queue.
export interface ConfirmationEligibilityRow {
  ownershipId: string;
  animalId: string;
  animalName: string;
  personId: string | null;
  householdId: string | null;
  personName: string | null;
  householdName: string | null;
  // The last deliberate confirmation on the relationship, or null when
  // it has never been confirmed (valid_from is then the affirmation).
  lastConfirmedOn: string | null;
  // The date this relationship's confirmation fell/falls due —
  // lastAffirmed + CONFIRMATION_PERIOD_DAYS. Also the reminder cycle
  // key: stable for the whole overdue period of one lapse.
  dueOn: string;
}

// "Which current owner↔animal relationships have not been explicitly
// confirmed within the confirmation period?" — THE authoritative
// annual-confirmation eligibility query. #172's evaluator consumes it;
// nothing else should re-derive this logic.
export async function listOwnershipsRequiringConfirmation(
  { asOf = todayIsoDate() }: { asOf?: string } = {},
  db: RegistryDb = getRegistryDb(),
): Promise<ConfirmationEligibilityRow[]> {
  if (!isIsoDateString(asOf)) {
    throw new Error("listOwnershipsRequiringConfirmation: asOf must be YYYY-MM-DD");
  }
  const rows = await db
    .select({
      ownershipId: ownerships.id,
      animalId: animals.id,
      animalName: animals.name,
      personId: ownerships.personId,
      householdId: ownerships.householdId,
      personName: persons.fullName,
      householdName: households.name,
      lastConfirmedOn: sql<
        string | null
      >`(SELECT max(c.confirmed_on) FROM ownership_confirmations c WHERE c.ownership_id = ${ownerships.id})`,
      dueOn: sql<string>`((coalesce((SELECT max(c.confirmed_on) FROM ownership_confirmations c WHERE c.ownership_id = ${ownerships.id}), ${ownerships.validFrom})::date + interval '1 day' * ${CONFIRMATION_PERIOD_DAYS})::date)`,
    })
    .from(ownerships)
    .innerJoin(animals, eq(ownerships.animalId, animals.id))
    .leftJoin(persons, eq(ownerships.personId, persons.id))
    .leftJoin(households, eq(ownerships.householdId, households.id))
    .where(
      and(
        lte(ownerships.validFrom, asOf),
        or(isNull(ownerships.validTo), gt(ownerships.validTo, asOf)),
        sql`((coalesce((SELECT max(c.confirmed_on) FROM ownership_confirmations c WHERE c.ownership_id = ${ownerships.id}), ${ownerships.validFrom})::date + interval '1 day' * ${CONFIRMATION_PERIOD_DAYS})::date) <= ${asOf}`,
      ),
    )
    .orderBy(asc(ownerships.animalId), asc(ownerships.id));
  return rows;
}
