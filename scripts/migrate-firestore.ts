// Phase C/D tooling: import existing operational Firestore data into
// Postgres (#165). Imports ONLY the operational collections:
//
//   animals              -> animals        (legacy_id = Firestore doc id)
//   admins               -> admin_users    (email = Firestore doc id)
//   animalRegistrations  -> registration_submissions (legacy_id = doc id;
//                          owner contact preserved as a snapshot — linking
//                          owners to persons is a later dedupe step, #178)
//
// CMS content collections are intentionally NOT imported — they stay in
// Firestore (docs/architecture/persistence.md).
//
// Usage:
//   npx tsx scripts/migrate-firestore.ts --project=<firebase-project> [--emulator] [--execute]
//
// Defaults to a dry run: reads the source, reports counts, writes nothing.
// Safety:
// - --project is REQUIRED and must match the configured Firebase project;
//   a mismatch aborts before any reads or writes
// - production writes additionally require
//     MIGRATION_CONFIRM_PROJECT=<same project id>
//   so a stray --execute cannot bulk-write production by accident
// - re-runnable: upserts keyed on legacy_id / normalized email
// - logs counts only — never owner PII or receipt contents
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

// Credentials (FIREBASE_ADMIN_*, DATABASE_URL_UNPOOLED) live in
// .env.local — gitignored — so they never appear in command lines.
config({ path: ".env.local" });

const KNOWN_STATUSES = new Set(["available", "pending", "adopted"]);

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
  if (!dbUrl || !/^postgres(ql)?:\/\//.test(dbUrl)) {
    console.error(
      "Set DATABASE_URL_UNPOOLED (or DATABASE_URL for local dev) to a Postgres " +
        "connection string. Refusing to run.",
    );
    process.exit(1);
  }

  if (args.emulator) {
    process.env.FIRESTORE_EMULATOR_HOST ??= "localhost:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "localhost:9099";
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= args.project;
  }

  const mode = args.execute ? "EXECUTE" : "DRY RUN";
  console.log(`Firestore -> Postgres migration [${mode}] project=${args.project}`);

  const { adminDb } = await import("../src/lib/firebase-admin");
  const fs = adminDb();
  const pg = postgres(dbUrl, { max: 1, prepare: false });
  const db = drizzle(pg);

  try {
    // --- animals -------------------------------------------------------
    const animalSnap = await fs.collection("animals").get();
    const animalRows = animalSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        legacyId: doc.id,
        name: typeof d.name === "string" && d.name ? d.name : "(unnamed)",
        species: ["dog", "cat", "other"].includes(d.species) ? d.species : "other",
        sex: ["male", "female", "unknown"].includes(d.sex) ? d.sex : "unknown",
        approxAge: typeof d.approxAge === "string" ? d.approxAge : null,
        description: typeof d.description === "string" ? d.description : null,
        // Fail closed on the lifecycle boundary: unrecognized statuses
        // import as private "pending", never as public "available".
        lifecycleStatus: KNOWN_STATUSES.has(d.status) ? d.status : "pending",
        photoUrls: Array.isArray(d.photos)
          ? d.photos.filter((p: unknown) => typeof p === "string")
          : [],
      };
    });
    console.log(`animals: ${animalRows.length} source docs`);
    if (args.execute && animalRows.length > 0) {
      await db
        .insert(animals)
        .values(animalRows)
        .onConflictDoUpdate({
          target: animals.legacyId,
          set: {
            name: dsql`excluded.name`,
            species: dsql`excluded.species`,
            sex: dsql`excluded.sex`,
            approxAge: dsql`excluded.approx_age`,
            description: dsql`excluded.description`,
            lifecycleStatus: dsql`excluded.lifecycle_status`,
            photoUrls: dsql`excluded.photo_urls`,
            updatedAt: dsql`now()`,
          },
        });
      console.log(`animals: upserted ${animalRows.length}`);
    }

    // --- admins --------------------------------------------------------
    const adminSnap = await fs.collection("admins").get();
    const adminRows = adminSnap.docs.map((doc) => {
      const role = doc.data()?.role;
      return {
        email: doc.id.trim().toLowerCase(),
        role: role === "admin" ? "admin" : "editor",
      };
    });
    console.log(`admins: ${adminRows.length} source docs`);
    if (args.execute) {
      for (const row of adminRows) {
        // Idempotent on normalized email (unique lower(email) index).
        await db.execute(dsql`
          INSERT INTO admin_users (email, role)
          VALUES (${row.email}, ${row.role})
          ON CONFLICT (lower(email)) DO UPDATE SET role = excluded.role
        `);
      }
      console.log(`admins: upserted ${adminRows.length}`);
    }

    // --- animalRegistrations -------------------------------------------
    const regSnap = await fs.collection("animalRegistrations").get();
    const regRows = regSnap.docs.map((doc) => {
      const d = doc.data();
      const fee = typeof d.totalFee === "number" ? d.totalFee : 0;
      return {
        legacyId: doc.id,
        ownerName: typeof d.ownerInfo?.name === "string" ? d.ownerInfo.name : "(unknown)",
        ownerAddress: typeof d.ownerInfo?.address === "string" ? d.ownerInfo.address : null,
        ownerPhone: typeof d.ownerInfo?.phone === "string" ? d.ownerInfo.phone : null,
        ownerEmail: typeof d.ownerInfo?.email === "string" ? d.ownerInfo.email : null,
        paymentReceiptPath:
          typeof d.paymentReceipt === "string" ? d.paymentReceipt : null,
        totalFeeCents: Math.round(fee * 100),
        currency: "USD",
        status: ["pending", "approved", "rejected"].includes(d.status)
          ? d.status
          : "pending",
        submittedAt: d.createdAt?.toDate?.() ?? new Date(),
        createdAt: d.createdAt?.toDate?.() ?? new Date(),
        updatedAt: d.updatedAt?.toDate?.() ?? new Date(),
      };
    });
    console.log(`animalRegistrations: ${regRows.length} source docs`);
    if (args.execute && regRows.length > 0) {
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
            updatedAt: dsql`now()`,
          },
        });
      console.log(`animalRegistrations: upserted ${regRows.length}`);
    }

    console.log(`[${mode}] complete.`);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
