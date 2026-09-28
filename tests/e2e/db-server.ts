// E2E application-server process — the `npm run dev:e2e` command behind
// playwright.config.ts's webServer. Run inside `npm run test:e2e` (which
// wraps it in `firebase emulators:exec`, exporting the emulator env).
//
// Why this exists (#229): Playwright starts webServer BEFORE globalSetup
// — the server plugin is a "plugin setup" task and global setup runs
// after it. When the PGlite socket lived in global-setup.ts, next dev
// was already serving (and being probed on /) while nothing listened on
// :5544, so the app's first Postgres reads logged ECONNREFUSED until
// global setup caught up. Owning the datastore here makes the ordering
// structural: socket listening and migrated → next dev spawned →
// Playwright's URL probe. The app process can never outrun its database.
//
// Fixture data still lands in globalSetup (tests/e2e/global-setup.ts →
// fixtures.ts) over this same socket — pages fail closed to empty
// renders during that gap, and tests only start after seeding.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as schema from "../../src/lib/db/schema";
import { runMigrationsOnPglite } from "../../src/lib/db/migrate";
import { E2E_APP_PORT, E2E_PGLITE_PORT } from "./env";

async function main(): Promise<void> {
  // In-memory throwaway Postgres engine. Replay the checked-in
  // migrations so the schema the app sees is the production schema —
  // seed data is applied later by globalSetup through the socket.
  const pglite = new PGlite();
  await runMigrationsOnPglite(drizzle(pglite, { schema }));

  const socketServer = new PGLiteSocketServer({
    db: pglite,
    port: E2E_PGLITE_PORT,
    host: "127.0.0.1",
    maxConnections: 8,
  });
  await socketServer.start();
  console.log(`[e2e] PGlite migrated and listening on 127.0.0.1:${E2E_PGLITE_PORT}`);

  // Only now may the app server exist. Spawn `next dev` on next's own
  // bin via the current node — same entry `npm run dev` uses, without a
  // second npm/cmd layer to forward signals through on Windows.
  const require = createRequire(import.meta.url);
  const nextBin = join(
    dirname(require.resolve("next/package.json")),
    "dist/bin/next",
  );
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-p", String(E2E_APP_PORT)],
    { stdio: "inherit" },
  );

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    if (!child.killed) child.kill();
    await socketServer.stop().catch(() => {});
    await pglite.close().catch(() => {});
    process.exit(code);
  };

  // If the app dies, the environment is gone — propagate its exit code
  // so Playwright reports the real failure instead of probing a server
  // that will never come up.
  child.on("exit", (code) => void shutdown(code ?? 0));
  child.on("error", () => void shutdown(1));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  // If we are killed outright, the datastore is in-memory and dies with
  // the process; still try not to orphan `next dev`.
  process.on("exit", () => child.kill());
}

main().catch((error) => {
  console.error("[e2e] dev server environment failed to start:", error);
  process.exit(1);
});
