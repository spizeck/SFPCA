import { defineConfig, devices } from "@playwright/test";

// E2E smoke suite. `npm run test:e2e` wraps this in
// `firebase emulators:exec`, so FIRESTORE_EMULATOR_HOST /
// FIREBASE_AUTH_EMULATOR_HOST are already set for both the webServer
// process (Admin SDK in /api/auth/session and server components) and the
// global setup fixture script.
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
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- -p 3100",
    url: "http://localhost:3100",
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
      // E2E must exercise the full site, never the maintenance gate.
      SITE_MAINTENANCE_MODE: "false",
    },
  },
});
