import { defineConfig } from "drizzle-kit";

// Drizzle schema/migration config for the Postgres registry (#165).
// `drizzle-kit generate` emits deterministic SQL into drizzle/; replay is
// done by src/lib/db/migrate.ts (scripts or tests), never by this CLI
// against production — production applies run through db:migrate, which
// requires DATABASE_URL_UNPOOLED and refuses to run without it.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  // Migrations are generated and reviewed as plain SQL; no driver
  // credentials live in this file.
});
