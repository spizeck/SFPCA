// Pre-launch production demo lifecycle CLI (#275).
//
//   npx tsx scripts/production-demo.ts check
//   npx tsx scripts/production-demo.ts seed    --production --confirm "SEED PRODUCTION DEMO"
//   npx tsx scripts/production-demo.ts status
//   npx tsx scripts/production-demo.ts reset   --production --confirm "RESET PRODUCTION DEMO"
//   npx tsx scripts/production-demo.ts verify
//   npx tsx scripts/production-demo.ts go-live --production --confirm "GO LIVE"
//
// Local (emulator/PGlite) variants take --local instead of --production
// and never touch production credentials:
//   npx tsx scripts/production-demo.ts seed --local --confirm "SEED LOCAL DEMO"
//
// Safety model (see scripts/lib/demo-db.ts for the table classification):
//   - seed/reset refuse unless the app_state lifecycle row reads
//     'prelaunch-demo' — a database trigger makes 'live' terminal, so
//     this tooling can never run against a live registry;
//   - production mode verifies BOTH the Firebase project id and the
//     Neon primary-branch endpoint before touching anything;
//   - check/status/verify are strictly read-only;
//   - seed requires an empty domain (reported per table, never PII);
//   - reset removes the whole demo footprint: seeded rows, demo-window
//     rows, demo Auth users, demo Firestore docs, demo Storage objects.
//
// Secrets are never printed — reports show names, counts, and ids only.

import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSeedRun,
  findNonEmptyDomainTables,
  latestSeedRun,
  listPublicTables,
  readLifecycleRow,
  requirePrelaunchLifecycle,
  resetPostgresDemoData,
  finalizePostgresReset,
  type PostgresResetReport,
  tableCounts,
  transitionToLive,
  verifyPostgresClean,
  windowTableCounts,
  DemoRefusal,
  EPHEMERAL_TABLES,
  TOOLING_TABLES,
} from "./lib/demo-db";
import {
  applyDemoPostgresSeed,
  DEMO_ADMIN_EMAIL,
  DEMO_OWNER_EMAIL,
  DEMO_SEED_VERSION,
  DEMO_USER_EMAIL,
  type DemoSeedManifestEntry,
} from "./lib/demo-seed";
import {
  listBranches,
  listEndpoints,
  neonApi,
  neonProjectId,
  NEON_API_BASE,
} from "./lib/neon";
import { getAdminApp } from "../src/lib/firebase-admin-app";

config({ path: ".env.local" });

// --- Identity ------------------------------------------------------------------

const EXPECTED_FIREBASE_PROJECT = "saba-sfpca";

// Collections the public site reads — the demo fills only missing/empty
// ones and records which were empty so reset can restore that state.
const CMS_COLLECTIONS = [
  "homepage",
  "siteSettings",
  "faq",
  "vetServices",
  "animalAdoptions",
  "animalRegistration",
] as const;

// Private app prefixes that can carry demo binaries.
const STORAGE_PREFIXES = ["receipts/", "vet-docs/", "team-photos/"] as const;

