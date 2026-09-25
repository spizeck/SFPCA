// Phase C/D tooling: import existing operational Firestore data into
// Postgres (#165/#181). Imports ONLY the operational collections:
//
//   animals              -> animals        (legacy_id = Firestore doc id)
//   admins               -> admin_users    (email = Firestore doc id)
//   animalRegistrations  -> registration_submissions (legacy_id = doc id;
//                          owner contact preserved as a snapshot — linking
//                          owners to persons is a later dedupe step, #178)
//
// CMS content collections are intentionally NOT imported — they stay in
// Firestore (ARCHITECTURE.md §2).
//
// Usage:
//   npx tsx scripts/migrate-firestore.ts --project=<firebase-project> [--emulator] [--execute]
//
// Defaults to a dry run: reads the source, reports counts + exceptions,
// writes nothing. Pair every --execute with scripts/reconcile-migration.ts.
//
// Safety:
// - --project is REQUIRED and must match the configured Firebase project;
//   a mismatch aborts before any reads or writes
// - production writes additionally require
//     MIGRATION_CONFIRM_PROJECT=<same project id>
//   so a stray --execute cannot bulk-write production by accident
// - a manual Neon snapshot of `main` is a hard precondition for any
//   production --execute (RUNBOOK §19f) — enforced by process, and the
//   script prints the destination host/db/user so the operator can
//   confirm the target before it writes
// - re-runnable: upserts keyed on legacy_id / normalized email
// - all writes happen in a single transaction per collection batch
// - logs counts and classified exceptions only — never owner PII or
//   receipt contents
// - Postgres target comes from DATABASE_URL_UNPOOLED (or DATABASE_URL for
//   local/dev); the script refuses to run without one

import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import {
  animals,
  adminUsers,
  registrationSubmissions,
} from "../src/lib/db/schema";
import {
  transformAnimal,
  transformAdmin,
  transformRegistration,
  type MigrationException,
} from "./lib/migrate-transform";

// Credentials (FIREBASE_ADMIN_*, DATABASE_URL_UNPOOLED) live in
// .env.local — gitignored — so they never appear in command lines.
config({ path: ".env.local" });

interface Args {
  project?: string;
  emulator: boolean;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { emulator: false, execute: false };
  for (const arg of argv) {
    if (arg === "--emulator") args.emulator = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg.startsWith("--project=")) args.project = arg.slice(10);
  }
  return args;
}

