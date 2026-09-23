import "server-only";

// Postgres client for the registry domain (#165). Server-only — client
// components must never reach for the database directly; they go through
// domain services in src/lib/registry/* which return DTOs.
//
// DATABASE_URL is the pooled Neon endpoint (PgBouncer) for runtime
// queries. Migrations use DATABASE_URL_UNPOOLED instead (see
// src/lib/db/migrate.ts) — PgBouncer transaction pooling is not safe for
// schema migration DDL sessions.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type RegistryDb = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql | null = null;
let db: RegistryDb | null = null;

export function missingDatabaseEnvVars(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return env.DATABASE_URL ? [] : ["DATABASE_URL"];
}

// Lazily create the pooled client so importing this module in a context
// without DATABASE_URL (e.g. build-time prerender of a page that never
// queries the registry) does not crash — only an actual query fails.
export function getRegistryDb(): RegistryDb {
  if (!db) {
    const missing = missingDatabaseEnvVars();
    if (missing.length > 0) {
      throw new Error(
        `Postgres registry is not configured: missing env var(s) ${missing.join(", ")}`,
      );
    }
    // Pool size is an env knob because the E2E harness (and any dev
    // setup pointed at a PGlite socket server) must serialize all
    // queries onto ONE connection: pglite-socket forwards protocol
    // messages per-message, so concurrent connections can interleave
    // extended-protocol sequences and corrupt unnamed statements.
    // Production leaves it unset → 3.
    const configuredMax = Number.parseInt(
      process.env.DATABASE_POOL_MAX ?? "",
      10,
    );
    const max =
      Number.isInteger(configuredMax) && configuredMax >= 1
        ? Math.min(configuredMax, 10)
        : 3;
    client = postgres(process.env.DATABASE_URL!, {
      // Serverless: many short-lived function instances share the Neon
      // pooler — keep per-instance pools tiny and avoid holding idle
      // connections open.
      max,
      prepare: false, // required through PgBouncer transaction pooling
    });
    db = drizzle(client, { schema });
  }
  return db;
}

export { schema };
