// Shared E2E environment constants. Kept side-effect-free so it can be
// imported from playwright.config.ts (loaded before the runner starts),
// the webServer process (db-server.ts), global setup, and test workers.

// Synthetic admin user in the Auth emulator. emailVerified is required:
// the app's session endpoint (and the custom-claim rules boundary)
// reject unverified identities, matching the production boundary.
export const E2E_ADMIN_EMAIL = "e2e-admin@example.com";
export const E2E_ADMIN_PASSWORD = "e2e-test-only-password";
// Synthetic verified user with NO admin_users row: proves that a
// successful Firebase sign-in alone cannot establish an admin session or
// enter /admin. No matching person exists either — login provisions a
// fresh registry person, so this user sees an empty owner portal.
export const E2E_USER_EMAIL = "e2e-user@example.com";
export const E2E_USER_PASSWORD = "e2e-test-only-password";
// Pre-linked owner: an auth_identities row ties this Firebase uid to a
// seeded person who owns animals — exercises the full portal journey.
export const E2E_OWNER_EMAIL = "e2e-owner@example.com";
export const E2E_OWNER_PASSWORD = "e2e-test-only-password";
// Unlinked account whose email matches a seeded person with no linked
// identity — login files an 'account-claim' request instead of linking.
export const E2E_CLAIM_EMAIL = "e2e-claim@example.com";
export const E2E_CLAIM_PASSWORD = "e2e-test-only-password";

// The demo Firebase project the whole suite runs against. The matching
// `demo-` prefix disables all credential checks in the emulators.
export const E2E_FIREBASE_PROJECT_ID = "demo-sfpca";

// The port the dev server listens on (webServer url / baseURL).
export const E2E_APP_PORT = 3100;

// The PGlite wire-protocol socket the dev server's DATABASE_URL points
// at. Owned by tests/e2e/db-server.ts — the database accepts connections
// before `next dev` is ever spawned.
export const E2E_PGLITE_PORT = 5544;
export const E2E_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${E2E_PGLITE_PORT}/postgres`;

// Control endpoint on the webServer process (tests/e2e/db-server.ts).
// Per-test Postgres resets are POSTed here and executed directly on the
// PGlite engine — never over the wire socket, where a second client
// connection's protocol messages could interleave with the app's
// in-flight queries (see seed.ts).
export const E2E_CONTROL_PORT = 5545;
export const E2E_RESET_URL = `http://127.0.0.1:${E2E_CONTROL_PORT}/reset`;
export const E2E_QUERY_URL = `http://127.0.0.1:${E2E_CONTROL_PORT}/query`;
