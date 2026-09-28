// E2E global setup, run by Playwright inside `firebase emulators:exec`
// AFTER the webServer is already serving (Playwright starts the
// webServer plugin before global setup — see tests/e2e/db-server.ts for
// why the PGlite engine + socket live in that process).
//
// What remains here is fixture DATA, applied over the same wire protocol
// the dev server uses:
//   1. the four Auth-emulator fixture accounts (persist for the run —
//      no test ever creates Firebase users);
//   2. the seeded Postgres + Firestore baseline, via the shared
//      resetE2EState() that the per-test fixture in fixtures.ts replays
//      before every attempt, making retries deterministic.
import { ensureE2EAuthUsers, resetE2EState } from "./fixtures";

export default async function globalSetup(): Promise<void> {
  await ensureE2EAuthUsers();
  await resetE2EState();
}
