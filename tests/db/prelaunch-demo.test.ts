// Pre-launch demo lifecycle tests (#275), against PGlite. These cover
// the Postgres half of the lifecycle: the single-row app_state
// lifecycle (including the database trigger that makes 'live' final),
// the empty-domain seed gate, the demo-window reset model, and the
// verify-clean report — plus the demo dataset itself (it must apply
// cleanly against the real schema and produce deterministic dates).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";
import {
  activeSeedRun,
  domainTables,
  findNonEmptyDomainTables,
  latestSeedRun,
  readLifecycleRow,
  requirePrelaunchLifecycle,
  resetPostgresDemo,
  verifyPostgresClean,
  DemoRefusal,
  TOOLING_TABLES,
  WINDOW_DELETE_TABLES,
  EPHEMERAL_TABLES,
} from "../../scripts/lib/demo-db";
import {
  applyDemoPostgresSeed,
  DEMO_SEED_VERSION,
} from "../../scripts/lib/demo-seed";

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

// A clean database in demo posture before each test. TRUNCATE bypasses
// row triggers by design, which is also how the test can re-engage
// 'prelaunch-demo' after a go-live test froze a row.
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
  await db.execute(
    sql`insert into app_state (id, lifecycle) values (1, 'prelaunch-demo')`,
  );
});

const SEED_CTX = {
  adminUid: "demo-admin-uid",
  ownerUid: "demo-owner-uid",
  userUid: "demo-user-uid",
  asOf: "2026-09-23",
};

async function beginRun() {
  const r = await db.execute(
    sql`insert into demo_seed_runs (seed_version, empty_firestore_collections, empty_storage_prefixes)
        values (${DEMO_SEED_VERSION}, '["faq"]'::jsonb, '["receipts/"]'::jsonb)
        returning id, seeded_at`,
  );
  const rows = (r as unknown as { rows: { id: string; seeded_at: string }[] })
    .rows;
  return rows[0];
}

describe("lifecycle state", () => {
  test("fresh migrations create the app_state row in prelaunch-demo", async () => {
    const row = await readLifecycleRow(db);
    expect(row?.lifecycle).toBe("prelaunch-demo");
  });

  test("a missing app_state row resolves to 'live' (fail-safe)", async () => {
    await db.execute(sql`truncate app_state`);
    const row = await readLifecycleRow(db);
    expect(row).toBeNull();
    // resolveAppLifecycle in src/lib/app-lifecycle.ts maps absent → live.
    await expect(requirePrelaunchLifecycle(db)).rejects.toBeInstanceOf(
      DemoRefusal,
    );
  });

  test("requirePrelaunchLifecycle accepts demo posture, refuses live", async () => {
    await expect(requirePrelaunchLifecycle(db)).resolves.toBeUndefined();
    await db.execute(sql`update app_state set lifecycle = 'live'`);
    await expect(requirePrelaunchLifecycle(db)).rejects.toBeInstanceOf(
      DemoRefusal,
    );
  });

  test("the live lifecycle is final — UPDATE and DELETE are rejected by the trigger", async () => {
    await db.execute(
      sql`update app_state set lifecycle = 'live', live_at = now()`,
    );

    await expect(
      db.execute(sql`update app_state set lifecycle = 'prelaunch-demo'`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`update app_state set demo_seeded_at = now()`),
    ).rejects.toThrow();
    await expect(db.execute(sql`delete from app_state`)).rejects.toThrow();

    // And the state is still live.
    const row = await readLifecycleRow(db);
    expect(row?.lifecycle).toBe("live");
  });
});

describe("empty-domain gate", () => {
  test("domainTables excludes tooling, window, and ephemeral tables", async () => {
    const domains = await domainTables(db);
    for (const exempt of [
      ...TOOLING_TABLES,
      ...WINDOW_DELETE_TABLES,
      ...EPHEMERAL_TABLES,
    ]) {
      expect(domains).not.toContain(exempt);
    }
    // And it does include the registry authority tables.
    for (const core of ["animals", "registrations", "payments"]) {
      expect(domains).toContain(core);
    }
  });

  test("window-table rows (pre-seed identities) do not block the gate", async () => {
    await db.insert(schema.persons).values({ fullName: "Pre-seed Staff" });
    await db.insert(schema.auditEvents).values({
      actorLabel: "Staff",
      entityType: "animal",
      entityId: "x",
      action: "update",
    });
    const nonEmpty = await findNonEmptyDomainTables(db);
    expect(nonEmpty).toEqual({});
  });

  test("domain rows block the gate and are reported by table, not by content", async () => {
    await db.insert(schema.animals).values({
      name: "Real Dog",
      species: "dog",
      sex: "male",
    });
    const nonEmpty = await findNonEmptyDomainTables(db);
    expect(nonEmpty.animals).toBe(1);
  });
});

