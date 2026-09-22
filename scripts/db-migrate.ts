// Apply checked-in Postgres migrations to a real database (#165).
//
//   npx tsx scripts/db-migrate.ts
//
// Requires DATABASE_URL_UNPOOLED — Neon's unpooled endpoint, provided
// by the Vercel–Neon integration. Schema DDL must not go through the
// PgBouncer transaction pooler (session-level migration bookkeeping is
// unreliable there). The runtime app uses the pooled DATABASE_URL
// instead; the two point at the same database.
//
// Safety:
// - fails fast when DATABASE_URL_UNPOOLED is unset (never guesses)
// - refuses hostnames that do not look like Postgres URLs at all
// - idempotent: drizzle's __drizzle_migrations journal makes replay a
//   no-op when the database is already current
// - prints which migrations were applied, never row data

import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { runMigrationsOnPostgres } from "../src/lib/db/migrate";

// Operators paste the target's DATABASE_URL_UNPOOLED into .env.local
// (gitignored) so the value never has to appear in a command line,
// ticket, or chat. Existing process env still wins if already set.
config({ path: ".env.local" });

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    console.error(
      "DATABASE_URL_UNPOOLED is not set. Point it at the Neon unpooled " +
        "endpoint for the target project (see ARCHITECTURE.md §11).",
    );
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error(
      "DATABASE_URL_UNPOOLED does not look like a Postgres connection string. Refusing to run.",
    );
    process.exit(1);
  }

  const parsed = new URL(url);
  console.log(
    `Applying migrations to host=${parsed.hostname} ` +
      `db=${parsed.pathname.replace("/", "")} user=${parsed.username} ` +
      "(drizzle/ journal is the source of truth)...",
  );

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
