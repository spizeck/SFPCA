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
// fixtures.ts → POST /reset here) — pages fail closed to empty renders
// during that gap, and tests only start after seeding.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as schema from "../../src/lib/db/schema";
import { runMigrationsOnPglite } from "../../src/lib/db/migrate";
import { E2E_APP_PORT, E2E_CONTROL_PORT, E2E_PGLITE_PORT } from "./env";
import { seedE2ERegistry, truncateRegistry } from "./seed";

async function main(): Promise<void> {
  // In-memory throwaway Postgres engine. Replay the checked-in
  // migrations so the schema the app sees is the production schema.
  const pglite = new PGlite();
  const db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);

  const socketServer = new PGLiteSocketServer({
    db: pglite,
    port: E2E_PGLITE_PORT,
    host: "127.0.0.1",
    maxConnections: 8,
  });
  await socketServer.start();
  console.log(`[e2e] PGlite migrated and listening on 127.0.0.1:${E2E_PGLITE_PORT}`);

  // Reset control endpoint: the per-test fixture POSTs the seeded
  // baseline here and we apply it DIRECTLY on the engine — not through
  // the wire socket. pglite-socket multiplexes all client connections
  // through one backend session, so a second connection's queries can
  // interleave with the app's in-flight extended-protocol sequences and
  // corrupt them (SQLSTATE 26000 "unnamed prepared statement does not
  // exist", observed under repeat-each load). PGlite serializes engine
  // access internally, making the reset atomic w.r.t. app traffic.
  const control = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/reset") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          const { ownerUid } = JSON.parse(body || "{}") as {
            ownerUid?: string;
          };
          if (!ownerUid) throw new Error("reset requires ownerUid");
          await truncateRegistry(db);
          await seedE2ERegistry(db, ownerUid);
        })()
          .then(() => res.writeHead(200).end("ok"))
          .catch((error) => res.writeHead(500).end(String(error)));
      });
      return;
    }
    // Direct SQL for specs that need to read/assert registry rows
    // mid-test — same engine-direct rationale as /reset. Test-only
    // channel on a throwaway in-memory database.
    if (req.method === "POST" && req.url === "/query") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          const { text, params } = JSON.parse(body || "{}") as {
            text?: string;
            params?: unknown[];
          };
          if (!text) throw new Error("query requires text");
          const result = await pglite.query<Record<string, unknown>>(
            text,
            params,
          );
          return result.rows;
        })()
          .then((rows) =>
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(rows)),
          )
          .catch((error) => res.writeHead(500).end(String(error)));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    control.listen(E2E_CONTROL_PORT, "127.0.0.1", resolve),
  );

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
    control.close();
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
