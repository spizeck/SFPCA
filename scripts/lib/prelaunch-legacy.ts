// One-time pre-launch legacy-seed remediation (#278).
//
// The owner has confirmed production contains NO live data — only
// pre-launch seeded/test artifacts. Migration 0023 correctly
// initialized app_state.lifecycle='live' because those artifacts
// existed, which blocks the board-demo seeding tool. This module is
// the verification + removal half of the one-time path back to
// 'prelaunch-demo'; drizzle/0024_* is the lifecycle-correction half.
//
// Safety model — fail CLOSED on exact-shape match, never heuristics:
//   - every expected record is matched by ID (Postgres uuids,
//     Firestore doc ids, storage object names) against the audited
//     2026-10-03 inventory — "fewer than N rows" style rules are
//     deliberately not used;
//   - preserved stores are classified by provenance (bootstrap admin
//     set, CMS collections, intentional asset prefixes);
//   - ANY unexpected record anywhere → the audit reports violations
//     and `apply` refuses to run;
//   - removal is idempotent: a subset of the expected set still
//     verifies and re-running finishes the job.
//
// Nothing here reads credentials or env — the CLI injects database,
// Auth, Firestore, and Storage handles so vitest can drive the same
// logic against PGlite and fakes.

import { sql } from "drizzle-orm";
import {
  domainTables,
  readLifecycleRow,
  type DemoDb,
} from "./demo-db";

// --- Expected legacy manifest -------------------------------------------------
//
// The exact production inventory audited read-only on 2026-10-03
// (issue #278). uuids/doc-ids only — no PII, no secrets.

// Postgres animals.id — the three legacy Firestore-import test animals.
export const LEGACY_PG_ANIMAL_IDS = [
  "a47c09b6-d93e-411c-99a4-d4a28eb98e6e",
  "74957f4f-a6c4-49aa-be0b-ec8c31c55653",
  "f446d61f-2125-4127-a39a-cb5417b461c9",
] as const;

// Firestore animals/ doc ids — the same three fixtures, pre-migration.
export const LEGACY_FS_ANIMAL_IDS = [
  "iePrBbhxkaDLNgsr7Im7",
  "18d7l962nRzSyubN39ti",
  "eE6VQ9Y3p7QYYeLfE8pS",
] as const;

// Window/identity tables the reset model preserves — verified by exact
// row id so a new/unexpected identity row fails the audit. Empty list
// means "must be empty".
export const EXPECTED_WINDOW_ROWS: Record<string, readonly string[]> = {
  persons: [
    "08df664c-9b7c-48fa-b53c-fcd315aa2a56",
    "c2ea23b2-70ff-401a-900e-cca686c6a8a2",
  ],
  admin_users: [
    "63639bee-99fd-40d4-865b-3848f964626c",
    "85f7120a-39e8-45cf-8b87-9e49ee6c8c89",
    "2ccd76ec-0b47-4ee8-9812-83b92a67e1b2",
    "c84e8b7b-6037-4e13-97f4-b10048461fe4",
  ],
  auth_identities: [
    "5648e3d5-684c-4ba4-91ef-7cd0c5808353",
    "bd7e2d47-cb62-4652-ae27-c68fc53a2097",
  ],
  audit_events: [
    "4abb5f81-813b-4d34-99ed-bdfc573cc228",
    "e7477466-6afc-4b76-bb66-8dd72bf7f599",
    "45903371-2598-436b-936d-8e116c092311",
    "c18a5c8e-d60f-4bc6-b210-31f8c71d847e",
  ],
  households: [],
  household_members: [],
};

// Firestore collections allowed to exist, classified:
//   - remove: the legacy animals fixture docs (exact doc ids)
//   - preserve: intentional CMS content (exact doc ids) + the bootstrap
//     admin collection (verified by membership in the admin set, not ids)
export const EXPECTED_FS_REMOVE: Record<string, readonly string[]> = {
  animals: LEGACY_FS_ANIMAL_IDS,
};
export const EXPECTED_FS_PRESERVE: Record<string, readonly string[]> = {
  homepage: ["main"],
  siteSettings: ["global"],
  faq: ["CBpxldUiBQRsRFLG04Oc", "main"],
};
export const FS_ADMIN_COLLECTION = "admins";