const CONFIRMATIONS: Record<string, { production: string; local: string }> = {
  seed: { production: "SEED PRODUCTION DEMO", local: "SEED LOCAL DEMO" },
  reset: { production: "RESET PRODUCTION DEMO", local: "RESET LOCAL DEMO" },
  "go-live": { production: "GO LIVE", local: "GO LIVE LOCAL" },
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

// --- Environment resolution -------------------------------------------------------

interface Target {
  mode: "production" | "local";
  sql: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
  projectId: string;
  bucketName: string;
}

async function resolveTarget(opts: {
  production: boolean;
  local: boolean;
}): Promise<Target> {
  if (opts.production === opts.local) {
    fail("pass exactly one of --production or --local");
  }

  const emulatorMode = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
  // The project the Admin SDK will actually attach to — under emulators
  // NEXT_PUBLIC_FIREBASE_PROJECT_ID takes precedence (getAdminApp).
  const projectId = emulatorMode
    ? (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
      process.env.FIREBASE_ADMIN_PROJECT_ID)
    : process.env.FIREBASE_ADMIN_PROJECT_ID;
  const bucket =
    process.env.FIREBASE_ADMIN_STORAGE_BUCKET ??
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

  if (opts.local) {
    // Local mode is the safe sandbox: it MUST run against the Firebase
    // emulators — a real project id here would make "local" commands
    // mutate production resources.
    if (!emulatorMode) {
      fail(
        "--local requires the Firebase emulators (FIRESTORE_EMULATOR_HOST/" +
          "FIREBASE_AUTH_EMULATOR_HOST). Start `firebase emulators` first, or export them.",
      );
    }
    if (!projectId || !projectId.startsWith("demo-")) {
      fail(
        "--local requires a demo-* Firebase project id (emulator convention), " +
          `got '${projectId ?? "unset"}' — refusing to touch what may be a real project.`,
      );
    }
  } else {
    if (emulatorMode) {
      fail(
        "emulator env vars are set — production mode refuses to run " +
          "against emulators (use --local for emulator targets).",
      );
    }
    if (projectId !== EXPECTED_FIREBASE_PROJECT) {
      fail(
        `FIREBASE_ADMIN_PROJECT_ID is '${projectId ?? "unset"}', expected ` +
          `'${EXPECTED_FIREBASE_PROJECT}' — identity could not be proven.`,
      );
    }
    if (!process.env.NEON_API_KEY) {
      fail(
        "NEON_API_KEY is required in production mode — it is how the " +
          "command proves DATABASE_URL points at the primary Neon branch.",
      );
    }
  }

  const url =
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    fail("DATABASE_URL (or _UNPOOLED) is not a Postgres connection string");
  }
  const host = new URL(url!).hostname;

  if (opts.production) {
    // Prove the Postgres target is the production primary branch by
    // matching its endpoint host against the Neon API.
    const project = neonProjectId();
    const key = process.env.NEON_API_KEY!;
    const [branches, endpoints] = await Promise.all([
      listBranches(key, project),
      listEndpoints(key, project),
    ]);
    const primary = branches.find((b) => b.primary);
    if (!primary) fail("could not resolve the primary Neon branch");
    const hosts = endpoints
      .filter((e) => e.branch_id === primary!.id)
      .map((e) => e.host);
    if (!hosts.includes(host)) {
      fail(
        `DATABASE_URL host '${host}' is not an endpoint of the primary ` +
          `branch '${primary!.name}' (${hosts.join(", ") || "no endpoints"}).`,
      );
    }
    console.log(
      `identity ok: neon primary '${primary!.name}' @ ${host}; firebase project '${projectId}'`,
    );
  } else {
    // The local target must not secretly be production — fail CLOSED:
    // a remote DATABASE_URL is only acceptable once the Neon API
    // confirms the host is not the production primary endpoint. No
    // API key / failed lookup / unknown host class → refuse.
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (!localHosts.has(host) && !host.endsWith(".local")) {
      if (!process.env.NEON_API_KEY) {
        fail(
          `--local against remote DATABASE_URL host '${host}' cannot be ` +
            "verified — set NEON_API_KEY + NEON_PROJECT_ID so the " +
            "endpoint can be checked against the production primary, " +
            "or point DATABASE_URL at a local database.",
        );
      }
      let hosts: string[] = [];
      try {
        const project = neonProjectId();
        const [branches, endpoints] = await Promise.all([
          listBranches(process.env.NEON_API_KEY, project),
          listEndpoints(process.env.NEON_API_KEY, project),
        ]);
        const primary = branches.find((b) => b.primary);
        hosts = primary
          ? endpoints.filter((e) => e.branch_id === primary.id).map((e) => e.host)
          : [];
      } catch (error) {
        if (error instanceof DemoRefusal) throw error;
        fail(
          `--local against remote DATABASE_URL host '${host}' could not ` +
            `be verified against the Neon API (${error instanceof Error ? error.message : error}) — refusing.`,
        );
      }
      if (hosts.includes(host)) {
        fail(
          `DATABASE_URL host '${host}' IS the production primary endpoint — ` +
            "remove production credentials before using --local.",
        );
      }
    }
    console.log(`identity ok (local): host=${host}; project='${projectId}'`);
  }

  const sqlClient = postgres(url!, { max: 2, prepare: false });
  return {
    mode: opts.production ? "production" : "local",
    sql: sqlClient,
    db: drizzle(sqlClient),
    projectId: projectId!,
    bucketName: bucket!,
  };
}

