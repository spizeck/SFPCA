// Isolated Postgres restore + verification for the SFPCA registry
// (#180). The restore path deliberately CANNOT touch production:
// it always creates a NEW Neon branch (copy-on-write child of the
// primary) plus a NEW empty database on it, restores the dump into
// that database, validates, and deletes the branch — production
// `neondb` is never a target.
//
//   npx tsx scripts/db-restore.ts --dump db-backups/registry-….dump
//   npx tsx scripts/db-restore.ts --dump ./local.dump --branch restore-drill-1
//   npx tsx scripts/db-restore.ts --dump … --keep    # leave branch for inspection
//
// Steps:
//   1. Fetch the dump — a db-backups/ Storage object (default) or a
//      local file path.
//   2. Neon API: create restore branch + empty `restore_check` database.
//   3. pg_restore (--no-owner --no-privileges) into the empty database.
//   4. Validate: every schema.ts table exists with row counts, the
//      __drizzle_migrations journal matches the checked-in drizzle/
//      files, and a handful of referential spot-checks pass.
//   5. Delete the branch unless --keep.
//
// To actually RECOVER production: verify with this script first, then
// follow RUNBOOK §19g — the decision to repoint/replace production is
// always a human step, not a flag on this script.

import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/lib/db/schema";
import { urlHost } from "./lib/db-backup-lib";

config({ path: ".env.local" });

const API = "https://console.neon.tech/api/v2";
const PROJECT = "withered-sound-26167673"; // sfpca-db — audited in #180
const RESTORE_DB = "restore_check";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dumpArg = arg("--dump");
const branchName = arg("--branch") ?? `restore-verify-${Date.now()}`;
const keep = process.argv.includes("--keep");

if (!dumpArg) {
  console.error(
    "usage: npx tsx scripts/db-restore.ts --dump <storage-object|local-file> [--branch <name>] [--keep]",
  );
  process.exit(1);
}

