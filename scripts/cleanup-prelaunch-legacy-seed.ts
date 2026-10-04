// One-time pre-launch legacy-seed cleanup CLI (#278).
//
//   npx tsx scripts/cleanup-prelaunch-legacy-seed.ts audit
//   npx tsx scripts/cleanup-prelaunch-legacy-seed.ts apply \
//     --production --confirm "REMOVE PRELAUNCH LEGACY SEED"
//
// Local sandbox variants (emulator + local Postgres) use --local and
// the "REMOVE LOCAL LEGACY SEED" phrase.
//
// What this does:
//   - audit (default, read-only): proves target identity, inventories
//     Postgres / Firestore / Firebase Auth / Storage, classifies every
//     record as REMOVE / PRESERVE / UNEXPECTED, and prints a verdict.
//   - apply: re-runs the same audit; on verdict=safe ONLY, deletes the
//     exact expected legacy fixture rows (3 Postgres animals + 3
//     Firestore animal docs) and nothing else. Any unexpected record
//     anywhere refuses the whole operation.
//
// What this deliberately does NOT do:
//   - it never touches lifecycle. The 'live' → 'prelaunch-demo'
//     correction is drizzle migration 0024 — run `npm run db:migrate`
//     AFTER this script reports a clean removal. Keeping the lifecycle
//     flip in a journaled migration means this script can never become
//     a generic "reopen demo mode" path.
//   - it never touches bootstrap config: admin_users/admins, operator
//     persons + auth identities + audit rows, CMS collections
//     (homepage/siteSettings/faq), every Firebase Auth user in the
//     bootstrap admin set, and intentional Storage assets
//     (team-photos/, db-backups/) are all preserved.
//
// Secrets are never printed — reports show counts and non-PII ids only.

import { config } from "dotenv";
import {
  resolveDemoTarget,
  type DemoTarget,
} from "./lib/demo-target";
import {
  auditLegacyEnvironment,
  deleteLegacyPostgresAnimals,
  deleteLegacyFirestoreAnimals,
  readLifecycleRow,
  type LegacyAudit,
  type LegacyDeps,
} from "./lib/prelaunch-legacy";
import { DemoRefusal } from "./lib/demo-db";
import { listBranches, neonApi, neonProjectId } from "./lib/neon";
import { getAdminApp } from "../src/lib/firebase-admin-app";

config({ path: ".env.local" });

const CONFIRMATIONS: Record<string, string> = {
  production: "REMOVE PRELAUNCH LEGACY SEED",
  local: "REMOVE LOCAL LEGACY SEED",
};

