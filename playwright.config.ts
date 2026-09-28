import { defineConfig, devices } from "@playwright/test";
import {
  E2E_APP_PORT,
  E2E_DATABASE_URL,
} from "./tests/e2e/env";

const baseURL = `http://localhost:${E2E_APP_PORT}`;

// E2E smoke suite. `npm run test:e2e` wraps this in
// `firebase emulators:exec`, so FIRESTORE_EMULATOR_HOST /
// FIREBASE_AUTH_EMULATOR_HOST are already set for both the webServer
// process (Admin SDK in /api/auth/session and server components) and the
// global setup fixture script.
//
// Lifecycle (#229): Playwright starts webServer BEFORE globalSetup, so
// the webServer command — `npm run dev:e2e` (tests/e2e/db-server.ts) —
// owns the datastore itself: it brings up PGlite, replays migrations,
// and starts the wire-protocol socket BEFORE spawning `next dev`. The
// ordering "database ready → application server ready → tests run" is
// therefore structural, not timed. globalSetup then seeds the fixture
// baseline through the socket, and the shared fixture (tests/e2e/
// fixtures.ts) re-applies that baseline before every test attempt so
// retries never inherit a failed attempt's mutations.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  // Generous expect bound: `next dev` compiles routes on demand, so the
  // first navigation to each route can take a while on a cold server.
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "tests/e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev:e2e",
    url: baseURL,
    // Reused servers only work with `npm run dev:e2e` — it owns the
    // PGlite socket; a plain `next dev` leaves the harness no datastore.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Emulator-only demo project config — never real credentials.
      NEXT_PUBLIC_FIREBASE_API_KEY: "e2e-demo-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-sfpca.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-sfpca",
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "demo-sfpca.appspot.com",
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:000000000000:web:e2e-demo",
      NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true",
      // Fake container for consent-boundary tests — E2E intercepts the
      // request so no traffic ever reaches Google.
      NEXT_PUBLIC_GTM_ID: "GTM-E2ETEST",
      // E2E must exercise the full site, never the maintenance gate.
      SITE_MAINTENANCE_MODE: "false",
      // The registry datastore: a PGlite Postgres engine served over the
      // wire protocol by tests/e2e/db-server.ts — the dev server uses
      // the same postgres.js client it would for Neon, against an
      // isolated throwaway database.
      DATABASE_URL: E2E_DATABASE_URL,
      // One connection: pglite-socket queues protocol messages
      // per-message, so multiple pooled connections can interleave
      // extended-protocol sequences. See src/lib/db/client.ts.
      DATABASE_POOL_MAX: "1",
    },
  },
});
