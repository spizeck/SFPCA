// Postgres-side operations for the pre-launch demo lifecycle (#275).
// Everything here takes an injected drizzle handle so the same code
// drives the production CLI (postgres-js) and PGlite unit tests —
// nothing in this module reads credentials or env.
//
// Table classification (the reset's whole safety model):
//   - DOMAIN tables: must be EMPTY at seed time. During the demo window
//     everything in them is demo data by definition, so reset TRUNCATEs
//     them wholesale — under the prelaunch invariant that is exactly the
//     demo footprint, no manifest bookkeeping needed.
//   - WINDOW tables: may legitimately hold pre-seed rows (staff sign-ins
//     materialize persons/auth_identities/admin_users before any demo
//     seed; audit_events records real pre-demo actions). Reset deletes
//     only rows created at-or-after the recorded seeded_at boundary —
//     pre-seed rows are never touched.
//   - rate_limit_windows: ephemeral abuse-throttle counters; cleared
//     outright at reset (they self-expire anyway).
//   - TOOLING tables (app_state, demo_seed_runs, demo_seed_entities):
//     the lifecycle machinery itself — never bulk-deleted.

import { sql } from "drizzle-orm";

export const APP_STATE_TABLE = "app_state";
export const DEMO_RUNS_TABLE = "demo_seed_runs";
export const DEMO_ENTITIES_TABLE = "demo_seed_entities";

export const TOOLING_TABLES = [
  APP_STATE_TABLE,
  DEMO_RUNS_TABLE,
  DEMO_ENTITIES_TABLE,
] as const;

// Preserved-by-window tables, in FK-safe delete order (children first).
export const WINDOW_DELETE_TABLES = [
  "household_members",
  "admin_users",
  "auth_identities",
  "households",
  "audit_events",
  "persons",
] as const;

export const EPHEMERAL_TABLES = ["rate_limit_windows"] as const;

// A drizzle-ish handle: both postgres-js and PGlite databases support
// `execute(sql``)`. Typed loosely — this module only uses raw queries.
 
export type DemoDb = { execute: (query: any) => Promise<any> };

// postgres-js execute() returns a RowList (the array itself, with a
// `.count` for affected rows); pglite returns { rows, affectedRows }.
// Normalize both.
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: Record<string, unknown>[] }).rows ??
    []) as Record<string, unknown>[];
}

function affectedOf(result: unknown): number {
  const r = result as { count?: number; affectedRows?: number };
  return r.count ?? r.affectedRows ?? 0;
}

export async function listPublicTables(db: DemoDb): Promise<string[]> {
  const result = (await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  ));
  return rowsOf(result).map((r) => String(r.tablename)).sort();
}

// Domain tables: everything user-facing minus the window/tooling sets.
// Computed at runtime so a future migration can never silently leave a
// new table outside the demo boundary — an unclassified table is
// automatically in the must-be-empty group, which fails CLOSED (it
// blocks seeding rather than being skipped by reset).
export async function domainTables(db: DemoDb): Promise<string[]> {
  const exempt = new Set<string>([
    ...TOOLING_TABLES,
    ...WINDOW_DELETE_TABLES,
    ...EPHEMERAL_TABLES,
  ]);
  return (await listPublicTables(db)).filter((t) => !exempt.has(t));
}

export async function tableCounts(
  db: DemoDb,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = (await db.execute(
      sql.raw(`select count(*)::int as n from "${table}"`),
    ));
    counts[table] = Number(rowsOf(result)[0]?.n ?? 0);
  }
  return counts;
}

// --- Lifecycle -------------------------------------------------------------

export interface LifecycleRow {
  lifecycle: string;
  demoSeededAt: string | null;
  demoSeedVersion: number | null;
}

