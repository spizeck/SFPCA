import baseConfig from "./playwright.config";

// Maintenance-mode variant of the E2E harness (#189). Everything is
// identical to playwright.config.ts — same PGlite datastore, same
// Firebase emulators, same seeded baseline — except the dev server
// starts with SITE_MAINTENANCE_MODE=true so tests/e2e/maintenance.spec.ts
// exercises the real proxy gate under a production-like configuration.
//
// Runs via `npm run test:e2e:maintenance` (separate emulator process +
// webServer from the main suite). reuseExistingServer is disabled
// deliberately: silently reusing a dev server started with the flag off
// would make every assertion in this file meaningless.
export default {
  ...baseConfig,
  testMatch: "maintenance.spec.ts",
  // Clear the base suite's exclusion so this spec is runnable here.
  testIgnore: [],
  webServer: {
    ...baseConfig.webServer,
    reuseExistingServer: false,
    env: {
      ...(baseConfig.webServer && !Array.isArray(baseConfig.webServer)
        ? baseConfig.webServer.env
        : {}),
      SITE_MAINTENANCE_MODE: "true",
    },
  },
};