const KEY = process.env.NEON_API_KEY;
if (!KEY) {
  console.error(
    "db-restore: NEON_API_KEY is not set in .env.local — the Neon API " +
      "is how an isolated restore target is provisioned.",
  );
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${KEY}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function api(pathname: string, init?: RequestInit) {
  const r = await fetch(`${API}/projects/${PROJECT}${pathname}`, {
    ...init,
    headers: H,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `Neon API ${init?.method ?? "GET"} ${pathname} → ${r.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

// Neon provisions asynchronously — a fresh branch 423s on follow-up
// calls until its create operations finish. Poll until settled.
async function waitForOperations(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ops = (await api("/operations")).operations ?? [];
    const running = ops.filter(
      (o: { status?: string }) =>
        o.status === "running" || o.status === "scheduling",
    );
    if (running.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for Neon operations to settle");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Neon occasionally rejects a call while an unrelated operation is
// still settling — retry 423s briefly rather than failing the drill.
async function apiRetry(pathname: string, init?: RequestInit, attempts = 15) {
  for (let i = 0; ; i++) {
    try {
      return await api(pathname, init);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("→ 423") || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function fetchDump(): Promise<string> {
  if (fs.existsSync(dumpArg!)) return dumpArg!;
  const { adminBucket } = await import("../src/lib/firebase-admin-storage");
  const dest = path.join(os.tmpdir(), path.basename(dumpArg!));
  console.log(`db-restore: downloading ${dumpArg} from Storage…`);
  await adminBucket().file(dumpArg!).download({ destination: dest });
  return dest;
}

// Expected tables = whatever schema.ts currently exports — the verify
// cannot drift from the application schema because it IS the schema.
function expectedTables(): string[] {
  return Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t as PgTable))
    .sort();
}

async function validate(url: string) {
  const sql = postgres(url, { max: 1, prepare: false });
  const problems: string[] = [];
  try {
    // 1. Migration journal completeness — a dump missing the journal,
    //    or a journal behind the checked-in files, means the restore is
    //    not schema-current.
    const journal = await sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    const files = fs
      .readdirSync("drizzle")
      .filter((f) => f.endsWith(".sql")).length;
    if (journal[0].n !== files) {
      problems.push(
        `migration journal has ${journal[0].n} entries but drizzle/ has ${files} files`,
      );
    }

    // 2. Every domain table exists; report row counts.
    const counts: Record<string, number> = {};
    for (const table of expectedTables()) {
      const rows = await sql`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${table}`;
      if (rows[0].n === 0) {
        problems.push(`missing table: ${table}`);
        continue;
      }
      const c = await sql`SELECT count(*)::int AS n FROM ${sql(table)}`;
      counts[table] = c[0].n;
    }
    console.log("db-restore: table row counts:");
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);

    // 3. Referential spot-checks. FKs make these impossible in a healthy
    //    restore — a non-zero result means the dump is corrupt or was
    //    partially restored.
    const orphans = await sql`
      SELECT
        (SELECT count(*) FROM registrations r
          LEFT JOIN animals a ON a.id = r.animal_id WHERE a.id IS NULL)
        +
        (SELECT count(*) FROM payments p
          LEFT JOIN registrations r ON r.id = p.registration_id
          WHERE r.id IS NULL)
        +
        (SELECT count(*) FROM ownerships o
          LEFT JOIN animals a ON a.id = o.animal_id WHERE a.id IS NULL)
        AS n`;
    if (orphans[0].n > 0) {
      problems.push(`${orphans[0].n} orphaned rows across registrations/payments/ownerships`);
    }
  } finally {
    await sql.end();
  }
  if (problems.length > 0) {
    throw new Error(`restore validation FAILED: ${problems.join("; ")}`);
  }
  console.log("db-restore: validation PASSED — schema current, all tables present, no orphans.");
}

async function main() {
  const dumpFile = await fetchDump();

  console.log(`db-restore: creating isolated branch ${branchName}…`);
  const branches = (await api("/branches")).branches ?? [];
  const primary = branches.find((b: { primary?: boolean }) => b.primary);
  if (!primary) throw new Error("no primary branch found");
  if (branchName === primary.name || branchName === primary.id) {
    throw new Error("refusing to restore onto the primary branch name");
  }
  const created = await api("/branches", {
    method: "POST",
    body: JSON.stringify({
      branch: { parent_id: primary.id, name: branchName },
      endpoints: [{ type: "read_write" }],
    }),
  });
  const branchId: string = created.branch.id;
  console.log(`db-restore: branch ${branchId} created off ${primary.name}`);

  try {
    await waitForOperations();
    await apiRetry(`/branches/${branchId}/databases`, {
      method: "POST",
      body: JSON.stringify({
        database: { name: RESTORE_DB, owner_name: "neondb_owner" },
      }),
    });
    await waitForOperations();
    const eps = (await api("/endpoints")).endpoints ?? [];
    const ep = eps.find(
      (e: { branch_id: string; type: string }) =>
        e.branch_id === branchId && e.type === "read_write",
    );
    if (!ep) throw new Error("no read_write endpoint on restore branch");
    const role = await apiRetry(
      `/branches/${branchId}/roles/neondb_owner/reveal_password`,
    );
    const url = `postgresql://neondb_owner:${role.password}@${ep.host}/${RESTORE_DB}?sslmode=require`;

    console.log(`db-restore: restoring into ${urlHost(url)}/${RESTORE_DB}…`);
    const t0 = Date.now();
    execFileSync(
      "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--dbname",
        url,
        dumpFile,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    console.log(`db-restore: pg_restore finished in ${Date.now() - t0}ms`);

    await validate(url);
  } finally {
    if (keep) {
      console.log(`db-restore: --keep set — branch ${branchName} (${branchId}) retained for inspection.`);
    } else {
      await api(`/branches/${branchId}`, { method: "DELETE" });
      console.log(`db-restore: branch ${branchName} deleted.`);
    }
  }
}

main().catch((error) => {
  console.error(
    "db-restore: FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