export async function readLifecycleRow(
  db: DemoDb,
): Promise<LifecycleRow | null> {
  const result = await db.execute(
    sql`select lifecycle, demo_seeded_at, demo_seed_version from app_state where id = 1`,
  );
  const row = rowsOf(result)[0];
  if (!row) return null;
  return {
    lifecycle: String(row.lifecycle),
    demoSeededAt: row.demo_seeded_at ? toIso(row.demo_seeded_at) : null,
    demoSeedVersion:
      row.demo_seed_version === null || row.demo_seed_version === undefined
        ? null
        : Number(row.demo_seed_version),
  };
}

export class DemoRefusal extends Error {}

// Seed/reset may only ever run while the deployment is in demo posture.
// The 'live' lifecycle is terminal (enforced by the database trigger),
// so this refusal is what makes the tooling impossible to run against a
// live production registry — there is no code path around it.
export async function requirePrelaunchLifecycle(db: DemoDb): Promise<void> {
  const row = await readLifecycleRow(db);
  if (row?.lifecycle !== "prelaunch-demo") {
    throw new DemoRefusal(
      `demo lifecycle is not engaged (app_state lifecycle=${row?.lifecycle ?? "absent → live"}). ` +
        "Demo seed/reset only runs while the deployment is pre-launch.",
    );
  }
}

// --- Seed-run bookkeeping -----------------------------------------------------

// seeded_at comes back as a Date under PGlite and a string under
// postgres-js — normalize to ISO so it can be safely re-embedded in
// boundary predicates.
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function latestSeedRun(
  db: DemoDb,
): Promise<{
  id: string;
  seedVersion: number;
  seededAt: string;
  resetAt: string | null;
  seededCounts: Record<string, number>;
  emptyFirestoreCollections: string[];
  emptyStoragePrefixes: string[];
} | null> {
  const result = (await db.execute(
    sql`select id, seed_version, seeded_at, reset_at, seeded_counts,
               empty_firestore_collections, empty_storage_prefixes
        from demo_seed_runs order by seeded_at desc limit 1`,
  ));
  const row = rowsOf(result)[0];
  if (!row) return null;
  return {
    id: String(row.id),
    seedVersion: Number(row.seed_version),
    seededAt: toIso(row.seeded_at),
    resetAt: row.reset_at ? toIso(row.reset_at) : null,
    seededCounts: (row.seeded_counts ?? {}) as Record<string, number>,
    emptyFirestoreCollections: (row.empty_firestore_collections ??
      []) as string[],
    emptyStoragePrefixes: (row.empty_storage_prefixes ?? []) as string[],
  };
}

export async function activeSeedRun(db: DemoDb) {
  const run = await latestSeedRun(db);
  return run && run.resetAt === null ? run : null;
}

// --- Preflight ------------------------------------------------------------------

