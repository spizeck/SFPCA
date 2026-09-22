// Apply checked-in Postgres migrations to a real database (#165).
//
//   npx tsx scripts/db-migrate.ts
//
// Requires DIRECT_DATABASE_URL — Neon's UNPOOLED endpoint. Schema DDL
// must not go through the PgBouncer transaction pooler (session-level
// migration bookkeeping is unreliable there). The runtime app uses the
// pooled DATABASE_URL instead; the two point at the same database.
//
// Safety:
// - fails fast when DIRECT_DATABASE_URL is unset (never guesses)
// - refuses hostnames that do not look like Postgres URLs at all
// - idempotent: drizzle's __drizzle_migrations journal makes replay a
//   no-op when the database is already current
// - prints which migrations were applied, never row data

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { runMigrationsOnPostgres } from "../src/lib/db/migrate";

async function main() {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    console.error(
      "DIRECT_DATABASE_URL is not set. Point it at the Neon unpooled " +
        "endpoint for the target project (see docs/architecture/persistence.md).",
    );
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error(
      "DIRECT_DATABASE_URL does not look like a Postgres connection string. Refusing to run.",
    );
    process.exit(1);
  }

  const host = new URL(url).hostname;
  console.log(`Applying migrations to ${host} (drizzle/ journal is the source of truth)...`);

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await runMigrationsOnPostgres(drizzle(sql));
    console.log("Migrations applied (or already current).");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  // Surface the migration error without connection-string details.
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
