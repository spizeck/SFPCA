// Scheduled Postgres backup for the SFPCA registry (#180).
//
//   npx tsx scripts/db-backup.ts            # dump → upload → prune
//   npx tsx scripts/db-backup.ts --local    # keep the local .dump file
//
// What it does:
//   1. pg_dump (custom format -Fc, compressed; --no-owner --no-privileges
//      so restores are not tied to Neon-specific roles/ACLs) of the
//      database named by BACKUP_DATABASE_URL / DATABASE_URL_UNPOOLED /
//      DATABASE_URL (first set wins).
//   2. Uploads to Firebase Storage under db-backups/ via the Admin SDK.
//      The prefix is deny-all for every client principal; only the
//      service account can read/write it. Dumps are NEVER committed to
//      git and never stored in Neon (a backup that dies with the
//      database it protects is not a backup).
//   3. Prunes db-backups/ to the newest BACKUP_RETENTION_COUNT objects
//      — but only after this run's upload verified, so a failed run
//      can never delete the last good recovery point.
//
// Failure posture: non-zero exit on any dump/upload/prune failure so the
// calling GitHub Actions run goes red (owner is notified by Actions
// failure mail). Secrets are passed via env/args and never printed —
// logs show hostnames and object names only.
//
// Restore path: scripts/db-restore.ts + RUNBOOK §19g.

import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupObjectName,
  pickBackupDatabaseUrl,
  staleBackupObjects,
  urlHost,
  BACKUP_PREFIX,
} from "./lib/db-backup-lib";

config({ path: ".env.local" });

const keepLocal = process.argv.includes("--local");

function dumpToFile(url: string, dest: string) {
  // -Fc: custom format — compressed, selectively restorable, and
  // pg_restore can reorder/parallelize. Includes schema, data,
  // sequences, indexes, constraints, and the __drizzle_migrations
  // journal, so a restored DB knows exactly which migrations ran.
  execFileSync(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      dest,
      "--dbname",
      url,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

async function main() {
  const picked = pickBackupDatabaseUrl();
  if (!picked) {
    console.error(
      "db-backup: no database URL — set BACKUP_DATABASE_URL " +
        "(or DATABASE_URL_UNPOOLED / DATABASE_URL). Refusing to run.",
    );
    process.exit(1);
  }
  if (picked.url.includes("-pooler") && picked.source !== "DATABASE_URL") {
    console.warn(
      `db-backup: ${picked.source} points at the pooled endpoint; ` +
        "prefer the unpooled endpoint for long dump transactions.",
    );
  }

  const objectName = backupObjectName();
  const tmp = path.join(os.tmpdir(), path.basename(objectName));

  console.log(`db-backup: dumping ${urlHost(picked.url)} (via ${picked.source})…`);
  const t0 = Date.now();
  dumpToFile(picked.url, tmp);
  const sizeMb = (fs.statSync(tmp).size / 1024 / 1024).toFixed(2);
  console.log(`db-backup: dump complete — ${sizeMb} MB in ${Date.now() - t0}ms`);

  // Lazy import so missing Firebase env fails with the Admin SDK's
  // explicit missing-var error rather than at module load.
  const { adminBucket } = await import("../src/lib/firebase-admin-storage");
  const bucket = adminBucket();

  const t1 = Date.now();
  await bucket.upload(tmp, { destination: objectName });
  // Verify the object actually landed before pruning anything.
  const [exists] = await bucket.file(objectName).exists();
  if (!exists) throw new Error(`upload reported success but ${objectName} is absent`);
  console.log(`db-backup: uploaded ${objectName} in ${Date.now() - t1}ms`);

  const [files] = await bucket.getFiles({ prefix: BACKUP_PREFIX });
  const stale = staleBackupObjects(files.map((f) => f.name));
  for (const name of stale) {
    await bucket.file(name).delete();
  }
  if (stale.length > 0) {
    console.log(`db-backup: pruned ${stale.length} expired backup(s)`);
  }

  if (!keepLocal) fs.unlinkSync(tmp);
  console.log("db-backup: done.");
}

main().catch((error) => {
  console.error(
    "db-backup: FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
