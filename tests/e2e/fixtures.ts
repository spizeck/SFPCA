// Shared E2E fixtures: the seeded baseline plus the `test` export every
// spec must use.
//
// Lifecycle context (see issue #229): Playwright's runner starts
// config.webServer — a plugin task — BEFORE globalSetup, so the PGlite
// engine, migrations, and wire-protocol socket live in the webServer
// process (tests/e2e/db-server.ts). This module only ever talks to the
// database through that socket, exactly like the dev server does.
//
// Retry isolation: the suite shares one PGlite datastore and one
// Firestore emulator for the whole run, and specs mutate seeded state
// through the real UI (registrations, payments, merges, cases). Without
// a reset, a retry inherits whatever its failed attempt left behind —
// e.g. Penny already registered — and fails differently. The `test`
// export below resets the datastore to the seeded baseline before EVERY
// test attempt, so attempt N sees exactly what attempt 0 saw, and no
// spec's correctness depends on file ordering or a predecessor's
// cleanup discipline.
import { test as base } from "@playwright/test";
import { getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_CLAIM_EMAIL,
  E2E_CLAIM_PASSWORD,
  E2E_DATABASE_URL,
  E2E_FIREBASE_PROJECT_ID,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./env";

// firebase-admin targets the emulators purely through the
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST env that
// `firebase emulators:exec` exports — no credentials involved.
function adminApp(): App {
  return getApps().length
    ? getApp()
    : initializeApp({ projectId: E2E_FIREBASE_PROJECT_ID });
}

// The four fixture accounts, idempotently. Runs once per run from
// globalSetup — the Auth emulator's account store persists for the
// whole run and nothing under test creates users, so per-test reset
// deliberately does not touch it.
export async function ensureE2EAuthUsers(): Promise<void> {
  const auth: Auth = getAuth(adminApp());
  for (const [email, password] of [
    [E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD],
    [E2E_USER_EMAIL, E2E_USER_PASSWORD],
    [E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD],
    [E2E_CLAIM_EMAIL, E2E_CLAIM_PASSWORD],
  ] as const) {
    try {
      await auth.createUser({ email, password, emailVerified: true });
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code !== "auth/email-already-exists") throw error;
      await auth.updateUser((await auth.getUserByEmail(email)).uid, {
        password,
        emailVerified: true,
      });
    }
  }
}

// Every user-defined table, discovered rather than listed — a schema
// change can never leave the reset silently incomplete. drizzle keeps
// its migration journal in the `drizzle` schema, outside this filter.
async function truncateRegistry(sql: postgres.Sql): Promise<void> {
  const tables = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'`;
  if (tables.length === 0) return;
  await sql.unsafe(
    `truncate table ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
  );
}

// The registry fixtures the suite is written against: adoptable
// animals, the linked owner + household, the claimable person, chip
// records + the open conflict, Reggie/Penny/Oldbones for registration
// flows, and Daisy for lost/found. ownerUid must be the real Auth
// emulator uid for E2E_OWNER_EMAIL — the session route joins on it.
async function seedE2ERegistry(
  db: PostgresJsDatabase<typeof schema>,
  ownerUid: string,
): Promise<void> {
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

// Firestore content the public pages read. Reuses the repo's existing
// seed fixture rather than duplicating content definitions.
async function seedE2EContent(db: Firestore): Promise<void> {
  const seed = JSON.parse(
    readFileSync(join(__dirname, "../../scripts/seed-data.json"), "utf8"),
  );
  await db.collection("homepage").doc("main").set(seed.homepage);
  await db.collection("siteSettings").doc("global").set({
    ...seed.siteSettings,
    // Fake demo embed so the map iframe renders (a11y coverage).
    mapEmbedUrl: "https://www.google.com/maps?q=The+Bottom,+Saba&output=embed",
  });

  // FAQs so the public accordion renders real items.
  const faqs = [
    {
      category: "General",
      question: "What does SFPCA do?",
      answer: "We prevent cruelty to animals on Saba through care, registration, and adoption services.",
      order: 1,
    },
    {
      category: "Adoption Process",
      question: "How do I adopt an animal?",
      answer: "Contact us to start the adoption process and meet available animals.",
      order: 2,
    },
  ];
  for (const faq of faqs) {
    await db.collection("faq").add({ ...faq, createdAt: new Date() });
  }
}

// Restore the exact seeded baseline in both datastores. Called by
// globalSetup once per run and by the auto-fixture below before every
// test attempt — reset and initial seed are the same code path, so a
// "fresh" attempt can never diverge from what the suite was authored
// against.
//
// Scope: Postgres is truncated wholesale (every public-schema table,
// RESTART IDENTITY CASCADE) then re-seeded; Firestore is wiped
// collection-by-collection then re-seeded. The Auth emulator is
// untouched — its four fixture users are never mutated by tests.
export async function resetE2EState(): Promise<void> {
  const auth = getAuth(adminApp());
  // The seeded auth_identities row must carry the real emulator uid;
  // globalSetup's ensureE2EAuthUsers guarantees it exists.
  const ownerUid = (await auth.getUserByEmail(E2E_OWNER_EMAIL)).uid;

  // One connection: pglite-socket queues protocol messages per-message,
  // so concurrent connections can interleave extended-protocol
  // sequences — the same constraint as the app's DATABASE_POOL_MAX=1.
  const sql = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    const db = drizzle(sql, { schema });
    await truncateRegistry(sql);
    await seedE2ERegistry(db, ownerUid);
  } finally {
    await sql.end();
  }

  const firestore = getFirestore(adminApp());
  await Promise.all(
    (await firestore.listCollections()).map((collection) =>
      firestore.recursiveDelete(collection),
    ),
  );
  await seedE2EContent(firestore);
}

// The test export every e2e spec must import (in place of
// "@playwright/test"). The auto-fixture restores the seeded baseline
// before each attempt — this is what makes Playwright retries
// deterministic rather than best-effort.
export const test = base.extend<{ e2eBaseline: void }>({
  e2eBaseline: [
    async ({}, use) => {
      await resetE2EState();
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