// --- Shared reporting ---------------------------------------------------------------

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function migrationStatus(db: ReturnType<typeof drizzle>): Promise<string> {
  // drizzle-orm's journal table is (id, hash, created_at) — there is no
  // tag column; created_at is the journal entry's `when` (folderMillis).
  const journal = JSON.parse(
    readFileSync(join("drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  let applied: Set<number>;
  try {
    const result = await db.execute(
      sql`select created_at from drizzle.__drizzle_migrations`,
    );
    const rows = (Array.isArray(result)
      ? result
      : (result as { rows: { created_at: unknown }[] }).rows) as {
      created_at: unknown;
    }[];
    applied = new Set(rows.map((r) => Number(r.created_at)));
  } catch {
    return `unknown — drizzle.__drizzle_migrations unreadable`;
  }
  const pending = journal.entries
    .filter((e) => !applied.has(e.when))
    .map((e) => e.tag);
  return pending.length === 0
    ? `current (${applied.size} applied)`
    : `PENDING: ${pending.join(", ")}`;
}

// --- Commands ---------------------------------------------------------------------

async function cmdCheck(t: Target) {
  section("environment");
  console.log(`mode:            ${t.mode}`);
  console.log(`firebase project: ${t.projectId}`);
  console.log(`storage bucket:   ${t.bucketName ?? "(unset)"}`);
  console.log(`sentry env label: ${process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "(default)"}`);
  console.log(`maintenance mode: ${process.env.SITE_MAINTENANCE_MODE === "true" ? "ON" : "off"}`);
  console.log(`cron secret:      ${process.env.CRON_SECRET ? "set" : "unset"}`);
  console.log(
    `email:            ${
      process.env.RESEND_API_KEY
        ? `resend configured${process.env.DEMO_EMAIL_OVERRIDE_TO ? " + DEMO_EMAIL_OVERRIDE_TO" : ""}`
        : "no provider (reminder live-runs refused; demo sink unaffected)"
    }`,
  );

  section("migrations");
  console.log(await migrationStatus(t.db));

  section("lifecycle");
  const lifecycle = await readLifecycleRow(t.db);
  console.log(
    lifecycle
      ? `lifecycle=${lifecycle.lifecycle}  demo_seeded_at=${lifecycle.demoSeededAt ?? "-"}  seed_version=${lifecycle.demoSeedVersion ?? "-"}`
      : "no app_state row — resolves to 'live'",
  );
  const run = await latestSeedRun(t.db);
  console.log(
    run
      ? `latest seed run: v${run.seedVersion} seeded_at=${run.seededAt}${run.resetAt ? ` reset_at=${run.resetAt}` : " (ACTIVE)"}`
      : "no seed runs",
  );

  section("postgres domain tables");
  const nonEmpty = await findNonEmptyDomainTables(t.db);
  if (Object.keys(nonEmpty).length === 0) {
    console.log("all domain tables empty ✓");
  } else {
    console.log("NON-EMPTY (seed is blocked until reviewed):");
    for (const [table, n] of Object.entries(nonEmpty)) {
      console.log(`  ${table}: ${n}`);
    }
  }

  section("postgres identity/infra tables (preserved at reset)");
  const windowCounts = await windowTableCounts(t.db);
  for (const [table, n] of Object.entries(windowCounts)) {
    console.log(`  ${table}: ${n}`);
  }

  section("firestore");
  const fs = (await import("firebase-admin/firestore")).getFirestore(getAdminApp());
  for (const name of CMS_COLLECTIONS) {
    const snap = await fs.collection(name).count().get();
    console.log(`  ${name}: ${snap.data().count} doc(s)`);
  }
  const collections = await fs.listCollections();
  const extra = collections
    .map((c) => c.id)
    .filter((id) => !(CMS_COLLECTIONS as readonly string[]).includes(id));
  for (const id of extra) {
    const snap = await fs.collection(id).count().get();
    console.log(`  ${id}: ${snap.data().count} doc(s) (non-CMS)`);
  }

  section("storage");
  const { getStorage } = await import("firebase-admin/storage");
  const bucket = getStorage(getAdminApp()).bucket(t.bucketName);
  for (const prefix of STORAGE_PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    console.log(`  ${prefix}: ${files.length} object(s)`);
  }

  section("firebase auth");
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth(getAdminApp());
  const users = await auth.listUsers(1000);
  console.log(`  ${users.users.length} user(s)`);
  for (const u of users.users) {
    if (
      [DEMO_ADMIN_EMAIL, DEMO_OWNER_EMAIL, DEMO_USER_EMAIL].includes(
        u.email ?? "",
      )
    ) {
      console.log(`  demo account present: ${u.email}`);
    }
  }

  section("verdict");
  const canSeed =
    lifecycle?.lifecycle === "prelaunch-demo" &&
    Object.keys(nonEmpty).length === 0;
  console.log(
    canSeed
      ? "pre-launch state confirmed — seeding is permitted"
      : "seeding is NOT permitted in current state",
  );
}

async function cmdSeed(t: Target, confirm?: string, snapshot = true) {
  const wanted = CONFIRMATIONS.seed[t.mode];
  if (confirm !== wanted) {
    fail(`seed requires --confirm "${wanted}"`);
  }

  await requirePrelaunchLifecycle(t.db);

  const active = await activeSeedRun(t.db);
  if (active) {
    fail(
      `a demo seed is already applied (run ${active.id}, seeded ${active.seededAt}) — ` +
        "reset it before re-seeding.",
    );
  }

  const nonEmpty = await findNonEmptyDomainTables(t.db);
  if (Object.keys(nonEmpty).length > 0) {
    console.error("production is NOT empty — stopping, nothing was changed:");
    for (const [table, n] of Object.entries(nonEmpty)) {
      console.error(`  ${table}: ${n}`);
    }
    fail(
      "domain tables contain rows that predate the demo. Review them " +
        "with the owner before seeding — do NOT guess at removal.",
    );
  }

  // Demo account password: sourced from env, never committed or echoed.
  const password = process.env.DEMO_ACCOUNT_PASSWORD;
  if (!password || password.length < 8) {
    fail(
      "DEMO_ACCOUNT_PASSWORD (>=8 chars) must be set — demo accounts " +
        "never get a hard-coded password.",
    );
  }

  // Pre-seed snapshot of the Neon primary branch when the API is
  // reachable — cheap insurance even though the database is empty.
  if (snapshot && t.mode === "production" && process.env.NEON_API_KEY) {
    try {
      const project = neonProjectId();
      const branches = await listBranches(process.env.NEON_API_KEY, project);
      const primary = branches.find((b) => b.primary);
      if (primary) {
        await neonApi(process.env.NEON_API_KEY, project, `/branches/${primary.id}/snapshot`, {
          method: "POST",
          body: JSON.stringify({
            snapshot: { name: `pre-demo-${new Date().toISOString().slice(0, 16)}` },
          }),
        });
        console.log("pre-seed Neon snapshot created");
      }
    } catch (error) {
      console.warn(
        `warning: pre-seed snapshot failed (${error instanceof Error ? error.message : error}) — continuing (database verified empty)`,
      );
    }
  }

  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const auth = getAuth(getAdminApp());
  const fs = getFirestore(getAdminApp());
  const bucket = getStorage(getAdminApp()).bucket(t.bucketName);

  // --- Preflight: Firestore + Storage + Auth ---
  const emptyCollections: string[] = [];
  for (const name of CMS_COLLECTIONS) {
    const count = (await fs.collection(name).count().get()).data().count;
    if (count === 0) emptyCollections.push(name);
  }
  const emptyPrefixes: string[] = [];
  for (const prefix of STORAGE_PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) emptyPrefixes.push(prefix);
  }
  const demoEmails = [DEMO_ADMIN_EMAIL, DEMO_OWNER_EMAIL, DEMO_USER_EMAIL];
  for (const email of demoEmails) {
    const existing = await auth.getUserByEmail(email).catch(() => null);
    if (existing) {
      fail(
        `demo account ${email} already exists — reset the demo before re-seeding.`,
      );
    }
  }

  // --- 1. Begin the run: the seeded_at boundary for the reset window. ---
  const runInsert = await t.db.execute(
    sql`insert into demo_seed_runs (seed_version, empty_firestore_collections, empty_storage_prefixes)
        values (${DEMO_SEED_VERSION}, ${JSON.stringify(emptyCollections)}::jsonb, ${JSON.stringify(emptyPrefixes)}::jsonb)
        returning id, seeded_at`,
  );
  const runRows = Array.isArray(runInsert)
    ? runInsert
    : (runInsert as { rows: { id: string; seeded_at: string }[] }).rows;
  const runRow = runRows[0] as { id: string; seeded_at: string | Date };
  const run = {
    id: runRow.id,
    seeded_at:
      runRow.seeded_at instanceof Date
        ? runRow.seeded_at.toISOString()
        : String(runRow.seeded_at),
  };

  // --- 2. Firebase Auth demo accounts ---
  const uids: Record<string, string> = {};
  for (const email of demoEmails) {
    const user = await auth.createUser({ email, password, emailVerified: true });
    uids[email] = user.uid;
  }
  const manifest: DemoSeedManifestEntry[] = demoEmails.map((email) => ({
    store: "auth" as const,
    table: "users",
    id: uids[email],
  }));

  // --- 3. Postgres domain seed ---
  const asOf = new Date().toISOString().slice(0, 10);
  const seed = await applyDemoPostgresSeed(t.db, {
    adminUid: uids[DEMO_ADMIN_EMAIL],
    ownerUid: uids[DEMO_OWNER_EMAIL],
    userUid: uids[DEMO_USER_EMAIL],
    asOf,
  });
  manifest.push(...seed.entities);

  // --- 4. Firestore content (empty collections only) ---
  const seedData = JSON.parse(
    readFileSync(join(__dirname, "seed-data.json"), "utf8"),
  );
  const cmsWrites: DemoSeedManifestEntry[] = [];
  if (emptyCollections.includes("homepage")) {
    await fs.collection("homepage").doc("main").set(seedData.homepage);
    cmsWrites.push({ store: "firestore", table: "homepage", id: "main" });
  }
  if (emptyCollections.includes("siteSettings")) {
    await fs.collection("siteSettings").doc("global").set({
      ...seedData.siteSettings,
      mapEmbedUrl:
        "https://www.google.com/maps?q=The+Bottom,+Saba&output=embed",
    });
    cmsWrites.push({ store: "firestore", table: "siteSettings", id: "global" });
  }
  if (emptyCollections.includes("faq")) {
    const faqs = demoFaqs();
    for (const faq of faqs) {
      const ref = await fs.collection("faq").add({ ...faq, createdAt: new Date() });
      cmsWrites.push({ store: "firestore", table: "faq", id: ref.id });
    }
  }
  if (emptyCollections.includes("vetServices")) {
    await fs.collection("vetServices").doc("main").set(demoVetServices());
    cmsWrites.push({ store: "firestore", table: "vetServices", id: "main" });
  }
  if (emptyCollections.includes("animalAdoptions")) {
    await fs.collection("animalAdoptions").doc("main").set(demoAdoptionsContent());
    cmsWrites.push({ store: "firestore", table: "animalAdoptions", id: "main" });
  }
  if (emptyCollections.includes("animalRegistration")) {
    await fs.collection("animalRegistration").doc("main").set(demoRegistrationContent());
    cmsWrites.push({ store: "firestore", table: "animalRegistration", id: "main" });
  }
  manifest.push(...cmsWrites);

  // --- 5. Storage fixtures (empty prefixes only) ---
  const storageWrites: DemoSeedManifestEntry[] = [];
  const pendingSub = seed.entities.find(
    (e) => e.table === "registration_submissions",
  );
  if (pendingSub && emptyPrefixes.includes("receipts/")) {
    const path = `receipts/${pendingSub.id}`;
    await bucket.file(path).save(demoPdf("DEMO DOCUMENT — NOT A REAL RECEIPT", [
      "Pre-launch demo fixture.",
      "This file exists only to exercise the receipt viewer.",
      "It does not represent a real payment.",
    ]), { contentType: "application/pdf" });
    storageWrites.push({ store: "storage", table: "receipts", id: path });
    await t.db.execute(
      sql`update registration_submissions set payment_receipt_path = ${path} where id = ${pendingSub.id}`,
    );
  }
  if (emptyPrefixes.includes("vet-docs/")) {
    const path = "vet-docs/demo-vaccination-certificate.pdf";
    await bucket.file(path).save(demoPdf("DEMO DOCUMENT — FICTIONAL VACCINATION RECORD", [
      "Pre-launch demo fixture.",
      "No real animal or medical data is contained in this file.",
    ]), { contentType: "application/pdf" });
    storageWrites.push({ store: "storage", table: "vet-docs", id: path });
  }
  manifest.push(...storageWrites);

  // --- 6. Manifest + lifecycle bookkeeping ---
  for (const e of manifest) {
    await t.db.execute(
      sql`insert into demo_seed_entities (run_id, entity_store, entity_table, entity_id)
          values (${run.id}, ${e.store}, ${e.table}, ${e.id})
          on conflict do nothing`,
    );
  }
  await t.db.execute(
    sql`update demo_seed_runs set seeded_counts = ${JSON.stringify(seed.counts)}::jsonb where id = ${run.id}`,
  );
  await t.db.execute(
    sql`update app_state set demo_seeded_at = ${run.seeded_at}::timestamptz, demo_seed_version = ${DEMO_SEED_VERSION}, updated_at = now() where id = 1`,
  );

  section("seed complete");
  console.log(`seeded_at:   ${run.seeded_at}`);
  console.log(`seed version: ${DEMO_SEED_VERSION}`);
  console.log(`manifest:    ${manifest.length} entities`);
  console.log("counts:");
  for (const [table, n] of Object.entries(seed.counts).sort()) {
    console.log(`  ${table}: ${n}`);
  }
  console.log(`demo accounts created: ${demoEmails.join(", ")}`);
  console.log(
    "note: all seeded emails use example.com — nothing can receive real mail, " +
      "and the demo-sink sender drops outbound email regardless.",
  );
}

async function cmdStatus(t: Target) {
  const lifecycle = await readLifecycleRow(t.db);
  console.log(`lifecycle: ${lifecycle?.lifecycle ?? "absent → live"}`);
  const run = await latestSeedRun(t.db);
  if (!run) {
    console.log("no demo seed runs recorded.");
    return;
  }
  console.log(
    `run: v${run.seedVersion}  seeded_at=${run.seededAt}  ${run.resetAt ? `reset_at=${run.resetAt}` : "ACTIVE"}`,
  );
  if (run.resetAt) {
    console.log("the latest run has been reset — status reflects history.");
  }

  section("postgres: seeded baseline vs current");
  const tables = Object.keys(run.seededCounts);
  const current = await tableCounts(t.db, tables);
  for (const table of tables.sort()) {
    const expected = run.seededCounts[table];
    const now = current[table] ?? 0;
    const delta = now - expected;
    console.log(
      `  ${table}: ${now} (seeded ${expected}${delta === 0 ? "" : `, ${delta > 0 ? "+" : ""}${delta}`})`,
    );
  }

  // Rows created inside the demo window that were NOT in the seed —
  // board experimentation, surfaced without printing record content.
  section("demo-window additions (created after seed)");
  const all = await listPublicTables(t.db);
  const exempt = new Set<string>([
    ...TOOLING_TABLES,
    ...EPHEMERAL_TABLES,
  ]);
  for (const table of all) {
    if (exempt.has(table)) continue;
    try {
      const r = await t.db.execute(
        sql.raw(
          `select count(*)::int as n from "${table}" where created_at >= '${run.seededAt}'::timestamptz`,
        ),
      );
      const rows = Array.isArray(r) ? r : (r as { rows: { n: number }[] }).rows;
      const n = Number(rows[0]?.n ?? 0);
      const seeded = run.seededCounts[table] ?? 0;
      if (n > seeded) {
        console.log(`  ${table}: +${n - seeded} since seed`);
      }
    } catch {
      // Table has no created_at — skip (rate_limit_windows handled below).
    }
  }

  section("firebase auth demo accounts");
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth(getAdminApp());
  const users = await auth.listUsers(1000);
  const windowUsers = users.users.filter(
    (u) => new Date(u.metadata.creationTime) >= new Date(run.seededAt),
  );
  console.log(`  total users: ${users.users.length}`);
  console.log(`  created during demo window: ${windowUsers.length}`);

  section("firestore / storage");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const fs = getFirestore(getAdminApp());
  for (const name of CMS_COLLECTIONS) {
    const count = (await fs.collection(name).count().get()).data().count;
    const wiped = run.emptyFirestoreCollections.includes(name)
      ? " (was empty at seed — reset wipes this collection)"
      : "";
    console.log(`  ${name}: ${count} doc(s)${wiped}`);
  }
  const bucket = getStorage(getAdminApp()).bucket(t.bucketName);
  for (const prefix of STORAGE_PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    const wiped = run.emptyStoragePrefixes.includes(prefix)
      ? " (was empty at seed — reset wipes this prefix)"
      : "";
    console.log(`  ${prefix}: ${files.length} object(s)${wiped}`);
  }
}

async function cmdReset(t: Target, confirm?: string) {
  const wanted = CONFIRMATIONS.reset[t.mode];
  if (confirm !== wanted) {
    fail(`reset requires --confirm "${wanted}"`);
  }
  await requirePrelaunchLifecycle(t.db);
  const run = await activeSeedRun(t.db);
  if (!run) {
    fail("no active demo seed run — nothing to reset (already clean?).");
  }

  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const auth = getAuth(getAdminApp());
  const fs = getFirestore(getAdminApp());
  const bucket = getStorage(getAdminApp()).bucket(t.bucketName);
  const seededAt = run.seededAt;

  // Read the manifest FIRST — finalizePostgresReset clears it as part
  // of cleanup, so anything needed for non-Postgres stores must be
  // captured now.
  const manifestDocs = await manifestEntities(t.db, run.id, "firestore");
  const manifestObjects = await manifestEntities(t.db, run.id, "storage");

  // ORDERING IS THE SAFETY PROPERTY: external stores are cleaned FIRST
  // while the seed run is still 'active'. If any step fails, the run
  // remains active and `reset` can simply be re-run — every step below
  // is idempotent. The Postgres data reset + manifest/run finalization
  // happens LAST, atomically in one transaction.

  // --- Firebase Auth ---
  // Delete users created during the demo window whose email is NOT in the
  // ADMIN_EMAILS bootstrap list — pre-existing real accounts and the
  // operator's own login are never touched.
  section("firebase auth reset");
  const preserve = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const users = await auth.listUsers(1000);
  let deletedUsers = 0;
  for (const u of users.users) {
    const created = new Date(u.metadata.creationTime);
    const email = (u.email ?? "").toLowerCase();
    if (created >= new Date(seededAt) && !preserve.has(email)) {
      try {
        await auth.deleteUser(u.uid);
        deletedUsers++;
      } catch (error) {
        // Idempotent retry: a user gone since the listing is fine.
        if (
          (error as { code?: string }).code !== "auth/user-not-found"
        ) {
          throw error;
        }
      }
    }
  }
  console.log(`  deleted demo-window users: ${deletedUsers}`);

  // --- Firestore ---
  // Collections verified empty at seed get wiped wholesale (everything
  // in them is demo data); manifest docs elsewhere are deleted exactly.
  section("firestore reset");
  for (const name of run.emptyFirestoreCollections) {
    await fs.recursiveDelete(fs.collection(name));
    console.log(`  wiped collection ${name}`);
  }
  for (const doc of manifestDocs) {
    if (run.emptyFirestoreCollections.includes(doc.table)) continue;
    await fs.collection(doc.table).doc(doc.id).delete();
    console.log(`  deleted ${doc.table}/${doc.id}`);
  }

  // --- Storage ---
  section("storage reset");
  for (const prefix of run.emptyStoragePrefixes) {
    const [files] = await bucket.getFiles({ prefix });
    for (const file of files) {
      const created = new Date(file.metadata.timeCreated ?? 0);
      if (created >= new Date(seededAt)) {
        await file.delete();
      }
    }
    console.log(`  wiped objects under ${prefix} created during demo`);
  }
  for (const obj of manifestObjects) {
    try {
      await bucket.file(obj.id).delete({ ignoreNotFound: true });
    } catch (error) {
      console.warn(`  warning: could not delete ${obj.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log("  manifest objects removed");

  // --- Postgres (LAST, atomically) ---
  // Only reached when every external store is clean. The data reset and
  // the manifest/run/lifecycle finalization commit together — a failure
  // anywhere earlier leaves an active run and a fully retryable reset.
  section("postgres reset");
  const report: PostgresResetReport = await t.db.transaction(
    async (tx) => {
      const r = await resetPostgresDemoData(tx, seededAt);
      await finalizePostgresReset(tx);
      return r;
    },
  );
  console.log(`  truncated domain tables: ${report.truncatedTables.length}`);
  for (const [table, n] of Object.entries(report.windowDeleted)) {
    if (n > 0) console.log(`  window-deleted ${table}: ${n} row(s)`);
  }
  if (report.ephemeralCleared > 0) {
    console.log(`  cleared rate-limit windows: ${report.ephemeralCleared}`);
  }

  section("reset complete");
  console.log("run `verify` to confirm all stores are clean.");
}

async function manifestEntities(
  db: ReturnType<typeof drizzle>,
  runId: string,
  store: string,
): Promise<{ table: string; id: string }[]> {
  const r = await db.execute(
    sql`select entity_table, entity_id from demo_seed_entities
        where run_id = ${runId} and entity_store = ${store}`,
  );
  const rows = (Array.isArray(r)
    ? r
    : (r as { rows: { entity_table: string; entity_id: string }[] })
        .rows) as { entity_table: string; entity_id: string }[];
  return rows.map((row) => ({
    table: row.entity_table,
    id: row.entity_id,
  }));
}

async function cmdVerify(t: Target): Promise<boolean> {
  const run = await latestSeedRun(t.db);
  const seededAt = run?.seededAt ?? null;
  const failures: string[] = [];

  section("postgres");
  const clean = await verifyPostgresClean(t.db, seededAt);
  if (Object.keys(clean.domainResiduals).length === 0) {
    console.log("  domain tables: clean ✓");
  } else {
    for (const [table, n] of Object.entries(clean.domainResiduals)) {
      failures.push(`postgres.${table}: ${n} residual row(s)`);
    }
    console.log(`  domain residuals: ${JSON.stringify(clean.domainResiduals)}`);
  }
  if (Object.keys(clean.windowResiduals).length === 0) {
    console.log("  demo-window rows: none ✓");
  } else {
    console.log(`  window residuals: ${JSON.stringify(clean.windowResiduals)}`);
    failures.push("demo-window rows remain in identity tables");
  }
  if (clean.manifestResidual === 0) {
    console.log("  manifest: cleared ✓");
  } else {
    failures.push(`demo_seed_entities: ${clean.manifestResidual} row(s) remain`);
  }

  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const auth = getAuth(getAdminApp());
  const fs = getFirestore(getAdminApp());
  const bucket = getStorage(getAdminApp()).bucket(t.bucketName);

  section("firebase auth");
  const preserve = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const users = await auth.listUsers(1000);
  let demoUsers = 0;
  if (seededAt) {
    for (const u of users.users) {
      const email = (u.email ?? "").toLowerCase();
      if (
        new Date(u.metadata.creationTime) >= new Date(seededAt) &&
        !preserve.has(email)
      ) {
        demoUsers++;
      }
    }
  }
  if (demoUsers === 0) {
    console.log("  no demo-window users remain ✓");
  } else {
    failures.push(`firebase auth: ${demoUsers} demo-window user(s) remain`);
    console.log(`  demo-window users remaining: ${demoUsers}`);
  }

  section("firestore");
  if (run) {
    for (const name of run.emptyFirestoreCollections) {
      const count = (await fs.collection(name).count().get()).data().count;
      if (count === 0) {
        console.log(`  ${name}: clean ✓`);
      } else {
        failures.push(`firestore.${name}: ${count} doc(s) remain`);
        console.log(`  ${name}: ${count} doc(s) remain`);
      }
    }
  } else {
    console.log("  no seed run — skipped collection comparison");
  }

  section("storage");
  if (run) {
    for (const prefix of run.emptyStoragePrefixes) {
      const [files] = await bucket.getFiles({ prefix });
      const recent = files.filter(
        (f) => new Date(f.metadata.timeCreated ?? 0) >= new Date(run.seededAt),
      );
      if (recent.length === 0) {
        console.log(`  ${prefix}: clean ✓`);
      } else {
        failures.push(`storage ${prefix}: ${recent.length} object(s) remain`);
        console.log(`  ${prefix}: ${recent.length} object(s) remain`);
      }
    }
  }

  section("verdict");
  if (failures.length === 0) {
    console.log("VERIFY-CLEAN PASS — no demo artifacts remain in any store.");
    return true;
  }
  console.log("VERIFY-CLEAN FAIL:");
  for (const f of failures) console.log(`  - ${f}`);
  return false;
}

async function cmdGoLive(t: Target, confirm?: string) {
  const wanted = CONFIRMATIONS["go-live"][t.mode];
  if (confirm !== wanted) {
    fail(`go-live requires --confirm "${wanted}"`);
  }

  const lifecycle = await readLifecycleRow(t.db);
  if (lifecycle?.lifecycle === "live") {
    console.log("already live — nothing to do.");
    return;
  }

  console.log("verifying stores are clean before the one-way transition…");
  const clean = await cmdVerify(t);
  if (!clean) {
    fail(
      "demo artifacts remain — run `reset` then `verify` first. Going " +
        "live with demo residue would leave fictional data on the real site.",
    );
  }

  await transitionToLive(t.db);
  section("go-live complete");
  console.log("lifecycle is now 'live' — the transition is permanent.");
  console.log("demo seed/reset/verify tooling is retired for this database.");
}

// --- CMS content -------------------------------------------------------------------

function demoFaqs() {
  return [
    { category: "General", question: "What does SFPCA do?", answer: "The Saba Foundation for Preventing Cruelty to Animals cares for animals on Saba through veterinary services, registration, and adoption.", order: 1 },
    { category: "General", question: "Where are you located?", answer: "We are based in The Bottom, Saba. See the Contact page for hours and directions.", order: 2 },
    { category: "Registration", question: "Do I have to register my pet?", answer: "Yes — annual registration helps us keep the island's animal records current and supports our veterinary programs.", order: 3 },
    { category: "Registration", question: "How much does registration cost?", answer: "Fees depend on whether your animal is spayed or neutered. See the registration page for the current schedule.", order: 4 },
    { category: "Adoption", question: "How do I adopt an animal?", answer: "Browse the adoption page and contact us — we'll arrange a meeting and walk you through the process.", order: 5 },
    { category: "Adoption", question: "Are adopted animals vaccinated?", answer: "Animals adopted through SFPCA are health-checked and vaccinated before going home.", order: 6 },
    { category: "Veterinary", question: "Do you offer spay/neuter services?", answer: "Yes — the clinic offers spay and neuter services. Contact us to schedule.", order: 7 },
    { category: "Lost & Found", question: "I lost my pet — what should I do?", answer: "Report it through the lost-pets page or contact us directly. We maintain an active lost-and-found registry.", order: 8 },
  ];
}

function demoVetServices() {
  return {
    heroTitle: "Veterinary Services",
    heroDescription: "Professional and affordable veterinary care for animals on Saba",
    ctaTitle: "Ready to Book an Appointment?",
    ctaDescription: "Contact us to schedule a visit for your pet.",
    services: [
      { title: "Wellness Exams", description: "Routine checkups to keep your pet healthy.", price: "$25", icon: "stethoscope" },
      { title: "Vaccinations", description: "Core vaccines for dogs and cats.", price: "$15", icon: "syringe" },
      { title: "Spay & Neuter", description: "Surgical sterilization services.", price: "$50", icon: "scissors" },
      { title: "Emergency Care", description: "Urgent care for injured or ill animals.", price: "Varies", icon: "alert" },
      { title: "Microchipping", description: "Permanent identification for your pet.", price: "$20", icon: "chip" },
    ],
  };
}

function demoAdoptionsContent() {
  return {
    heroTitle: "Animal Adoptions",
    heroDescription: "Find your perfect companion. Give a loving animal their forever home on Saba.",
    successTitle: "Success Stories",
    successDescription: "Animals who found their forever homes",
    successStories: [
      { name: "Bella", story: "Found abandoned, now living with a loving family.", image: "🐕" },
      { name: "Max", story: "Six months in care before finding his perfect match.", image: "🐈" },
      { name: "Luna", story: "Rescued from the streets, now thriving.", image: "🐕" },
    ],
    availableTitle: "Available for Adoption",
    availableDescription: "These animals are waiting for their forever homes",
    partnerTitle: "Partner Organizations",
    partnerDescription: "We work with these organizations to help more animals",
    partners: [
      { name: "Saba Veterinary Clinic", logo: "🏥" },
      { name: "Caribbean Animal Welfare", logo: "🐾" },
      { name: "Island Pet Network", logo: "🐕" },
    ],
    ctaTitle: "Ready to Adopt?",
    ctaDescription: "Contact us to start the adoption process.",
  };
}

function demoRegistrationContent() {
  return {
    heroTitle: "Animal Registration",
    heroDescription: "Register your pet with SFPCA. Annual registration is required for all animals on Saba.",
    formTitle: "Animal Registration Form",
    formDescription: "Please fill out all required fields. Registration must be renewed annually.",
    howToPayTitle: "How to Pay",
    howToPayItems: [
      "In person at our office",
      "Via bank transfer",
      "At participating vet clinics",
    ],
    whatHappensNextTitle: "What Happens Next",
    whatHappensNextItems: [
      "Submit this form with payment receipt",
      "We verify your payment within 24-48 hours",
      "You'll receive a registration certificate",
      "Annual renewal required",
    ],
  };
}

// A minimal valid one-page PDF carrying only demo text — readable by
// every PDF viewer, unmistakably fictional, and tiny.
function demoPdf(title: string, lines: string[]): Buffer {
  const text = [title, "", ...lines]
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 40 ${760 - i * 22} Td (${l.replace(/[()\\]/g, "")}) Tj ET`)
    .join("\n");
  const stream = `0.9 0.6 0.1 rg\n0 720 612 80 re f\n${text}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// --- Entrypoint -----------------------------------------------------------------------

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (command) {
    case "check": {
      // Read-only — no --production/--local needed, but the mode still
      // selects which identity rules are verified.
      const t = await resolveTarget({
        production: opts.production || !opts.local,
        local: opts.local,
      });
      try {
        await cmdCheck(t);
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "status": {
      const t = await resolveTarget({
        production: opts.production || !opts.local,
        local: opts.local,
      });
      try {
        await cmdStatus(t);
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "verify": {
      const t = await resolveTarget({
        production: opts.production || !opts.local,
        local: opts.local,
      });
      try {
        const ok = await cmdVerify(t);
        process.exitCode = ok ? 0 : 2;
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "seed": {
      const t = await resolveTarget(opts);
      try {
        await cmdSeed(t, opts.confirm, opts.snapshot);
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "reset": {
      const t = await resolveTarget(opts);
      try {
        await cmdReset(t, opts.confirm);
      } finally {
        await t.sql.end();
      }
      break;
    }
    case "go-live": {
      const t = await resolveTarget(opts);
      try {
        await cmdGoLive(t, opts.confirm);
      } finally {
        await t.sql.end();
      }
      break;
    }
    default:
      console.error(
        "usage: production-demo.ts <check|seed|status|reset|verify|go-live> " +
          "[--production|--local] [--confirm \"PHRASE\"] [--no-snapshot]",
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