// Storage: private app prefixes that must be EMPTY (any object is a
// violation), intentional-asset prefixes preserved whatever they hold,
// and everything else is a violation.
export const REQUIRED_EMPTY_STORAGE_PREFIXES = ["receipts/", "vet-docs/"];
export const PRESERVE_STORAGE_PREFIXES = ["team-photos/", "db-backups/"];

// --- Injectable store handles ---------------------------------------------------

export interface LegacyAuthHandle {
  listUsers(): Promise<{ uid: string; email: string | null }[]>;
  deleteUser(uid: string): Promise<void>;
}

export interface LegacyFirestoreHandle {
  listCollections(): Promise<string[]>;
  listDocIds(collection: string): Promise<string[]>;
  deleteDoc(collection: string, id: string): Promise<void>;
}

export interface LegacyStorageHandle {
  listObjectNames(): Promise<string[]>;
}

export interface LegacyDeps {
  db: DemoDb;
  auth: LegacyAuthHandle;
  firestore: LegacyFirestoreHandle;
  storage: LegacyStorageHandle;
  // Extra emails considered bootstrap admins beyond admin_users rows
  // (the operator's ADMIN_EMAILS seed). Lowercased.
  adminEmails: string[];
}

// --- Audit report ----------------------------------------------------------------

export interface LegacyAudit {
  lifecycle: {
    state: string;
    liveAt: string | null;
    // 'live' initialized by the migration (live_at NULL) or already
    // flipped to 'prelaunch-demo' — both are inside the remediation
    // window. A live_at-stamped 'live' row means a real go-live
    // happened: window closed.
    windowOpen: boolean;
  };
  remove: {
    postgresAnimals: string[]; // expected ids still present
    firestoreAnimals: string[]; // expected doc ids still present
  };
  preserve: {
    postgresWindowRows: Record<string, number>;
    firestoreDocs: Record<string, number>;
    authUsers: number;
    storageObjects: Record<string, number>;
  };
  violations: string[];
  verdict: "safe" | "refused";
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: Record<string, unknown>[] }).rows ??
    []) as Record<string, unknown>[];
}

async function tableIds(db: DemoDb, table: string): Promise<string[]> {
  const r = await db.execute(sql.raw(`select id::text as id from "${table}"`));
  return rowsOf(r).map((row) => String(row.id));
}

async function tableCount(db: DemoDb, table: string): Promise<number> {
  const r = await db.execute(
    sql.raw(`select count(*)::int as n from "${table}"`),
  );
  return Number(rowsOf(r)[0]?.n ?? 0);
}

// Read lifecycle plus live_at — the remediation-window discriminator.
async function readLifecycleWithLiveAt(
  db: DemoDb,
): Promise<{ lifecycle: string; liveAt: string | null } | null> {
  const r = await db.execute(
    sql`select lifecycle, live_at from app_state where id = 1`,
  );
  const row = rowsOf(r)[0];
  if (!row) return null;
  return {
    lifecycle: String(row.lifecycle),
    liveAt: row.live_at
      ? row.live_at instanceof Date
        ? row.live_at.toISOString()
        : String(row.live_at)
      : null,
  };
}