function fail(message: string): never {
  console.error(`refused: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = new Set(argv.filter((a) => a.startsWith("--")));
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    production: args.has("--production"),
    local: args.has("--local"),
    confirm: get("confirm"),
    snapshot: !args.has("--no-snapshot"),
  };
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// --- Real-store wiring ---------------------------------------------------------

function adminEmailsFromEnv(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function buildDeps(t: DemoTarget): Promise<LegacyDeps> {
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const app = getAdminApp();
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const bucket = getStorage(app).bucket(t.bucketName);

  return {
    db: t.db,
    auth: {
      listUsers: async () => {
        const users: { uid: string; email: string | null }[] = [];
        let pageToken: string | undefined;
        do {
          const page = await auth.listUsers(1000, pageToken);
          users.push(
            ...page.users.map((u) => ({ uid: u.uid, email: u.email ?? null })),
          );
          pageToken = page.pageToken;
        } while (pageToken);
        return users;
      },
      deleteUser: (uid) => auth.deleteUser(uid),
    },
    firestore: {
      listCollections: async () =>
        (await fs.listCollections()).map((c) => c.id),
      listDocIds: async (collection) =>
        (await fs.collection(collection).get()).docs.map((d) => d.id),
      deleteDoc: async (collection, id) => {
        await fs.collection(collection).doc(id).delete();
      },
    },
    storage: {
      listObjectNames: async () =>
        (await bucket.getFiles())[0].map((f) => f.name),
    },
    adminEmails: adminEmailsFromEnv(),
  };
}

// --- Reporting -----------------------------------------------------------------

function printAudit(a: LegacyAudit) {
  section("lifecycle");
  console.log(
    `lifecycle=${a.lifecycle.state}  live_at=${a.lifecycle.liveAt ?? "-"}`,
  );
  console.log(
    a.lifecycle.windowOpen
      ? a.lifecycle.state === "live"
        ? "remediation window: OPEN — 'live' was migration-initialized, not a real go-live"
        : "remediation window: OPEN — migration 0024 already applied (cleanup still permitted)"
      : "remediation window: CLOSED — this is not the audited pre-launch state",
  );

  section("postgres");
  console.log(
    `  remove: animals ${a.remove.postgresAnimals.length} row(s) ` +
      `(legacy fixture ids ${a.remove.postgresAnimals.join(", ") || "—"})`,
  );
  for (const [table, n] of Object.entries(a.preserve.postgresWindowRows)) {
    console.log(`  preserve: ${table} ${n} row(s) (bootstrap/identity)`);
  }
  console.log("  preserve: every other domain table is empty");

  section("firestore");
  console.log(
    `  remove: animals ${a.remove.firestoreAnimals.length} doc(s) ` +
      `(legacy fixture ids ${a.remove.firestoreAnimals.join(", ") || "—"})`,
  );
  for (const [name, n] of Object.entries(a.preserve.firestoreDocs)) {
    console.log(`  preserve: ${name} ${n} doc(s) (intentional content)`);
  }

  section("firebase auth");
  console.log(`  preserve: ${a.preserve.authUsers} user(s) (bootstrap admin/identity set)`);

  section("storage");
  for (const [prefix, n] of Object.entries(a.preserve.storageObjects)) {
    console.log(`  preserve: ${prefix} ${n} object(s) (intentional assets)`);
  }
  if (Object.keys(a.preserve.storageObjects).length === 0) {
    console.log("  preserve: (no objects found)");
  }

  section("violations");
  if (a.violations.length === 0) {
    console.log("  none — environment matches the audited pre-launch fixture");
  } else {
    for (const v of a.violations) console.log(`  ✗ ${v}`);
  }

  section("verdict");
  console.log(
    a.verdict === "safe"
      ? "SAFE TO PROCEED — only the known legacy fixture rows would be removed"
      : "NOT SAFE — unexpected records exist; apply will refuse",
  );
}

// --- Commands ------------------------------------------------------------------

async function cmdAudit(t: DemoTarget) {
  const a = await auditLegacyEnvironment(await buildDeps(t));
  printAudit(a);
  if (a.verdict !== "safe") process.exitCode = 2;
}

async function cmdApply(t: DemoTarget, confirm?: string, snapshot = true) {
  const wanted = CONFIRMATIONS[t.mode];
  if (confirm !== wanted) {
    fail(`apply requires --confirm "${wanted}"`);
  }

  const deps = await buildDeps(t);
  const audit = await auditLegacyEnvironment(deps);
  printAudit(audit);
  if (audit.verdict !== "safe") {
    fail("audit reported unexpected records — nothing was changed.");
  }
  if (!audit.lifecycle.windowOpen) {
    fail("the remediation window is closed — nothing was changed.");
  }

  // Best-effort Neon snapshot before the only destructive step — same
  // insurance pattern as the demo seed.
  if (snapshot && t.mode === "production" && process.env.NEON_API_KEY) {
    try {
      const project = neonProjectId();
      const branches = await listBranches(process.env.NEON_API_KEY, project);
      const primary = branches.find((b) => b.primary);
      if (primary) {
        await neonApi(
          process.env.NEON_API_KEY,
          project,
          `/branches/${primary.id}/snapshot`,
          {
            method: "POST",
            body: JSON.stringify({
              snapshot: {
                name: `pre-legacy-cleanup-${new Date().toISOString().slice(0, 16)}`,
              },
            }),
          },
        );
        console.log("pre-cleanup Neon snapshot created");
      }
    } catch (error) {
      console.warn(
        `warning: pre-cleanup snapshot failed (${error instanceof Error ? error.message : error}) — continuing (data verified disposable)`,
      );
    }
  }

  // Postgres in one transaction — the registry authority first.
  section("postgres cleanup");
  const pgDeleted = await t.db.transaction(async (tx) =>
    deleteLegacyPostgresAnimals(tx, audit.remove.postgresAnimals),
  );
  console.log(`  deleted animals rows: ${pgDeleted}`);

  // Firestore — idempotent doc deletes by exact id.
  section("firestore cleanup");
  const fsDeleted = await deleteLegacyFirestoreAnimals(
    deps.firestore,
    audit.remove.firestoreAnimals,
  );
  console.log(`  deleted animals docs: ${fsDeleted}`);

  section("post-state");
  const lifecycle = await readLifecycleRow(t.db);
  console.log(
    `lifecycle=${lifecycle?.lifecycle ?? "absent → live"} ` +
      `(migration 0024 ${lifecycle?.lifecycle === "prelaunch-demo" ? "already applied" : "still pending"})`,
  );
  console.log(
    "\ncleanup complete. Next steps:\n" +
      "  1. npm run db:migrate            # applies 0024 — the one-time live→prelaunch-demo correction\n" +
      "  2. npm run production-demo:check # must print 'seeding is permitted'\n" +
      "  3. npm run production-demo -- seed --production --confirm \"SEED PRODUCTION DEMO\"",
  );
}

// --- Entrypoint ------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (command ?? "audit") {
    case "audit": {
      // Read-only — default to production identity rules unless --local.
      const t = await resolveDemoTarget({
        production: opts.production || !opts.local,
        local: opts.local,
      });
      try {
        await cmdAudit(t);
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "apply": {
      const t = await resolveDemoTarget(opts);
      try {
        await cmdApply(t, opts.confirm, opts.snapshot);
      } finally {
        await t.sql.end();
      }
      break;
    }
    default:
      console.error(
        "usage: cleanup-prelaunch-legacy-seed.ts <audit|apply> " +
          '[--production|--local] [--confirm "PHRASE"] [--no-snapshot]',
      );
      process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof DemoRefusal) {
    console.error(`refused: ${error.message}`);
  } else {
    console.error(
      "failed:",
      error instanceof Error ? error.message : error,
    );
  }
  process.exit(1);
});
