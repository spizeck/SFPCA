// Preview-environment schema migration for the Postgres registry (#180).
//
// Wired as the npm `prebuild` hook so it runs before `next build` in
// every context, then decides:
//
//   - Vercel Preview build (VERCEL_ENV=preview): apply the checked-in
//     drizzle/ migrations to this deployment's Neon branch via
//     DATABASE_URL_UNPOOLED. Failure exits non-zero so a broken schema
//     fails the deployment instead of silently shipping.
//   - Production build / local dev / CI: no-op. Production migrations
//     are a deliberate operator step (npm run db:migrate), never an
//     implicit side effect of a build.
//
// Safety properties:
// - refuses to migrate anything outside VERCEL_ENV=preview
// - requires DATABASE_URL_UNPOOLED explicitly; never falls back to the
//   pooled runtime URL for DDL
// - idempotent: drizzle's __drizzle_migrations journal makes replay a
//   no-op when the branch is already current
// - logs host only — never credentials

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { runMigrationsOnPostgres } from "../src/lib/db/migrate";

async function main() {
  const vercelEnv = process.env.VERCEL_ENV;
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (vercelEnv !== "preview") {
    console.log(
      `preview-migrate: skipping (VERCEL_ENV=${vercelEnv ?? "unset"} — ` +
        "migrations only auto-apply to Vercel Preview branches).",
    );
    return;
  }
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.error(
      "preview-migrate: VERCEL_ENV=preview but DATABASE_URL_UNPOOLED is " +
        "missing or not a Postgres URL. Refusing to build against an " +
        "unverifiable database target.",
    );
    process.exit(1);
  }

  const host = new URL(url).hostname;
  console.log(`preview-migrate: applying drizzle/ migrations to ${host}...`);

  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 30 });
  try {
    await runMigrationsOnPostgres(drizzle(sql));
    console.log("preview-migrate: preview branch schema is current.");
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(
    "preview-migrate: migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