export async function auditLegacyEnvironment(
  deps: LegacyDeps,
): Promise<LegacyAudit> {
  const violations: string[] = [];
  const report: LegacyAudit = {
    lifecycle: { state: "absent", liveAt: null, windowOpen: false },
    remove: { postgresAnimals: [], firestoreAnimals: [] },
    preserve: {
      postgresWindowRows: {},
      firestoreDocs: {},
      authUsers: 0,
      storageObjects: {},
    },
    violations,
    verdict: "refused",
  };

  // --- Lifecycle window ---
  const row = await readLifecycleWithLiveAt(deps.db);
  if (!row) {
    report.lifecycle = {
      state: "absent → live",
      liveAt: null,
      windowOpen: false,
    };
    violations.push(
      "app_state row is absent — resolves to 'live'; not the audited remediation state",
    );
  } else {
    const windowOpen =
      (row.lifecycle === "live" && row.liveAt === null) ||
      row.lifecycle === "prelaunch-demo";
    report.lifecycle = {
      state: row.lifecycle,
      liveAt: row.liveAt,
      windowOpen,
    };
    if (!windowOpen) {
      violations.push(
        `app_state lifecycle='${row.lifecycle}' with live_at=${row.liveAt} — ` +
          "a real go-live already happened; the remediation window is closed",
      );
    }
  }

  // --- Postgres: domain tables ---
  // Every domain table must be empty except `animals`, which may only
  // hold the exact expected legacy fixture ids.
  const domains = await domainTables(deps.db);
  for (const table of domains) {
    const n = await tableCount(deps.db, table);
    if (n === 0) continue;
    if (table === "animals") {
      const ids = await tableIds(deps.db, "animals");
      const expected = LEGACY_PG_ANIMAL_IDS as readonly string[];
      const unexpected = ids.filter((id) => !expected.includes(id));
      report.remove.postgresAnimals = ids.filter((id) =>
        expected.includes(id),
      );
      if (unexpected.length > 0) {
        violations.push(
          `postgres.animals: ${unexpected.length} unexpected row(s) ` +
            `(ids ${unexpected.join(", ")})`,
        );
      }
    } else {
      violations.push(`postgres.${table}: ${n} unexpected row(s)`);
    }
  }

  // --- Postgres: preserved window tables — exact id sets ---
  for (const [table, expected] of Object.entries(EXPECTED_WINDOW_ROWS)) {
    if (expected.length === 0) {
      // Must-be-empty table (also covers tables without an `id`
      // column, e.g. household_members' composite PK).
      const n = await tableCount(deps.db, table);
      report.preserve.postgresWindowRows[table] = n;
      if (n > 0) {
        violations.push(`postgres.${table}: ${n} unexpected row(s)`);
      }
      continue;
    }
    const ids = await tableIds(deps.db, table);
    report.preserve.postgresWindowRows[table] = ids.length;
    const unexpected = ids.filter((id) => !expected.includes(id));
    if (unexpected.length > 0) {
      violations.push(
        `postgres.${table}: ${unexpected.length} row(s) outside the ` +
          `audited bootstrap set (ids ${unexpected.join(", ")})`,
      );
    }
  }

  // --- Postgres: bootstrap identity sets, used for Auth/Firestore
  // classification (counted, never printed) ---
  const adminRows = await deps.db.execute(
    sql`select lower(email) as email from admin_users`,
  );
  const adminEmails = new Set<string>([
    ...rowsOf(adminRows).map((r) => String(r.email)),
    ...deps.adminEmails,
  ]);
  // Operator sign-ins materialize auth_identities rows — a Firebase
  // Auth user whose uid already has an audited identity row is a known
  // operator account even when it isn't an admin (e.g. the owner's
  // non-admin portal login).
  const identityRows = await deps.db.execute(
    sql`select provider_uid from auth_identities`,
  );
  const knownAuthUids = new Set<string>(
    rowsOf(identityRows).map((r) => String(r.provider_uid)),
  );

  // --- Firestore ---
  const allowedCollections = new Set([
    ...Object.keys(EXPECTED_FS_REMOVE),
    ...Object.keys(EXPECTED_FS_PRESERVE),
    FS_ADMIN_COLLECTION,
  ]);
  for (const name of await deps.firestore.listCollections()) {
    if (!allowedCollections.has(name)) {
      const ids = await deps.firestore.listDocIds(name);
      violations.push(
        `firestore.${name}: unexpected collection (${ids.length} doc(s))`,
      );
      continue;
    }
    const ids = await deps.firestore.listDocIds(name);
    if (name in EXPECTED_FS_REMOVE) {
      const unexpected = ids.filter(
        (id) => !EXPECTED_FS_REMOVE[name].includes(id),
      );
      report.remove.firestoreAnimals = ids.filter((id) =>
        EXPECTED_FS_REMOVE[name].includes(id),
      );
      if (unexpected.length > 0) {
        violations.push(
          `firestore.${name}: ${unexpected.length} doc(s) outside the ` +
            `legacy fixture set (ids ${unexpected.join(", ")})`,
        );
      }
    } else if (name === FS_ADMIN_COLLECTION) {
      // Bootstrap admin config — every doc id is an admin email; any
      // doc outside the known admin set is unexpected.
      const unexpected = ids.filter((id) => !adminEmails.has(id.toLowerCase()));
      report.preserve.firestoreDocs[name] = ids.length;
      if (unexpected.length > 0) {
        violations.push(
          `firestore.${name}: ${unexpected.length} admin doc(s) not in ` +
            "the bootstrap admin set",
        );
      }
    } else {
      const unexpected = ids.filter(
        (id) => !EXPECTED_FS_PRESERVE[name].includes(id),
      );
      report.preserve.firestoreDocs[name] = ids.length;
      if (unexpected.length > 0) {
        violations.push(
          `firestore.${name}: ${unexpected.length} doc(s) outside the ` +
            `audited CMS set (ids ${unexpected.join(", ")})`,
        );
      }
    }
  }

  // --- Firebase Auth ---
  // Every user must be explainable as a bootstrap account: either its
  // email is in the admin set, or its uid matches an audited
  // auth_identities row (an operator sign-in identity). Anything else
  // is an unknown account and refuses — counts only, never PII.
  const users = await deps.auth.listUsers();
  const unknownUsers = users.filter(
    (u) =>
      !(u.email && adminEmails.has(u.email.toLowerCase())) &&
      !knownAuthUids.has(u.uid),
  );
  report.preserve.authUsers = users.length - unknownUsers.length;
  if (unknownUsers.length > 0) {
    violations.push(
      `firebase auth: ${unknownUsers.length} user(s) outside the ` +
        "bootstrap admin set — refusing (manual review required)",
    );
  }

  // --- Storage ---
  const objects = await deps.storage.listObjectNames();
  for (const name of objects) {
    if (REQUIRED_EMPTY_STORAGE_PREFIXES.some((p) => name.startsWith(p))) {
      violations.push(
        `storage: object under a must-be-empty prefix (${name})`,
      );
    } else if (
      PRESERVE_STORAGE_PREFIXES.some((p) => name.startsWith(p))
    ) {
      const prefix = PRESERVE_STORAGE_PREFIXES.find((p) =>
        name.startsWith(p),
      )!;
      report.preserve.storageObjects[prefix] =
        (report.preserve.storageObjects[prefix] ?? 0) + 1;
    } else {
      violations.push(`storage: unexpected object ${name}`);
    }
  }

  report.verdict = violations.length === 0 ? "safe" : "refused";
  return report;
}

