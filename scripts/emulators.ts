// Firebase emulator front-end: port preflight + deterministic
// alternate-port profile (#269 — local multi-project collisions).
//
//   tsx scripts/emulators.ts check [--only auth,firestore,storage]
//   tsx scripts/emulators.ts exec [--alt-ports] <firebase emulators:exec args>
//
// `check`/`exec` preflight the fixed emulator ports (firebase-tools
// auto-selects hub/logging/ui ports, so only auth/firestore/storage/
// functions/etc. need checking). When a required port is occupied the
// owner is identified via the emulator-hub locator files
// ($TMPDIR/hub-<projectId>.json) and the hub's /emulators endpoint —
// so the error says WHICH project holds the port instead of surfacing
// a foreign project ID in emulator logs or a misleading test failure.
//
// `--alt-ports` shifts every configured fixed port by +10000 into a
// generated firebase.alt.json (in the OS temp dir — never committed)
// and exports the matching NEXT_PUBLIC_*_EMULATOR_* overrides consumed
// by src/lib/firebase.ts and playwright.config.ts, so the SFPCA suite
// can run alongside another project's suite. The override env vars are
// only set for emulators actually requested via --only.
//
// Nothing here ever kills a process — diagnostics only; the operator
// decides.

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PORTS,
  findHubLocators,
  identifyOccupier,
  probePort,
  requiredPorts,
} from "./lib/emulator-ports";

const ALT_PORT_OFFSET = 10_000;
const OUR_PROJECT = "demo-sfpca";

function readFirebaseConfig(configPath = "firebase.json"): {
  emulators?: Record<string, { port?: number }>;
} {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

// Both `--only a,b` and `--only=a,b` are valid firebase CLI syntax.
function parseOnly(args: string[]): string[] | null {
  const i = args.indexOf("--only");
  if (i >= 0) {
    const value = args[i + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("--only requires a comma-separated emulator list");
    }
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const eq = args.find((a) => a.startsWith("--only="));
  const value = eq?.slice("--only=".length);
  if (!value) return null;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// A caller may select a different config via `--config <path>` or
// `--config=<path>`. The wrapper must preflight the same file the
// child binds, and exactly one --config may reach the CLI — repeated
// flags have undefined precedence.
function extractConfigArg(args: string[]): {
  configPath: string | null;
  fwd: string[];
} {
  const fwd: string[] = [];
  let configPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--config requires a file path");
      }
      configPath = value;
      i++;
    } else if (a.startsWith("--config=")) {
      const value = a.slice("--config=".length);
      if (!value) throw new Error("--config requires a file path");
      configPath = value;
    } else {
      fwd.push(a);
    }
  }
  return { configPath, fwd };
}

async function preflight(
  ports: { name: string; port: number }[],
): Promise<string[]> {
  const problems: string[] = [];
  const locators = findHubLocators();
  for (const { name, port } of ports) {
    if (!(await probePort(port))) continue;
    const occ = await identifyOccupier(port, locators);
    problems.push(
      occ.kind === "emulator-suite"
        ? `  port ${port} (${name}) — held by the emulator suite for ` +
            `project "${occ.projectId}" (hub ${occ.hubOrigin}, pid ${occ.pid})`
        : `  port ${port} (${name}) — ${occ.detail}`,
    );
  }
  return problems;
}

function printProblems(problems: string[], tail: string) {
  console.error("emulator ports: required port(s) in use:");
  for (const p of problems) console.error(p);
  console.error(tail);
}

async function cmdCheck(args: string[]) {
  const { configPath, fwd } = extractConfigArg(args);
  const ports = requiredPorts(
    readFirebaseConfig(configPath ?? "firebase.json"),
    parseOnly(fwd),
  );
  const problems = await preflight(ports);
  if (!problems.length) {
    console.log(
      `emulator preflight: all required ports free (${ports
        .map((p) => `${p.name}:${p.port}`)
        .join(", ")})`,
    );
    return;
  }
  printProblems(
    problems,
    "\nStop the owning suite/process, or rerun with --alt-ports to run " +
      "SFPCA's suite on the +10000 port block.",
  );
  process.exit(1);
}

function firebaseBin(): string {
  const pkgJson = findPackageJSON("firebase-tools", import.meta.url);
  const binRel = JSON.parse(readFileSync(pkgJson!, "utf8")).bin.firebase;
  return join(dirname(pkgJson!), binRel);
}

// File-path fields in firebase.json are resolved relative to the CONFIG
// file's directory — a temp-dir alt config must rewrite them to
// absolute repo paths or Firestore/Storage silently fall back to
// allow-all rules (observed: "rules file …Temp\firestore.rules does not
// exist — defaulting to allowing all reads and writes").
const PATH_FIELDS: [string, string][] = [
  ["firestore", "rules"],
  ["firestore", "indexes"],
  ["storage", "rules"],
  ["database", "rules"],
  ["functions", "source"],
  ["hosting", "public"],
];

