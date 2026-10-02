// Regression guard for the Functions definition-discovery timeout
// (#267). firebase-tools loads index.js in a child process under a
// configurable deadline (FUNCTIONS_DISCOVERY_TIMEOUT, default 10s); the
// repo wrapper raises it, but the durable guard is keeping module load
// small and side-effect-free. Wall-clock assertions would flake on
// loaded CI runners, so this asserts the STRUCTURAL property: the count
// of distinct files required at module scope, plus that the load needs
// no environment and performs no work a discovery pass shouldn't.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const path = require("node:path");

const FUNCTIONS_DIR = path.join(__dirname, "..");

// Number of distinct resolved modules index.js may pull at load time.
// Measured ~30 today (firebase-functions lazy-loads providers); a
// heavyweight top-level dep (e.g. googleapis, ~1000+ files) trips this
// deterministically on any machine — unlike a millisecond assertion.
const MODULE_FILE_BUDGET = 150;

test("index.js loads with no env, few files, both exports", () => {
  const probe = `
const Module = require("module");
const orig = Module._load;
const files = new Set();
Module._load = function (request, parent, isMain) {
  const m = orig.apply(this, arguments);
  try { files.add(Module._resolveFilename(request, this)); } catch {}
  return m;
};
const t = Date.now();
const f = require("./index.js");
console.log(JSON.stringify({
  ms: Date.now() - t,
  files: files.size,
  exports: Object.keys(f).sort(),
}));
`;
  // Deliberately a fresh process with a minimal env — mirrors how
  // firebase-tools spawns the discovery child (no repo env leaks in).
  const out = execFileSync(
      process.execPath,
      ["-e", probe],
      {
        cwd: FUNCTIONS_DIR,
        env: {PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT},
        encoding: "utf8",
        timeout: 120_000,
      },
  ).trim();
  const result = JSON.parse(out.split("\n").pop());
  console.log(
      `discovery-load: ${result.ms}ms, ${result.files} modules, ` +
      `exports=[${result.exports}]`,
  );
  assert.deepEqual(result.exports, ["onFirestoreChange", "triggerRebuild"]);
  assert.ok(
      result.files <= MODULE_FILE_BUDGET,
      `index.js pulled ${result.files} module files at load time ` +
      `(budget ${MODULE_FILE_BUDGET}) — a heavyweight top-level import ` +
      `reintroduces the cold-start discovery timeout (#267)`,
  );
});
