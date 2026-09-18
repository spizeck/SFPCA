// E2E fixture setup, run by Playwright inside `firebase emulators:exec`.
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are already in the
// environment, so firebase-admin targets the emulators with no
// credentials. Everything here is idempotent so repeated runs are clean.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const E2E_ADMIN_EMAIL = "e2e-admin@example.com";
export const E2E_ADMIN_PASSWORD = "e2e-test-only-password";

const app = initializeApp({ projectId: "demo-sfpca" });
const auth = getAuth(app);
const db = getFirestore(app);

export default async function globalSetup() {
  // Synthetic admin user in the Auth emulator. emailVerified is required:
  // the app's session endpoint (and Firestore/Storage rules) reject
  // unverified identities, matching the production boundary.
  try {
    await auth.createUser({
      email: E2E_ADMIN_EMAIL,
      password: E2E_ADMIN_PASSWORD,
      emailVerified: true,
    });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code !== "auth/email-already-exists") throw error;
    await auth.updateUser((await auth.getUserByEmail(E2E_ADMIN_EMAIL)).uid, {
      password: E2E_ADMIN_PASSWORD,
      emailVerified: true,
    });
  }

  // Authorization state in the Firestore emulator: the admins document
  // the app's isAdmin() and the security rules both consult.
  await db.collection("admins").doc(E2E_ADMIN_EMAIL).set({
    email: E2E_ADMIN_EMAIL,
    role: "admin",
    createdAt: new Date(),
  });

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

  // Adoptable animals so the adoptions page and homepage cards render.
  for (const animal of seed.animals ?? []) {
    const { id, ...data } = animal;
    const ref = id
      ? db.collection("animals").doc(id)
      : db.collection("animals").doc();
    await ref.set(data);
  }

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
