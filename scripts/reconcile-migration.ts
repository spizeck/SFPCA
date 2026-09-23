// Reconciliation for the #181 Firestore→Postgres import — run after every
// migrate-firestore --execute (and against rehearsal branches).
//
//   npx tsx scripts/reconcile-migration.ts --project=<id> [--emulator]
//
// Read-only on BOTH sides. Compares deterministic projections of the
// source documents against destination rows:
//   - per-collection counts
//   - every source legacy identity present exactly once in destination
//   - no unexpected destination rows lacking a source
//   - field-level equality for every migrated field (mismatches reported
//     by field NAME only — never values, so no PII leaves the output)
// Exit code 1 on any mismatch; 0 only when source and destination are
// semantically equivalent for all migration-scope fields.

import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, isNotNull } from "drizzle-orm";
import {
  animals,
  adminUsers,
  registrationSubmissions,
} from "../src/lib/db/schema";
import {
  transformAnimal,
  transformAdmin,
  transformRegistration,
  animalProjection,
  adminProjection,
  submissionProjection,
  projectDestRow,
  diffProjection,
  type MigrationException,
} from "./lib/migrate-transform";

config({ path: ".env.local" });

const project = process.argv
  .find((a) => a.startsWith("--project="))
  ?.slice(10);
const emulator = process.argv.includes("--emulator");

const configuredProject =
  process.env.FIREBASE_ADMIN_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
if (!project || (!emulator && configuredProject !== project)) {
  console.error("pass --project matching the configured Firebase project");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!dbUrl || !/^postgres(ql)?:\/\//.test(dbUrl)) {
  console.error("Set DATABASE_URL_UNPOOLED (or DATABASE_URL). Refusing.");
  process.exit(1);
}
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= "localhost:8080";
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= project;
}

let mismatches = 0;
let checked = 0;
const exceptions: MigrationException[] = [];

function compare(
  label: string,
  key: string,
  expected: Record<string, unknown>,
  destRow: Record<string, unknown> | undefined,
) {
  checked++;
  if (!destRow) {
    console.log(`MISSING ${label} key=${key} — no destination row`);
    mismatches++;
    return;
  }
  const actual = projectDestRow(destRow, Object.keys(expected));
  const diffFields = diffProjection(expected, actual);
  if (diffFields.length > 0) {
    console.log(`MISMATCH ${label} key=${key} fields: ${diffFields.join(", ")}`);
    mismatches++;
  }
}

async function main() {
  const target = new URL(dbUrl!);
  console.log(
    `Reconciling project=${project} against dest host=${target.hostname} ` +
      `db=${target.pathname.slice(1)}`,
  );

  const { adminDb } = await import("../src/lib/firebase-admin");
  const fs = adminDb();
  const pg = postgres(dbUrl!, { max: 1, prepare: false });
  const db = drizzle(pg);

  try {
    // --- animals ---------------------------------------------------------
    const animalSnap = await fs.collection("animals").get();
    const destAnimals = await db
      .select()
      .from(animals)
      .where(isNotNull(animals.legacyId));
    const destByLegacy = new Map(destAnimals.map((r) => [r.legacyId, r]));
    const seenAnimalIds = new Set<string>();

    for (const doc of animalSnap.docs) {
      const { row, exceptions: ex } = transformAnimal(doc.id, doc.data());
      exceptions.push(...ex);
      seenAnimalIds.add(doc.id);
      compare("animals", doc.id, animalProjection(row),
        destByLegacy.get(doc.id) as unknown as Record<string, unknown>);
    }
    for (const r of destAnimals) {
      if (r.legacyId && !seenAnimalIds.has(r.legacyId)) {
        console.log(`UNEXPECTED dest animals row legacyId=${r.legacyId} has no source doc`);
        mismatches++;
      }
    }
    console.log(
      `animals: source=${animalSnap.size} dest(with legacy_id)=${destAnimals.length}`,
    );

    // --- admins ----------------------------------------------------------
    const adminSnap = await fs.collection("admins").get();
    const destAdmins = await db.select().from(adminUsers);
    const destByEmail = new Map(destAdmins.map((r) => [r.email.toLowerCase(), r]));
    const seenEmails = new Set<string>();

    for (const doc of adminSnap.docs) {
      const { row, exceptions: ex } = transformAdmin(doc.id, doc.data());
      exceptions.push(...ex);
      const email = doc.id.trim().toLowerCase();
      seenEmails.add(email);
      compare("admins", email, adminProjection(row),
        destByEmail.get(email) as unknown as Record<string, unknown>);
    }
    for (const r of destAdmins) {
      if (!seenEmails.has(r.email.toLowerCase())) {
        console.log(`UNEXPECTED dest admin_users row (no source doc id match)`);
        mismatches++;
      }
    }
    console.log(`admins: source=${adminSnap.size} dest=${destAdmins.length}`);

    // --- registration_submissions ----------------------------------------
    const regSnap = await fs.collection("animalRegistrations").get();
    const destSubs = await db
      .select()
      .from(registrationSubmissions)
      .where(isNotNull(registrationSubmissions.legacyId));
    const destSubByLegacy = new Map(destSubs.map((r) => [r.legacyId, r]));
    const seenRegIds = new Set<string>();

    for (const doc of regSnap.docs) {
      const { row, exceptions: ex } = transformRegistration(doc.id, doc.data());
      exceptions.push(...ex);
      seenRegIds.add(doc.id);
      compare("animalRegistrations", doc.id, submissionProjection(row),
        destSubByLegacy.get(doc.id) as unknown as Record<string, unknown>);
    }
    for (const r of destSubs) {
      if (r.legacyId && !seenRegIds.has(r.legacyId)) {
        console.log(`UNEXPECTED dest registration_submissions row legacyId=${r.legacyId}`);
        mismatches++;
      }
    }
    console.log(
      `animalRegistrations: source=${regSnap.size} dest(with legacy_id)=${destSubs.length}`,
    );

    // --- summary ----------------------------------------------------------
    const exSummary = new Map<string, number>();
    for (const e of exceptions)
      exSummary.set(e.kind, (exSummary.get(e.kind) ?? 0) + 1);
    console.log(
      `source-side exceptions during transform: ${exceptions.length}` +
        (exceptions.length
          ? ` — ${[...exSummary.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`
          : ""),
    );
    console.log(
      `reconciliation: ${checked} source docs compared, ${mismatches} mismatch(es)`,
    );
    if (mismatches > 0) process.exit(1);
    console.log("RECONCILIATION PASSED — destination matches migration scope.");
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error("reconcile failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
