// The seeded Postgres baseline for the e2e suite — executed by
// db-server.ts's control endpoint DIRECTLY against the PGlite engine.
//
// Why not the wire-protocol socket: pglite-socket multiplexes every
// client connection through one backend session, so a second
// connection's messages can interleave with the app's in-flight
// extended-protocol sequences (Parse/Bind/Execute) and corrupt them —
// observed as SQLSTATE 26000 "unnamed prepared statement does not
// exist" on the app's pooled connection when a per-test reset raced a
// straggler request from the previous test. Engine-direct access is
// serialized by PGlite's own query queue, so resets can never corrupt
// app traffic (or vice versa).
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../src/lib/db/schema";
import {
  animals,
  adminUsers,
  authIdentities,
  householdMembers,
  households,
  microchipConflicts,
  microchipRecords,
  ownerships,
  persons,
  registrations,
} from "../../src/lib/db/schema";
import { E2E_ADMIN_EMAIL, E2E_CLAIM_EMAIL, E2E_OWNER_EMAIL } from "./env";

type RegistryDb = PgliteDatabase<typeof schema>;

// Every user-defined table, discovered rather than listed — a schema
// change can never leave the reset silently incomplete. drizzle keeps
// its migration journal in the `drizzle` schema, outside this filter.
export async function truncateRegistry(db: RegistryDb): Promise<void> {
  const result = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = (result as unknown as { rows: { tablename: string }[] })
    .rows;
  if (tables.length === 0) return;
  await db.execute(
    sql.raw(
      `truncate table ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
}

// The registry fixtures the suite is written against: adoptable
// animals, the linked owner + household, the claimable person, chip
// records + the open conflict, Reggie/Penny/Oldbones for registration
// flows, and Daisy for lost/found. ownerUid must be the real Auth
// emulator uid for E2E_OWNER_EMAIL — the session route joins on it.
export async function seedE2ERegistry(
  db: RegistryDb,
  ownerUid: string,
): Promise<void> {
  // E2E exercises LIVE behavior (no demo banner, real sender plumbing,
  // normal SEO). Freshly-migrated databases begin 'prelaunch-demo' by
  // design (#275) and truncateRegistry drops the row — an absent row
  // already resolves 'live', but pinning it makes the test posture
  // explicit rather than an accident of the reset order.
  await db.execute(
    sql`insert into app_state (id, lifecycle) values (1, 'live')
        on conflict (id) do nothing`,
  );

  // The admin_users row is what authorizes the E2E admin's session — the
  // same record production reads; no ADMIN_EMAILS bootstrap is needed.
  await db.insert(adminUsers).values({
    email: E2E_ADMIN_EMAIL,
    role: "admin",
  });

  // Adoptable animals so the adoptions page and homepage cards render —
  // seeded into Postgres, the only read authority for animals.
  const seed = JSON.parse(
    readFileSync(join(__dirname, "../../scripts/seed-data.json"), "utf8"),
  );
  for (const animal of seed.animals ?? []) {
    const { id, status, photos, ...rest } = animal;
    await db.insert(animals).values({
      legacyId: id ?? null,
      name: rest.name,
      species: rest.species,
      sex: rest.sex,
      description: rest.description ?? null,
      // The seed's status is the adoption-catalog value; every seeded
      // animal is lifecycle 'active' (known on-island).
      lifecycleStatus: "active",
      adoptionStatus: status,
      photoUrls: photos ?? [],
    });
  }

  // --- Owner registry fixtures (#166) -----------------------------------
  // A linked owner: auth_identities.providerUid is the Firebase uid, so
  // the session route's provisioning finds the identity already linked
  // and the portal serves this person's animals. Two animals exercise
  // both authorization bases — direct person ownership (confirmation
  // overdue: valid_from is >1 year old with no confirmations) and
  // household membership (recent valid_from: not yet due).
  const [ownerPerson] = await db
    .insert(persons)
    .values({
      fullName: "E2E Owner",
      email: E2E_OWNER_EMAIL,
      phone: "+599 416 0001",
      address: "Windwardside, Saba",
    })
    .returning();
  await db.insert(authIdentities).values({
    provider: "firebase",
    providerUid: ownerUid,
    email: E2E_OWNER_EMAIL,
    personId: ownerPerson.id,
  });
  const [household] = await db
    .insert(households)
    .values({ name: "E2E Household", address: "The Bottom, Saba" })
    .returning();
  await db.insert(householdMembers).values({
    householdId: household.id,
    personId: ownerPerson.id,
    role: "primary",
  });
  const [personAnimal] = await db
    .insert(animals)
    .values({
      name: "Rexley",
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  const [householdAnimal] = await db
    .insert(animals)
    .values({
      name: "Whiskers",
      species: "cat",
      sex: "female",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  const recent = new Date();
  recent.setDate(recent.getDate() - 30);
  await db.insert(ownerships).values([
    { animalId: personAnimal.id, personId: ownerPerson.id, validFrom: "2024-01-01" },
    {
      animalId: householdAnimal.id,
      householdId: household.id,
      validFrom: recent.toISOString().slice(0, 10),
    },
  ]);

  // An unclaimed registry person whose email matches the claim user's
  // login — provisionOwnerLink must file an account-claim request rather
  // than linking on email alone. The owned animal only becomes visible
  // after staff approve the claim.
  const [claimPerson] = await db
    .insert(persons)
    .values({ fullName: "E2E Legacy Owner", email: E2E_CLAIM_EMAIL })
    .returning();
  const [claimAnimal] = await db
    .insert(animals)
    .values({
      name: "Claimdog",
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  await db.insert(ownerships).values({
    animalId: claimAnimal.id,
    personId: claimPerson.id,
    validFrom: recent.toISOString().slice(0, 10),
  });

  // --- Microchip registry fixtures (#168) -------------------------------
  // Rexley carries a chip — the scan workflow's happy path, exercised
  // with a formatted number to prove normalization. Whiskers' chip was
  // ALSO claimed on Claimdog at intake — the open conflict row the
  // match result must surface for staff review.
  await db.insert(microchipRecords).values([
    {
      animalId: personAnimal.id,
      chipNumber: "985113001234567",
      chipDisplay: "985-113-001-234-567",
      manufacturer: "Datamars",
      assignedFrom: "2024-01-01",
    },
    {
      animalId: householdAnimal.id,
      chipNumber: "999000111222",
      chipDisplay: "999-000-111-222",
      assignedFrom: "2024-01-01",
    },
  ]);
  await db.insert(microchipConflicts).values({
    chipNumber: "999000111222",
    claimedAnimalId: claimAnimal.id,
    existingAnimalId: householdAnimal.id,
    source: "staff",
    detail: "Scanner read the same chip on Claimdog at intake.",
  });

  // --- Annual registration fixtures (#169) ------------------------------
  // Reggie is a dedicated #169 animal — owned by the portal owner, with a
  // PRIOR-year registration as history and no current-year record so he
  // lands in the unregistered queue. (Rexley is deliberately NOT reused:
  // the owner-portal spec reports him deceased mid-suite.) A deceased
  // animal proves the queue is lifecycle-gated.
  const currentYear = new Date().getFullYear();
  const [registrationAnimal] = await db
    .insert(animals)
    .values({
      name: "Reggie",
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  await db.insert(ownerships).values({
    animalId: registrationAnimal.id,
    personId: ownerPerson.id,
    validFrom: "2024-01-01",
  });
  await db.insert(registrations).values({
    animalId: registrationAnimal.id,
    year: currentYear - 1,
    status: "active",
    personId: ownerPerson.id,
    ownerLabel: "E2E Owner",
    amountDueCents: 10000,
    currency: "USD",
  });
  await db.insert(animals).values({
    name: "Oldbones",
    species: "dog",
    sex: "male",
    lifecycleStatus: "deceased",
    photoUrls: [],
  });

  // Penny is the #170 ledger animal — owned by the portal owner, never
  // registered, so the full money journey (pending → confirm → paid →
  // refund → outstanding again) exercises real queue/portal movement.
  const [ledgerAnimal] = await db
    .insert(animals)
    .values({
      name: "Penny",
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  await db.insert(ownerships).values({
    animalId: ledgerAnimal.id,
    personId: ownerPerson.id,
    validFrom: "2024-01-01",
  });

  // Daisy is the #176 lost/found animal — a dedicated record so case
  // workflows (missing case, publish, scan-match, reunion) can't
  // collide with the other suites' animal lifecycle. She carries a
  // chip so the found-scan path can match her, and the portal owner
  // owns her so owner-reported missing is exercisable.
  const [lostAnimal] = await db
    .insert(animals)
    .values({
      name: "Daisy",
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  await db.insert(ownerships).values({
    animalId: lostAnimal.id,
    personId: ownerPerson.id,
    validFrom: "2024-01-01",
  });
  await db.insert(microchipRecords).values({
    animalId: lostAnimal.id,
    chipNumber: "985222000333444",
    chipDisplay: "985-222-000-333-444",
    assignedFrom: "2024-01-01",
  });
}