function reportExceptions(exceptions: MigrationException[]) {
  if (exceptions.length === 0) {
    console.log("exceptions: none");
    return;
  }
  const byKind = new Map<string, number>();
  for (const e of exceptions)
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(
    `exceptions: ${exceptions.length} — ` +
      [...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(", "),
  );
  for (const e of exceptions) {
    // doc ids are Firestore auto-ids / animal ids — not PII. Values are
    // never printed; detail describes shape/type only.
    console.log(`  ${e.collection}/${e.docId} ${e.kind} field=${e.field} (${e.detail})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.project) {
    console.error("--project=<firebase-project-id> is required.");
    process.exit(1);
  }

  const configuredProject =
    process.env.FIREBASE_ADMIN_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!args.emulator && configuredProject && configuredProject !== args.project) {
    console.error(
      `--project (${args.project}) does not match the configured project ` +
        `(${configuredProject}). Refusing to run against an unexpected target.`,
    );
    process.exit(1);
  }
  if (args.execute && process.env.MIGRATION_CONFIRM_PROJECT !== args.project) {
    console.error(
      "Refusing to write. Set MIGRATION_CONFIRM_PROJECT to the same project " +
        "id to confirm this migration target.",
    );
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const dbUrlValid = !!dbUrl && /^postgres(ql)?:\/\//.test(dbUrl);
  if (args.execute && !dbUrlValid) {
    console.error(
      "Set DATABASE_URL_UNPOOLED (or DATABASE_URL for local dev) to a Postgres " +
        "connection string. Refusing to run.",
    );
    process.exit(1);
  }
  if (!dbUrlValid) {
    console.warn(
      "No Postgres URL configured — dry-run reports source inventory only.",
    );
  }

  if (args.emulator) {
    process.env.FIRESTORE_EMULATOR_HOST ??= "localhost:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "localhost:9099";
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= args.project;
  }

  const mode = args.execute ? "EXECUTE" : "DRY RUN";
  if (dbUrlValid) {
    const target = new URL(dbUrl!);
    console.log(
      `Firestore -> Postgres migration [${mode}] project=${args.project} ` +
        `dest host=${target.hostname} db=${target.pathname.slice(1)} user=${target.username}`,
    );
  } else {
    console.log(`Firestore -> Postgres migration [${mode}] project=${args.project} (no dest)`);
  }
  if (args.execute) {
    console.log(
      "REMINDER: production runs require a verified Neon snapshot of the " +
        "target branch first (RUNBOOK §19f).",
    );
  }

  const { adminDb } = await import("../src/lib/firebase-admin");
  const fs = adminDb();
  const pg = dbUrlValid ? postgres(dbUrl!, { max: 1, prepare: false }) : null;
  const db = pg ? drizzle(pg) : null;
  const exceptions: MigrationException[] = [];

  try {
    // --- transform (read-only on both sides) -----------------------------
    const animalSnap = await fs.collection("animals").get();
    const animalRows = animalSnap.docs.map((doc) => {
      const r = transformAnimal(doc.id, doc.data());
      exceptions.push(...r.exceptions);
      return r.row;
    });
    console.log(`animals: ${animalRows.length} source docs`);

    const adminSnap = await fs.collection("admins").get();
    const adminRows = adminSnap.docs.map((doc) => {
      const r = transformAdmin(doc.id, doc.data());
      exceptions.push(...r.exceptions);
      return r.row;
    });
    console.log(`admins: ${adminRows.length} source docs`);

    const regSnap = await fs.collection("animalRegistrations").get();
    const regRows = regSnap.docs.map((doc) => {
      const r = transformRegistration(doc.id, doc.data());
      exceptions.push(...r.exceptions);
      return r.row;
    });
    console.log(`animalRegistrations: ${regRows.length} source docs`);

    reportExceptions(exceptions);
    if (!args.execute) {
      // When a destination is configured, verify connectivity in dry-run
      // too — catches a wrong target before the operator reaches --execute.
      if (db) await db.execute(dsql`SELECT 1`);
      console.log(`[${mode}] complete — no writes performed.`);
      return;
    }

    // --- write: one transaction per collection ---------------------------
    if (!db) throw new Error("unreachable: --execute requires a valid DB URL");
    if (animalRows.length > 0) {
      await db
        .insert(animals)
        .values(animalRows)
        .onConflictDoUpdate({
          target: animals.legacyId,
          set: {
            name: dsql`excluded.name`,
            species: dsql`excluded.species`,
            sex: dsql`excluded.sex`,
            identifyingNotes: dsql`excluded.identifying_notes`,
            description: dsql`excluded.description`,
            lifecycleStatus: dsql`excluded.lifecycle_status`,
            adoptionStatus: dsql`excluded.adoption_status`,
            photoUrls: dsql`excluded.photo_urls`,
            // created_at intentionally absent from the update set — the
            // original import timestamp is the record's provenance.
            // updated_at mirrors the SOURCE value (not now()) so re-runs
            // converge to the same semantic state — reconciliation
            // compares it against the Firestore doc.
            updatedAt: dsql`excluded.updated_at`,
          },
        });
      console.log(`animals: upserted ${animalRows.length}`);
    }

    for (const row of adminRows) {
      // Idempotent on normalized email (unique lower(email) index).
      await db.execute(dsql`
        INSERT INTO admin_users (email, role)
        VALUES (${row.email}, ${row.role})
        ON CONFLICT (lower(email)) DO UPDATE SET role = excluded.role
      `);
    }
    if (adminRows.length > 0) console.log(`admins: upserted ${adminRows.length}`);

    if (regRows.length > 0) {
      await db
        .insert(registrationSubmissions)
        .values(regRows)
        .onConflictDoUpdate({
          target: registrationSubmissions.legacyId,
          set: {
            ownerName: dsql`excluded.owner_name`,
            ownerAddress: dsql`excluded.owner_address`,
            ownerPhone: dsql`excluded.owner_phone`,
            ownerEmail: dsql`excluded.owner_email`,
            paymentReceiptPath: dsql`excluded.payment_receipt_path`,
            totalFeeCents: dsql`excluded.total_fee_cents`,
            status: dsql`excluded.status`,
            submittedAt: dsql`excluded.submitted_at`,
            decidedAt: dsql`excluded.decided_at`,
            updatedAt: dsql`excluded.updated_at`,
          },
        });
      console.log(`animalRegistrations: upserted ${regRows.length}`);
    }

    console.log(`[${mode}] complete — now run scripts/reconcile-migration.ts.`);
  } finally {
    await pg?.end();
  }
}

main().catch((error) => {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
