// Migration replay for the Postgres registry (#165).
//
// Applies the checked-in SQL migrations in drizzle/ in order. Used by:
//   - scripts/db-migrate.ts   (operator/CI against a real database)
//   - tests/db/*              (PGlite, replay-from-empty proof)
//
// Safety properties:
// - migrations are the only path to schema change — no drizzle-kit push
// - replay is idempotent: drizzle tracks applied migrations in
//   __drizzle_migrations, so re-running is a no-op
// - the runner never touches production implicitly: callers must pass an
//   explicit database target

import { migrate as migratePostgresJs } from "drizzle-orm/postgres-js/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgliteDatabase } from "drizzle-orm/pglite";

export const MIGRATIONS_FOLDER = "drizzle";

export async function runMigrationsOnPostgres<
  TSchema extends Record<string, unknown>,
>(db: PostgresJsDatabase<TSchema>): Promise<void> {
  await migratePostgresJs(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export async function runMigrationsOnPglite<
  TSchema extends Record<string, unknown>,
>(db: PgliteDatabase<TSchema>): Promise<void> {
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
