// Server-runtime smoke check for the firebase-admin dependency chain.
//
// Why this exists: issue #144 — a firebase-admin/jwks-rsa/jose combination
// installed, typechecked, and built cleanly, then crashed the deployed
// Vercel serverless function with ERR_REQUIRE_ESM on first import.
// This script loads the same entrypoints through plain Node ESM — no
// bundler, no test transform — the closest credential-free signal to the
// deployed runtime. (tests/firebase-admin-runtime.test.ts additionally
// loads them under a CommonJS-only subprocess, matching Vercel exactly.)
//
// Run: node scripts/check-admin-import.mjs   (wired into `npm test`)

import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";

const entrypoints = {
  "firebase-admin/app": ["initializeApp", "cert", "getApps"],
  "firebase-admin/auth": ["getAuth"],
  "firebase-admin/firestore": ["getFirestore"],
  "firebase-admin/storage": ["getStorage"],
};

// firebase-admin's exports map does not expose ./package.json, so locate
// it via Node's own package resolution.
const pkgJsonPath = findPackageJSON("firebase-admin", import.meta.url);
const { version } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
if (!version.startsWith("14.")) {
  console.error(
    `firebase-admin@${version} loaded — expected the 14.x line ` +
      `(issue #223).`,
  );
  process.exit(1);
}

for (const [entry, names] of Object.entries(entrypoints)) {
  const mod = await import(entry);
  for (const name of names) {
    if (typeof mod[name] !== "function") {
      console.error(`${entry}: expected export "${name}" to be a function`);
      process.exit(1);
    }
  }
}

console.log(`firebase-admin@${version}: server import chain OK`);
