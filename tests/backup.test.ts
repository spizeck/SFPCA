// Unit tests for the backup/restore helpers in scripts/lib/db-backup-lib.ts (#180).
// Run via `npm test` (no Neon/Storage/Postgres needed — pure functions).
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  backupObjectName,
  pickBackupDatabaseUrl,
  staleBackupObjects,
  urlHost,
  BACKUP_PREFIX,
  BACKUP_RETENTION_COUNT,
} from "../scripts/lib/db-backup-lib";

// --- Object naming ----------------------------------------------------------

test("backup object names live under db-backups/ and sort chronologically", () => {
  const a = backupObjectName(new Date("2026-01-01T00:00:00Z"));
  const b = backupObjectName(new Date("2026-06-15T04:30:05Z"));
  assert.ok(a.startsWith(BACKUP_PREFIX) && a.endsWith(".dump"));
  assert.ok(b.startsWith(BACKUP_PREFIX) && b.endsWith(".dump"));
  assert.ok(a < b, "lexical order must equal chronological order");
  assert.match(a, /^db-backups\/registry-\d{8}-\d{6}Z\.dump$/);
});

// --- Retention --------------------------------------------------------------

test("retention keeps the newest N and prunes the oldest", () => {
  const names = Array.from({ length: 10 }, (_, i) =>
    backupObjectName(new Date(Date.UTC(2026, 0, i + 1))),
  );
  const stale = staleBackupObjects(names);
  assert.equal(stale.length, 10 - BACKUP_RETENTION_COUNT);
  assert.deepEqual(
    stale,
    names.slice(0, 2),
    "oldest objects are pruned first",
  );
  // Newest 8 retained
  for (const keep of names.slice(2)) assert.ok(!stale.includes(keep));
});

test("retention ignores non-backup objects under the prefix", () => {
  const names = [
    "db-backups/README.txt",
    "db-backups/nested/thing.dump", // still matches prefix+suffix…
    backupObjectName(new Date("2026-01-01T00:00:00Z")),
    backupObjectName(new Date("2026-01-02T00:00:00Z")),
  ];
  const stale = staleBackupObjects(names, 1);
  // README is not a .dump — never touched. nested .dump counts as a backup.
  assert.ok(!stale.includes("db-backups/README.txt"));
});

test("retention never yields a negative result", () => {
  assert.deepEqual(staleBackupObjects([], 8), []);
  assert.deepEqual(
    staleBackupObjects([`${BACKUP_PREFIX}registry-20260101-000000Z.dump`], 8),
    [],
  );
});

// --- Database URL selection ---------------------------------------------------

test("pickBackupDatabaseUrl prefers the dedicated backup URL", () => {
  const env = {
    BACKUP_DATABASE_URL: "postgresql://backup-host/db",
    DATABASE_URL_UNPOOLED: "postgresql://unpooled-host/db",
    DATABASE_URL: "postgresql://pooled-host/db",
  };
  const picked = pickBackupDatabaseUrl(env);
  assert.equal(picked?.source, "BACKUP_DATABASE_URL");
  assert.equal(picked?.url, "postgresql://backup-host/db");
});

test("pickBackupDatabaseUrl falls back unpooled then pooled", () => {
  const unpooled = pickBackupDatabaseUrl({
    DATABASE_URL_UNPOOLED: "postgresql://unpooled-host/db",
    DATABASE_URL: "postgresql://pooled-host/db",
  });
  assert.equal(unpooled?.source, "DATABASE_URL_UNPOOLED");

  const pooled = pickBackupDatabaseUrl({
    DATABASE_URL: "postgresql://pooled-host/db",
  });
  assert.equal(pooled?.source, "DATABASE_URL");
});

test("pickBackupDatabaseUrl rejects non-Postgres and missing values", () => {
  assert.equal(pickBackupDatabaseUrl({}), null);
  assert.equal(
    pickBackupDatabaseUrl({ BACKUP_DATABASE_URL: "https://not-a-db" }),
    null,
  );
  assert.equal(
    pickBackupDatabaseUrl({ BACKUP_DATABASE_URL: "" }),
    null,
  );
});

// --- Logging hygiene ----------------------------------------------------------

test("urlHost returns only the hostname", () => {
  assert.equal(
    urlHost("postgresql://user:s3cret@ep-example-123.us-east-1.aws.neon.tech/neondb?sslmode=require"),
    "ep-example-123.us-east-1.aws.neon.tech",
  );
  assert.equal(urlHost("not a url"), "(unparseable URL)");
});