// The seed's core safety invariant: every DOMAIN table must be empty —
// the demo may only ever exist on a registry that contains no real
// operational records. Window tables are reported (they may hold
// pre-seed identity/audit rows, which reset preserves) but never block.
export async function findNonEmptyDomainTables(
  db: DemoDb,
): Promise<Record<string, number>> {
  const tables = await domainTables(db);
  const counts = await tableCounts(db, tables);
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

export async function windowTableCounts(
  db: DemoDb,
): Promise<Record<string, number>> {
  return tableCounts(db, [...WINDOW_DELETE_TABLES]);
}

// --- Reset ----------------------------------------------------------------------

export interface PostgresResetReport {
  truncatedTables: string[];
  windowDeleted: Record<string, number>;
  ephemeralCleared: number;
}

// Deletes the complete Postgres demo footprint. Caller has already
// verified lifecycle='prelaunch-demo' and the active seed run — this
// function is the mechanism, not the gate.
export async function resetPostgresDemo(
  db: DemoDb,
  seededAt: string,
): Promise<PostgresResetReport> {
  const report: PostgresResetReport = {
    truncatedTables: [],
    windowDeleted: {},
    ephemeralCleared: 0,
  };

  // 1. Domain tables: everything here is demo data under the seed
  //    invariant — truncate wholesale. Computed dynamically so a new
  //    table added by a later migration can never escape the boundary.
  const domains = await domainTables(db);
  if (domains.length > 0) {
    await db.execute(
      sql.raw(
        `truncate table ${domains.map((t) => `"${t}"`).join(", ")} restart identity cascade`,
      ),
    );
    report.truncatedTables = domains;
  }

  // 2. Window tables: only rows created during the demo window go —
  //    pre-seed staff/identity rows are real and stay.
  for (const table of WINDOW_DELETE_TABLES) {
    const result = (await db.execute(
      sql.raw(
        `delete from "${table}" where created_at >= '${seededAt}'::timestamptz`,
      ),
    ));
    report.windowDeleted[table] = affectedOf(result);
  }

  // 3. Ephemeral abuse-throttle state: cleared outright.
  const eph = await db.execute(
    sql.raw(`delete from rate_limit_windows`),
  );
  report.ephemeralCleared = affectedOf(eph);

  // 4. Tooling state: clear the manifest and mark the run reset; the
  //    lifecycle row stays 'prelaunch-demo' (re-seed remains possible)
  //    but is no longer "seeded".
  const run = await activeSeedRun(db);
  if (run) {
    await db.execute(
      sql`delete from demo_seed_entities where run_id = ${run.id}`,
    );
    await db.execute(
      sql`update demo_seed_runs set reset_at = now() where id = ${run.id}`,
    );
  }
  await db.execute(
    sql`update app_state set demo_seeded_at = null, demo_seed_version = null, updated_at = now() where id = 1`,
  );

  return report;
}

// --- Verify-clean ----------------------------------------------------------------

export interface CleanReport {
  domainResiduals: Record<string, number>;
  windowResiduals: Record<string, number>;
  ephemeralResidual: number;
  manifestResidual: number;
}

// Proof that no Postgres demo artifacts remain. Anything non-zero in
// the report is a leftover — the caller turns it into pass/fail.
export async function verifyPostgresClean(
  db: DemoDb,
  seededAt: string | null,
): Promise<CleanReport> {
  const report: CleanReport = {
    domainResiduals: {},
    windowResiduals: {},
    ephemeralResidual: 0,
    manifestResidual: 0,
  };

  const domains = await domainTables(db);
  const domainCounts = await tableCounts(db, domains);
  for (const [table, n] of Object.entries(domainCounts)) {
    if (n > 0) report.domainResiduals[table] = n;
  }

  if (seededAt) {
    for (const table of WINDOW_DELETE_TABLES) {
      const result = (await db.execute(
        sql.raw(
          `select count(*)::int as n from "${table}" where created_at >= '${seededAt}'::timestamptz`,
        ),
      ));
      const n = Number(rowsOf(result)[0]?.n ?? 0);
      if (n > 0) report.windowResiduals[table] = n;
    }
    const eph = (await db.execute(
      sql`select count(*)::int as n from rate_limit_windows where window_start >= ${seededAt}::timestamptz`,
    ));
    report.ephemeralResidual = Number(rowsOf(eph)[0]?.n ?? 0);
  }

  const manifest = (await db.execute(
    sql`select count(*)::int as n from demo_seed_entities`,
  ));
  report.manifestResidual = Number(rowsOf(manifest)[0]?.n ?? 0);

  return report;
}

// --- Go-live -------------------------------------------------------------------

// The one-way transition. Requires a clean report: going live with demo
// residue would leave fictional data on the real site with no way back.
// The database trigger enforces finality — after this UPDATE succeeds,
// the row can never be modified again.
export async function transitionToLive(db: DemoDb): Promise<void> {
  await db.execute(
    sql`update app_state
        set lifecycle = 'live', live_at = now(),
            demo_seeded_at = null, demo_seed_version = null,
            updated_at = now()
        where id = 1`,
  );
}
