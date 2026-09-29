// Shared E2E fixtures: the seeded baseline plus the `test` export every
// spec must use.
//
// Lifecycle context (see issue #229): Playwright's runner starts
// config.webServer — a plugin task — BEFORE globalSetup, so the PGlite
// engine, migrations, wire-protocol socket, and reset control endpoint
// live in the webServer process (tests/e2e/db-server.ts). Postgres
// resets are POSTed to that endpoint and applied engine-direct — a
// second wire-protocol client could interleave with the app's in-flight
// queries and corrupt them (SQLSTATE 26000; see seed.ts).
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_CLAIM_EMAIL,
  E2E_CLAIM_PASSWORD,
  E2E_FIREBASE_PROJECT_ID,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
  E2E_QUERY_URL,
  E2E_RESET_URL,
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

  // Postgres reset runs in the webServer process, directly on the
  // PGlite engine — NOT over the wire socket. A second client
  // connection's extended-protocol sequences can interleave with the
  // app's in-flight queries on the shared backend session (SQLSTATE
  // 26000 "unnamed prepared statement does not exist", observed under
  // load); the control endpoint makes resets atomic w.r.t. app traffic.
  const res = await fetch(E2E_RESET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerUid }),
  });
  if (!res.ok) {
    throw new Error(`E2E registry reset failed: ${res.status} ${await res.text()}`);
  }

  const firestore = getFirestore(adminApp());
  await Promise.all(
    (await firestore.listCollections()).map((collection) =>
      firestore.recursiveDelete(collection),
    ),
  );
  await seedE2EContent(firestore);
}

// Direct registry access for specs that need to seed or assert rows
// mid-test. Routed through the db-server control endpoint — executed on
// the PGlite engine itself — so test code never holds a second
// wire-protocol connection whose messages could interleave with the
// app's in-flight queries (SQLSTATE 26000; see seed.ts).
export async function dbQuery<T>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await fetch(E2E_QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, params }),
  });
  if (!res.ok) {
    throw new Error(`E2E db query failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T[];
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
