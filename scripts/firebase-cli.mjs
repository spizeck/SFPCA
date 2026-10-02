// Thin wrapper around the repo-pinned firebase-tools CLI (#267).
//
// Why this exists: firebase-tools' backend-specification discovery
// spawns a child Node process that loads functions/index.js and polls
// /__/functions.yaml with a 10-second deadline. On a cold filesystem
// (first run after boot / AV rescan of node_modules) that load has been
// measured at ~13s locally, producing intermittent
//   "User code failed to load. Cannot determine backend specification.
//    Timeout after 10000"
// failures that vanish on warm retry. FUNCTIONS_DISCOVERY_TIMEOUT
// (seconds) is the officially supported override — this wrapper sets a
// generous default so every repo entry point (deploy script, functions
// npm scripts, ad-hoc CLI use) gets the same behavior instead of
// depending on whoever exported the variable in their shell.
//
// Usage: node scripts/firebase-cli.mjs <any firebase args>
//   FUNCTIONS_DISCOVERY_TIMEOUT=120 node scripts/firebase-cli.mjs deploy --only functions
//
// The functions/ package.json scripts route through this wrapper;
// scripts/deploy-functions.js sets the same default inline (it must
// also work when firebase resolves via PATH rather than this file).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";

// Seconds — firebase-tools multiplies by 1000. 60s covers a fully cold
// AV-scan load (~13s measured) with >4x headroom without masking a real
// hang for long.
process.env.FUNCTIONS_DISCOVERY_TIMEOUT ??= "60";

const pkgJson = findPackageJSON("firebase-tools", import.meta.url);
const binRel = JSON.parse(readFileSync(pkgJson, "utf8")).bin.firebase;
const bin = join(dirname(pkgJson), binRel);

const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