describe("seed → reset → verify-clean", () => {
  test("the demo dataset applies cleanly and records a manifest", async () => {
    const seed = await applyDemoPostgresSeed(db, SEED_CTX);
    expect(seed.counts.animals).toBe(19);
    expect(seed.counts.persons).toBe(11);
    expect(seed.counts.registrations).toBe(16);
    expect(seed.counts.payments).toBe(9);
    expect(seed.counts.vaccinations).toBe(10);
    expect(seed.entities.length).toBeGreaterThan(100);
    expect(seed.entities.every((e) => e.store === "postgres")).toBe(true);
  });

  test("seeded dates are deterministic and relative to asOf", async () => {
    await applyDemoPostgresSeed(db, SEED_CTX);
    // Captain's rabies vaccination is seeded overdue by 20 days.
    const r = await db.execute(
      sql`select due_on from vaccinations v
          join animals a on a.id = v.animal_id
          where a.name = 'Captain' and v.vaccine_name = 'Rabies'`,
    );
    const rows = (r as unknown as { rows: { due_on: string }[] }).rows;
    expect(rows[0].due_on).toBe("2026-09-03");
  });

  test("reset removes seeded rows AND demo-window rows, keeps pre-seed rows", async () => {
    // A pre-seed staff identity — must survive reset.
    const [preSeedPerson] = await db
      .insert(schema.persons)
      .values({
        fullName: "Pre-seed Operator",
        email: "operator@example.com",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      })
      .returning();

    const run = await beginRun();
    const seed = await applyDemoPostgresSeed(db, SEED_CTX);

    // Manifest rows the CLI would write for non-postgres stores.
    await db.execute(
      sql`insert into demo_seed_entities (run_id, entity_store, entity_table, entity_id)
          values (${run.id}, 'auth', 'users', 'demo-admin-uid')`,
    );

    // Board experimentation inside the window: a brand-new animal and a
    // new person created AFTER the seed ran.
    const [windowPerson] = await db
      .insert(schema.persons)
      .values({ fullName: "Board-created Person" })
      .returning();
    const [windowAnimal] = await db
      .insert(schema.animals)
      .values({ name: "Board Dog", species: "dog", sex: "female" })
      .returning();

    const report = await resetPostgresDemo(db, run.seeded_at);

    // Domain tables truncated wholesale.
    expect(report.truncatedTables).toContain("animals");
    const animals = await db.execute(
      sql`select count(*)::int as n from animals`,
    );
    expect(
      Number((animals as unknown as { rows: { n: number }[] }).rows[0].n),
    ).toBe(0);

    // Seeded audit rows fall inside the demo window and are gone too
    // (a backdated created_at would escape the window predicate).
    const audits = await db.execute(
      sql`select count(*)::int as n from audit_events`,
    );
    expect(
      Number((audits as unknown as { rows: { n: number }[] }).rows[0].n),
    ).toBe(0);

    // The pre-seed person survived; the window person did not.
    const persons = await db.execute(
      sql`select id from persons`,
    );
    const ids = (persons as unknown as { rows: { id: string }[] }).rows.map(
      (r) => r.id,
    );
    expect(ids).toContain(preSeedPerson.id);
    expect(ids).not.toContain(windowPerson.id);
    expect(ids).toHaveLength(1);
    void windowAnimal;

    // Manifest cleared and run marked reset.
    const manifest = await db.execute(
      sql`select count(*)::int as n from demo_seed_entities`,
    );
    expect(
      Number((manifest as unknown as { rows: { n: number }[] }).rows[0].n),
    ).toBe(0);
    const after = await latestSeedRun(db);
    expect(after?.resetAt).not.toBeNull();

    // Verify-clean confirms nothing remains.
    const clean = await verifyPostgresClean(db, run.seeded_at);
    expect(clean.domainResiduals).toEqual({});
    expect(clean.windowResiduals).toEqual({});
    expect(clean.manifestResidual).toBe(0);
    void seed;
  });

  test("verify-clean catches leftovers a partial reset missed", async () => {
    const run = await beginRun();
    await applyDemoPostgresSeed(db, SEED_CTX);
    // Simulate a partial cleanup: drop the person/owner layer.
    // (TRUNCATE CASCADE also wipes their FK dependents — ownerships,
    // submissions, registrations — while the animal side stays put, so
    // an animals row is a guaranteed leftover. registration_submissions
    // gained an animal FK in #297, so the animals side is no longer a
    // surviving residual when the tree is cut at animals.)
    await db.execute(sql`truncate persons cascade`);
    const clean = await verifyPostgresClean(db, run.seeded_at);
    expect(Object.keys(clean.domainResiduals).length).toBeGreaterThan(0);
    expect(clean.domainResiduals.persons).toBeUndefined(); // window table
    expect(clean.domainResiduals.animals).toBeGreaterThan(0);
  });

  test("an active seed run is visible until reset, then historical", async () => {
    const run = await beginRun();
    const active = await activeSeedRun(db);
    expect(active?.id).toBe(run.id);
    await db.execute(
      sql`update demo_seed_runs set reset_at = now() where id = ${run.id}`,
    );
    expect(await activeSeedRun(db)).toBeNull();
  });
});
