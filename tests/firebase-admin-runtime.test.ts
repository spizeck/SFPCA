// Regression guard for #144: /admin died in production with
// FUNCTION_INVOCATION_FAILED because Vercel's serverless runtime loads
// firebase-admin as a CommonJS external WITHOUT Node's require(esm)
// bridge — and firebase-admin@14 pulls jwks-rsa@4, whose
// `require('jose')` hits ESM-only jose@6 (ERR_REQUIRE_ESM).
//
// Plain `node -e "require('firebase-admin/auth')"` passes even on the
// broken graph because Node ≥22.12 enables require(esm) by default.
// The subprocess disables it to match the deployed runtime, so this
// test fails on any dependency graph where the server auth path cannot
// load under plain CommonJS — exactly the production failure mode.
//
// No credentials or network: module loading only.
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const ADMIN_MODULES = [
  "firebase-admin/app",
  "firebase-admin/auth",
  "firebase-admin/firestore",
] as const;

// Spawning Node and loading firebase-admin takes a few seconds — allow
// headroom so a loaded CI machine can't flake this guard.
const SPAWN_TIMEOUT_MS = 30_000;

describe("firebase-admin server runtime (#144)", () => {
  test("admin entry points load under a CommonJS-only runtime", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const script = [
      ...ADMIN_MODULES.map((m) => `require(${JSON.stringify(m)});`),
      'console.log("loaded");',
    ].join("\n");
    const out = execFileSync(
      process.execPath,
      ["--no-experimental-require-module", "-e", script],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("loaded");
  });

  test("the auth API surface the app uses is present", { timeout: SPAWN_TIMEOUT_MS }, () => {
    // verifyIdToken/createSessionCookie/verifySessionCookie are the
    // only admin-auth calls in src/ — guard the pin against a future
    // version that loads but renames them.
    const script = `
      const { Auth } = require("firebase-admin/auth");
      for (const fn of ["verifyIdToken", "createSessionCookie", "verifySessionCookie"]) {
        if (typeof Auth.prototype[fn] !== "function") {
          console.error("missing Auth.prototype." + fn);
          process.exit(1);
        }
      }
      console.log("auth-api-ok");
    `;
    const out = execFileSync(
      process.execPath,
      ["--no-experimental-require-module", "-e", script],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("auth-api-ok");
  });
});
