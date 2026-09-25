// E2E fixture setup, run by Playwright inside `firebase emulators:exec`.
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are already in the
// environment, so firebase-admin targets the emulators with no
// credentials. The registry datastore is PGlite — a real Postgres engine
// exposed over the wire protocol by PGLiteSocketServer so the Next dev
// server talks to it through the same postgres.js client it uses for
// Neon. Everything here is idempotent and synthetic — never production.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
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
} from "../../src/lib/db/schema";
import { runMigrationsOnPglite } from "../../src/lib/db/migrate";

export const E2E_ADMIN_EMAIL = "e2e-admin@example.com";
export const E2E_ADMIN_PASSWORD = "e2e-test-only-password";
// Synthetic verified user with NO admin_users row: proves that a
// successful Firebase sign-in alone cannot establish an admin session or
// enter /admin. No matching person exists either — login provisions a
// fresh registry person, so this user sees an empty owner portal.
export const E2E_USER_EMAIL = "e2e-user@example.com";
export const E2E_USER_PASSWORD = "e2e-test-only-password";
// Pre-linked owner: an auth_identities row ties this Firebase uid to a
// seeded person who owns animals — exercises the full portal journey.
export const E2E_OWNER_EMAIL = "e2e-owner@example.com";
export const E2E_OWNER_PASSWORD = "e2e-test-only-password";
// Unlinked account whose email matches a seeded person with no linked
// identity — login files an 'account-claim' request instead of linking.
export const E2E_CLAIM_EMAIL = "e2e-claim@example.com";
export const E2E_CLAIM_PASSWORD = "e2e-test-only-password";

// The port the dev server's DATABASE_URL points at
// (playwright.config.ts webServer env).
export const E2E_PGLITE_PORT = 5544;

const app = initializeApp({ projectId: "demo-sfpca" });
const auth = getAuth(app);
const db = getFirestore(app);

export default async function globalSetup() {
  // Synthetic admin user in the Auth emulator. emailVerified is required:
  // the app's session endpoint (and the custom-claim rules boundary)
  // reject unverified identities, matching the production boundary.
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

  // --- Postgres registry (PGlite over the wire protocol) --------------
  // Replay the checked-in migrations on a fresh engine, then seed the
  // operational records the suites rely on. The admin_users row is what
  // authorizes the E2E admin's session — the same record production
  // reads; no ADMIN_EMAILS bootstrap is needed.
  const pglite = new PGlite();
  const pgliteDb = drizzle(pglite, { schema });
  await runMigrationsOnPglite(pgliteDb);
  await pgliteDb.insert(adminUsers).values({
    email: E2E_ADMIN_EMAIL,
    role: "admin",
  });

  const socketServer = new PGLiteSocketServer({
    db: pglite,
    port: E2E_PGLITE_PORT,
    host: "127.0.0.1",
    maxConnections: 8,
  });
  await socketServer.start();

  // Minimal content so public pages render real data. Reuses the repo's
  // existing seed fixture rather than duplicating content definitions.
  const seed = JSON.parse(
    readFileSync(join(__dirname, "../../scripts/seed-data.json"), "utf8"),
  );
  await db.collection("homepage").doc("main").set(seed.homepage);
  await db.collection("siteSettings").doc("global").set({
    ...seed.siteSettings,
    // Fake demo embed so the map iframe renders (a11y coverage).
    mapEmbedUrl: "https://www.google.com/maps?q=The+Bottom,+Saba&output=embed",
  });

  // Adoptable animals so the adoptions page and homepage cards render —
  // seeded into Postgres, the only read authority for animals.
  for (const animal of seed.animals ?? []) {
    const { id, status, photos, ...rest } = animal;
    await pgliteDb.insert(animals).values({
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

  // --- Owner registry fixtures (#166) -------------------------------------
  // A linked owner: auth_identities.providerUid is the Firebase uid, so
  // the session route's provisioning finds the identity already linked
  // and the portal serves this person's animals. Two animals exercise
  // both authorization bases — direct person ownership (confirmation
  // overdue: valid_from is >1 year old with no confirmations) and
  // household membership (recent valid_from: not yet due).
  const ownerUser = await auth.getUserByEmail(E2E_OWNER_EMAIL);
  const [ownerPerson] = await pgliteDb
    .insert(persons)
    .values({
      fullName: "E2E Owner",
      email: E2E_OWNER_EMAIL,
      phone: "+599 416 0001",
      address: "Windwardside, Saba",
    })
    .returning();
  await pgliteDb.insert(authIdentities).values({
    provider: "firebase",
    providerUid: ownerUser.uid,
    email: E2E_OWNER_EMAIL,
    personId: ownerPerson.id,
  });
  const [household] = await pgliteDb
    .insert(households)
    .values({ name: "E2E Household", address: "The Bottom, Saba" })
    .returning();
  await pgliteDb.insert(householdMembers).values({
    householdId: household.id,
    personId: ownerPerson.id,
    role: "primary",
  });
  const [personAnimal] = await pgliteDb
    .insert(animals)
    .values({
      name: "Rexley",
      species: "dog",
      sex: "male",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  const [householdAnimal] = await pgliteDb
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
  await pgliteDb.insert(ownerships).values([
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
  const [claimPerson] = await pgliteDb
    .insert(persons)
    .values({ fullName: "E2E Legacy Owner", email: E2E_CLAIM_EMAIL })
    .returning();
  const [claimAnimal] = await pgliteDb
    .insert(animals)
    .values({
      name: "Claimdog",
      species: "dog",
      sex: "female",
      lifecycleStatus: "active",
      photoUrls: [],
    })
    .returning();
  await pgliteDb.insert(ownerships).values({
    animalId: claimAnimal.id,
    personId: claimPerson.id,
    validFrom: recent.toISOString().slice(0, 10),
  });

  // --- Microchip registry fixtures (#168) ---------------------------------
  // Rexley carries a chip — the scan workflow's happy path, exercised
  // with a formatted number to prove normalization. Whiskers' chip was
  // ALSO claimed on Claimdog at intake — the open conflict row the
  // match result must surface for staff review.
  await pgliteDb.insert(microchipRecords).values([
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
  await pgliteDb.insert(microchipConflicts).values({
    chipNumber: "999000111222",
    claimedAnimalId: claimAnimal.id,
    existingAnimalId: householdAnimal.id,
    source: "staff",
    detail: "Scanner read the same chip on Claimdog at intake.",
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
  const existingFaqs = await db.collection("faq").listDocuments();
  await Promise.all(existingFaqs.map((doc) => doc.delete()));
  for (const faq of faqs) {
    await db.collection("faq").add({ ...faq, createdAt: new Date() });
  }

  return async () => {
    await socketServer.stop();
    await pglite.close();
  };
}
