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
    client = postgres(process.env.DATABASE_URL!, {
      // Serverless: many short-lived function instances share the Neon
      // pooler — keep per-instance pools tiny and avoid holding idle
      // connections open.
      max: 3,
      prepare: false, // required through PgBouncer transaction pooling
    });
    db = drizzle(client, { schema });
  }
  return db;
}

export { schema };
