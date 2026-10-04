// One-time pre-launch legacy-seed remediation tests (#278), PGlite +
// injected Firebase fakes. Covers both halves of the remediation:
//   - the cleanup audit/apply logic (scripts/lib/prelaunch-legacy.ts):
//     exact-shape verification, remove/preserve classification,
//     fail-closed refusals on any unexpected record, idempotent apply;
//   - migration 0024 (drizzle/0024_prelaunch-legacy-remediation.sql)
//     replayed verbatim: the one-time live→prelaunch-demo correction,
//     its preconditions, and the re-armed finality trigger.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  auditLegacyEnvironment,
  deleteLegacyPostgresAnimals,
  deleteLegacyFirestoreAnimals,
  LEGACY_PG_ANIMAL_IDS,
  LEGACY_FS_ANIMAL_IDS,
  EXPECTED_WINDOW_ROWS,
  type LegacyDeps,
} from "../../scripts/lib/prelaunch-legacy";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  const result = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = (result as unknown as { rows: { tablename: string }[] }).rows;
  await db.execute(
    sql.raw(
      `truncate table ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
});

// --- Migration 0024 verbatim replay -----------------------------------------

function migration0024Statements(): string[] {
  const raw = readFileSync(
    join("drizzle", "0024_prelaunch-legacy-remediation.sql"),
    "utf8",
  );
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration0024() {
  for (const statement of migration0024Statements()) {
    await db.execute(sql.raw(statement));
  }
}

async function lifecycleState(): Promise<{
  lifecycle: string;
  live_at: string | null;
}> {
  const r = await db.execute(
    sql`select lifecycle, live_at::text as live_at from app_state where id = 1`,
  );
  return (r as unknown as { rows: { lifecycle: string; live_at: string | null }[] })
    .rows[0];
}

// --- Audited fixture -------------------------------------------------------

const ADMIN_EMAILS = ["a1@example.com", "a2@example.com", "a3@example.com", "a4@example.com"];

// Build the exact audited production shape (issue #278) on a fresh DB:
// live-initialized app_state, the 3 legacy animals, and the preserved
// bootstrap window rows.
async function seedAuditedFixture() {
  await db.execute(
    sql`insert into app_state (id, lifecycle) values (1, 'live')`,
  );
  for (const id of LEGACY_PG_ANIMAL_IDS) {
    await db.insert(schema.animals).values({
      id,
      name: "Legacy Fixture",
      species: "dog",
      sex: "male",
    });
  }
  for (const [i, id] of EXPECTED_WINDOW_ROWS.persons.entries()) {
    await db.insert(schema.persons).values({ id, fullName: `Operator ${i}` });
  }
  for (const [i, id] of EXPECTED_WINDOW_ROWS.admin_users.entries()) {
    await db.insert(schema.adminUsers).values({
      id,
      email: ADMIN_EMAILS[i],
      role: "admin",
    });
  }
  for (const [i, id] of EXPECTED_WINDOW_ROWS.auth_identities.entries()) {
    await db.insert(schema.authIdentities).values({
      id,
      provider: "firebase",
      providerUid: `u${i}`,
      email: ADMIN_EMAILS[i],
    });
  }
  for (const id of EXPECTED_WINDOW_ROWS.audit_events) {
    await db.insert(schema.auditEvents).values({
      id,
      entityType: "person",
      entityId: "x",
      action: "create",
    });
  }
}

// Injected fakes matching the audited non-Postgres stores.
function makeDeps(overrides: {
  authEmails?: string[];
  firestore?: Record<string, string[]>;
  storage?: string[];
} = {}): LegacyDeps & { firestoreDocs: Record<string, string[]> } {
  const firestoreDocs: Record<string, string[]> = overrides.firestore ?? {
    animals: [...LEGACY_FS_ANIMAL_IDS],
    admins: [...ADMIN_EMAILS],
    homepage: ["main"],
    siteSettings: ["global"],
    faq: ["CBpxldUiBQRsRFLG04Oc", "main"],
  };
  return {
    db,
    auth: {
      listUsers: async () =>
        (overrides.authEmails ?? ADMIN_EMAILS).map((email, i) => ({
          uid: `u${i}`,
          email,
        })),
      deleteUser: async () => {},
    },
    firestore: {
      listCollections: async () => Object.keys(firestoreDocs),
      listDocIds: async (c) => firestoreDocs[c] ?? [],
      deleteDoc: async (c, id) => {
        firestoreDocs[c] = (firestoreDocs[c] ?? []).filter((x) => x !== id);
      },
    },
    storage: {
      listObjectNames: async () =>
        overrides.storage ?? [
          "team-photos/a.png",
          "team-photos/b.png",
          "team-photos/c.jpg",
          "db-backups/registry-1.dump",
          "db-backups/registry-2.dump",
        ],
    },
    adminEmails: [],
    firestoreDocs,
  };
}

async function count(table: string): Promise<number> {
  const r = await db.execute(
    sql.raw(`select count(*)::int as n from "${table}"`),
  );
  return Number((r as unknown as { rows: { n: number }[] }).rows[0].n);
}

// --- Tests: migration 0024 ---------------------------------------------------

describe("migration 0024 — one-time lifecycle correction", () => {
  test("a fresh database migrated to current lands in prelaunch-demo (0024 no-ops)", async () => {
    // beforeAll already ran the full journal including 0024 on an
    // empty DB: 0023 seeds 'prelaunch-demo', 0024 must leave it alone.
    await db.execute(
      sql`insert into app_state (id, lifecycle) values (1, 'prelaunch-demo')`,
    );
    await runMigration0024();
    expect((await lifecycleState()).lifecycle).toBe("prelaunch-demo");
  });

  test("flips live→prelaunch-demo when live-initialized and domain is empty", async () => {
    await db.execute(sql`insert into app_state (id, lifecycle) values (1, 'live')`);
    await runMigration0024();
    expect((await lifecycleState()).lifecycle).toBe("prelaunch-demo");

    // The finality trigger is re-armed: going live is allowed, coming
    // back is not.
    await db.execute(sql`update app_state set lifecycle = 'live', live_at = now()`);
    await expect(
      db.execute(sql`update app_state set lifecycle = 'prelaunch-demo'`),
    ).rejects.toThrow();
    const trigger = await db.execute(
      sql`select count(*)::int as n from pg_trigger where tgname = 'app_state_live_is_final'`,
    );
    expect(
      Number((trigger as unknown as { rows: { n: number }[] }).rows[0].n),
    ).toBe(1);
  });

  test("refuses when a domain table still holds records", async () => {
    await db.execute(sql`insert into app_state (id, lifecycle) values (1, 'live')`);
    await db.insert(schema.animals).values({
      name: "Leftover",
      species: "dog",
      sex: "male",
    });
    await expect(runMigration0024()).rejects.toThrow(/still holds/);
    // Whole migration rolled back: still live, trigger intact.
    expect((await lifecycleState()).lifecycle).toBe("live");
  });

  test("skips a properly-live database even with data (live_at stamped)", async () => {
    await db.execute(
      sql`insert into app_state (id, lifecycle, live_at) values (1, 'live', now())`,
    );
    await db.insert(schema.animals).values({
      name: "Real Dog",
      species: "dog",
      sex: "female",
    });
    await runMigration0024(); // no-op, no error
    expect((await lifecycleState()).lifecycle).toBe("live");
  });

  test("window/tooling-table rows do not block the correction", async () => {
    await db.execute(sql`insert into app_state (id, lifecycle) values (1, 'live')`);
    await db.insert(schema.persons).values({ fullName: "Operator" });
    await db.insert(schema.adminUsers).values({
      email: "op@example.com",
      role: "admin",
    });
    await db.insert(schema.auditEvents).values({
      entityType: "person",
      entityId: "x",
      action: "create",
    });
    await runMigration0024();
    expect((await lifecycleState()).lifecycle).toBe("prelaunch-demo");
  });
});

// --- Tests: cleanup audit ----------------------------------------------------

describe("legacy cleanup audit", () => {
  test("the exact audited fixture passes: verdict safe, correct remove/preserve", async () => {
    await seedAuditedFixture();
    const a = await auditLegacyEnvironment(makeDeps());
    expect(a.violations).toEqual([]);
    expect(a.verdict).toBe("safe");
    expect(a.lifecycle.windowOpen).toBe(true);
    expect(a.remove.postgresAnimals.sort()).toEqual(
      [...LEGACY_PG_ANIMAL_IDS].sort(),
    );
    expect(a.remove.firestoreAnimals.sort()).toEqual(
      [...LEGACY_FS_ANIMAL_IDS].sort(),
    );
    expect(a.preserve.postgresWindowRows.persons).toBe(2);
    expect(a.preserve.postgresWindowRows.admin_users).toBe(4);
    expect(a.preserve.authUsers).toBe(4);
  });

  test("an unexpected extra animal refuses", async () => {
    await seedAuditedFixture();
    await db.insert(schema.animals).values({
      name: "Real Dog",
      species: "dog",
      sex: "male",
    });
    const a = await auditLegacyEnvironment(makeDeps());
    expect(a.verdict).toBe("refused");
    expect(a.violations.some((v) => v.includes("postgres.animals"))).toBe(true);
  });

  test("an unexpected person refuses (window tables are exact-match too)", async () => {
    await seedAuditedFixture();
    await db.insert(schema.persons).values({ fullName: "Unknown Person" });
    const a = await auditLegacyEnvironment(makeDeps());
    expect(a.verdict).toBe("refused");
    expect(a.violations.some((v) => v.includes("postgres.persons"))).toBe(true);
  });

  test("an unexpected registration submission refuses", async () => {
    await seedAuditedFixture();
    await db.insert(schema.registrationSubmissions).values({
      ownerName: "Unexpected Owner",
    });
    const a = await auditLegacyEnvironment(makeDeps());
    expect(a.verdict).toBe("refused");
    expect(
      a.violations.some((v) => v.includes("registration_submissions")),
    ).toBe(true);
  });

  test("an auth user whose uid has an audited identity row is preserved", async () => {
    await seedAuditedFixture();
    // The owner's non-admin portal login: email is NOT in the admin
    // set, but uid u0 matches an expected auth_identities row.
    const deps = makeDeps();
    deps.auth.listUsers = async () => [
      ...ADMIN_EMAILS.map((email, i) => ({ uid: `x${i}`, email })),
      { uid: "u0", email: "owner-portal@example.com" },
    ];
    const a = await auditLegacyEnvironment(deps);
    expect(a.violations).toEqual([]);
    expect(a.verdict).toBe("safe");
    expect(a.preserve.authUsers).toBe(5);
  });

  test("an unknown Firebase Auth user refuses", async () => {
    await seedAuditedFixture();
    const a = await auditLegacyEnvironment(
      makeDeps({ authEmails: [...ADMIN_EMAILS, "stranger@example.com"] }),
    );
    expect(a.verdict).toBe("refused");
    expect(a.violations.some((v) => v.includes("firebase auth"))).toBe(true);
  });

  test("an unexpected Firestore collection refuses", async () => {
    await seedAuditedFixture();
    const deps = makeDeps();
    deps.firestoreDocs.unknownCollection = ["doc1"];
    const a = await auditLegacyEnvironment(deps);
    expect(a.verdict).toBe("refused");
    expect(a.violations.some((v) => v.includes("firestore.unknownCollection"))).toBe(true);
  });

  test("a Firestore animals doc outside the fixture set refuses", async () => {
    await seedAuditedFixture();
    const deps = makeDeps();
    deps.firestoreDocs.animals.push("extraDoc");
    const a = await auditLegacyEnvironment(deps);
    expect(a.verdict).toBe("refused");
  });

  test("a Storage object under a must-be-empty prefix refuses", async () => {
    await seedAuditedFixture();
    const a = await auditLegacyEnvironment(
      makeDeps({ storage: ["receipts/abc.pdf"] }),
    );
    expect(a.verdict).toBe("refused");
    expect(a.violations.some((v) => v.includes("storage"))).toBe(true);
  });

  test("a Storage object under an unknown prefix refuses", async () => {
    await seedAuditedFixture();
    const a = await auditLegacyEnvironment(
      makeDeps({ storage: ["misc/mystery.bin"] }),
    );
    expect(a.verdict).toBe("refused");
  });

  test("a live_at-stamped 'live' row closes the remediation window", async () => {
    await seedAuditedFixture();
    // Stamp live_at directly — the trigger only guards UPDATE of a
    // live row's... actually the row IS live, so UPDATE is blocked.
    // Rebuild the row the way transitionToLive leaves it:
    await db.execute(sql`truncate app_state`);
    await db.execute(
      sql`insert into app_state (id, lifecycle, live_at) values (1, 'live', now())`,
    );
    const a = await auditLegacyEnvironment(makeDeps());
    expect(a.lifecycle.windowOpen).toBe(false);
    expect(a.violations.some((v) => v.includes("remediation window"))).toBe(true);
  });
});

// --- Tests: cleanup apply ------------------------------------------------------

describe("legacy cleanup apply", () => {
  test("removes only the expected fixture rows and preserves everything else", async () => {
    await seedAuditedFixture();
    const deps = makeDeps();
    const audit = await auditLegacyEnvironment(deps);
    expect(audit.verdict).toBe("safe");

    const pgDeleted = await db.transaction(async (tx) =>
      deleteLegacyPostgresAnimals(tx, audit.remove.postgresAnimals),
    );
    const fsDeleted = await deleteLegacyFirestoreAnimals(
      deps.firestore,
      audit.remove.firestoreAnimals,
    );
    expect(pgDeleted).toBe(3);
    expect(fsDeleted).toBe(3);

    // Postgres: only animals emptied; window rows preserved.
    expect(await count("animals")).toBe(0);
    expect(await count("persons")).toBe(2);
    expect(await count("admin_users")).toBe(4);
    expect(await count("auth_identities")).toBe(2);
    expect(await count("audit_events")).toBe(4);

    // Firestore: animals gone; CMS + admins intact.
    expect(deps.firestoreDocs.animals).toEqual([]);
    expect(deps.firestoreDocs.homepage).toEqual(["main"]);
    expect(deps.firestoreDocs.siteSettings).toEqual(["global"]);
    expect(deps.firestoreDocs.faq.sort()).toEqual(
      ["CBpxldUiBQRsRFLG04Oc", "main"].sort(),
    );
    expect(deps.firestoreDocs.admins).toEqual(ADMIN_EMAILS);

    // Re-audit is still safe with empty remove sets (idempotent).
    const after = await auditLegacyEnvironment(deps);
    expect(after.verdict).toBe("safe");
    expect(after.remove.postgresAnimals).toEqual([]);
    expect(after.remove.firestoreAnimals).toEqual([]);

    // And the lifecycle correction now applies cleanly.
    await runMigration0024();
    expect((await lifecycleState()).lifecycle).toBe("prelaunch-demo");
  });

  test("a partial remove set is handled idempotently", async () => {
    await seedAuditedFixture();
    // Simulate a previous partial run: one pg animal already gone.
    await db.execute(
      sql`delete from animals where id = ${LEGACY_PG_ANIMAL_IDS[0]}`,
    );
    const deps = makeDeps();
    deps.firestoreDocs.animals = LEGACY_FS_ANIMAL_IDS.slice(1);
    const audit = await auditLegacyEnvironment(deps);
    expect(audit.verdict).toBe("safe");
    const pgDeleted = await deleteLegacyPostgresAnimals(
      db,
      audit.remove.postgresAnimals,
    );
    expect(pgDeleted).toBe(2);
    expect(await count("animals")).toBe(0);
  });
});