// --- Apply ----------------------------------------------------------------------

export interface LegacyApplyResult {
  deletedPostgresAnimals: number;
  deletedFirestoreAnimals: number;
}

// Postgres half: delete the expected legacy animal rows inside one
// transaction. Verifies the affected count equals the ids actually
// present — a silent no-op delete would mean the audit and the write
// raced, so it throws instead.
export async function deleteLegacyPostgresAnimals(
  db: DemoDb,
  presentIds: string[],
): Promise<number> {
  if (presentIds.length === 0) return 0;
  const list = presentIds.map((id) => `'${id}'::uuid`).join(",");
  const r = await db.execute(
    sql.raw(`delete from animals where id in (${list})`),
  );
  const affected =
    (r as { count?: number; affectedRows?: number }).count ??
    (r as { affectedRows?: number }).affectedRows ??
    0;
  if (affected !== presentIds.length) {
    throw new Error(
      `expected to delete ${presentIds.length} legacy animal row(s), ` +
        `deleted ${affected} — state changed between audit and apply`,
    );
  }
  return affected;
}

export async function deleteLegacyFirestoreAnimals(
  firestore: LegacyFirestoreHandle,
  presentIds: string[],
): Promise<number> {
  for (const id of presentIds) {
    await firestore.deleteDoc("animals", id);
  }
  return presentIds.length;
}

// Re-export so the CLI can print the post-state lifecycle line.
export { readLifecycleRow };