// Relative file paths are resolved against the CONFIG file's
// directory — firebase semantics — not the caller's cwd.
function absolutizePaths(cfg: Record<string, any>, baseDir: string) {
  for (const [section, field] of PATH_FIELDS) {
    const sec = cfg[section];
    if (sec && typeof sec[field] === "string" && !path.isAbsolute(sec[field])) {
      sec[field] = path.resolve(baseDir, sec[field]);
    }
  }
}

function buildAltConfig(
  only: string[] | null,
  cfg: { emulators?: Record<string, { port?: number }> },
  baseDir: string,
): {
  path: string;
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const requested = only ?? Object.keys(cfg.emulators ?? {});
  for (const name of requested) {
    const section = cfg.emulators?.[name] ?? {};
    const base = section.port ?? DEFAULT_PORTS[name];
    if (!base) continue;
    const alt = base + ALT_PORT_OFFSET;
    cfg.emulators ??= {};
    cfg.emulators[name] = { ...section, port: alt };
    if (name === "firestore") {
      env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT = String(alt);
    } else if (name === "storage") {
      env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT = String(alt);
    } else if (name === "auth") {
      env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL =
        `http://localhost:${alt}`;
    }
  }
  absolutizePaths(cfg, baseDir);
  const cfgPath = path.join(
    os.tmpdir(),
    `firebase.alt.${process.pid}.json`,
  );
  // Exclusive create: the tmp path is predictable, so refuse to
  // overwrite (or later unlink) a file this call did not create.
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { flag: "wx" });
  return { path: cfgPath, env };
}

async function cmdExec(args: string[]) {
  const alt = args.includes("--alt-ports");
  const { configPath, fwd } = extractConfigArg(
    args.filter((a) => a !== "--alt-ports"),
  );
  const only = parseOnly(fwd);
  const selectedConfig = configPath ?? "firebase.json";
  const cfg = readFirebaseConfig(selectedConfig);
  const cfgBaseDir = path.dirname(path.resolve(selectedConfig));
  const ports = requiredPorts(cfg, only);

  const problems = await preflight(ports);
  if (problems.length && !alt) {
    printProblems(
      problems,
      `\nNot running tests against a foreign suite on purpose: ` +
        `stop it, or rerun the same command with --alt-ports ` +
        `(+${ALT_PORT_OFFSET} port block).`,
    );
    process.exit(1);
  }

  // Preflight the shifted block first — before writing the alt config,
  // so an early exit cannot leak firebase.alt.<pid>.json.
  const boundPorts = alt
    ? ports.map((p) => ({ name: p.name, port: p.port + ALT_PORT_OFFSET }))
    : ports;
  if (alt) {
    const altProblems = await preflight(boundPorts);
    if (altProblems.length) {
      console.error("emulator preflight: alternate port(s) also in use:");
      for (const p of altProblems) console.error(p);
      process.exit(1);
    }
    console.log(
      `emulators: using alternate ports ` +
        boundPorts.map((p) => `${p.name}:${p.port}`).join(", "),
    );
  }

  let altConfigPath: string | undefined;
  let status = 1;
  try {
    // Forward the caller's config selection unchanged in normal mode;
    // in alt mode exactly one --config (the generated file) is passed.
    let configArg = configPath ? ["--config", configPath] : [];
    const childEnv = { ...process.env };
    if (alt) {
      const altCfg = buildAltConfig(only, cfg, cfgBaseDir);
      altConfigPath = altCfg.path;
      configArg = ["--config", altCfg.path];
      Object.assign(childEnv, altCfg.env);
    }
    const r = spawnSync(
      process.execPath,
      [firebaseBin(), ...configArg, "emulators:exec", ...fwd],
      { stdio: "inherit", env: childEnv },
    );
    status = r.status ?? 1;
  } finally {
    // The generated alt config has served its purpose — don't leave
    // firebase.alt.<pid>.json files accumulating in the temp dir.
    if (altConfigPath) {
      try {
        unlinkSync(altConfigPath);
      } catch {
        // Already gone — harmless.
      }
    }
  }
  // Post-mortem: preflight races are possible (a foreign suite can grab
  // a port between the check and the bind). If the child failed AND a
  // port the child would bind is now occupied, name the winner so the
  // operator does not chase the emulator's generic "unexpected error"
  // in the wrong direction. Check boundPorts — under --alt-ports those
  // are the shifted ports the child actually needed.
  if (status !== 0) {
    const late = await preflight(boundPorts);
    if (late.length) {
      printProblems(
        late,
        "\nThe port(s) above were captured between preflight and " +
          "emulator bind — a competing suite likely started at the same " +
          `time. Rerun${alt ? "." : ", or use --alt-ports."}`,
      );
    }
  }
  process.exit(status);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "check") {
    await cmdCheck(rest);
    return;
  }
  if (cmd === "exec") {
    await cmdExec(rest);
    return;
  }
  console.error(
    "usage: emulators.ts check [--only a,b,c] [--config <path>] | " +
      "exec [--alt-ports] <emulators:exec args>",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("emulators.ts failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
