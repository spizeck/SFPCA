// Emulator-port collision detection (#269: local multi-project
// collisions). firebase emulators bind fixed ports from firebase.json;
// when another project's emulator suite (or any process) already holds
// 8080/9099/9199 the failure surfaces far from its cause — a Firestore
// crash or a foreign project ID in the logs. These helpers let a
// preflight answer "who owns this port?" deterministically:
//
//   1. probe the port;
//   2. if occupied, scan %TMPDIR%/hub-*.json — every running emulator
//      hub writes a locator (projectId in the filename, pid + origin in
//      the body) — then ask each live hub `GET /emulators` which ports
//      its suite owns;
//   3. report the owning Firebase project, our own suite, or "not an
//      emulator".
//
// Pure node, cross-platform, read-only — it never kills anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

// Emulators that bind a FIXED port (firebase-tools
// FIND_AVAILBLE_PORT_BY_DEFAULT=false). hub/logging/ui/eventarc/tasks
// auto-select a free port, so they never need preflight.
const FIXED_PORT_EMULATORS = new Set([
  "functions",
  "firestore",
  "database",
  "pubsub",
  "auth",
  "storage",
  "dataconnect",
]);

export const DEFAULT_PORTS: Record<string, number> = {
  functions: 5001,
  firestore: 8080,
  database: 9000,
  pubsub: 8085,
  auth: 9099,
  storage: 9199,
  dataconnect: 9399,
};

export interface RequiredPort {
  name: string;
  port: number;
}

// Which ports an emulators:exec/--only invocation must have free. `only`
// of null means "everything configured" (emulators:start semantics).
export function requiredPorts(
  firebaseConfig: { emulators?: Record<string, unknown> },
  only: string[] | null,
): RequiredPort[] {
  const configured = firebaseConfig.emulators ?? {};
  const names = only ?? Object.keys(configured);
  const out: RequiredPort[] = [];
  for (const name of names) {
    if (!FIXED_PORT_EMULATORS.has(name)) continue;
    const cfg = configured[name];
    const port =
      typeof cfg === "object" && cfg !== null && "port" in cfg
        ? (cfg as { port?: number }).port
        : undefined;
    out.push({ name, port: port ?? DEFAULT_PORTS[name] });
  }
  return out;
}

export function probePort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 800,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (occupied: boolean) => {
      sock.destroy();
      resolve(occupied);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

export interface HubLocator {
  projectId: string;
  pid: number | null;
  origins: string[];
  pidAlive: boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but owned by another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Scan tmpdir for hub-<projectId>.json locator files written by every
// running firebase emulator suite.
export function findHubLocators(tmpdir = os.tmpdir()): HubLocator[] {
  const out: HubLocator[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpdir);
  } catch {
    return out;
  }
  for (const file of entries) {
    const m = file.match(/^hub-(.+)\.json$/);
    if (!m) continue;
    try {
      const loc = JSON.parse(
        fs.readFileSync(path.join(tmpdir, file), "utf8"),
      ) as { origins?: string[]; pid?: number };
      out.push({
        projectId: m[1],
        pid: typeof loc.pid === "number" ? loc.pid : null,
        origins: Array.isArray(loc.origins) ? loc.origins : [],
        pidAlive: typeof loc.pid === "number" ? pidAlive(loc.pid) : false,
      });
    } catch {
      // Malformed/stale locator — not evidence of a live suite.
    }
  }
  return out;
}

// Ask a live hub which emulators its suite runs → map name → ports.
export async function hubEmulatorPorts(
  origin: string,
  timeoutMs = 1500,
): Promise<Record<string, number[]>> {
  const res = await fetch(`${origin}/emulators`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hub ${origin} → ${res.status}`);
  const body = (await res.json()) as Record<
    string,
    { listen?: { port?: number }[]; port?: number }
  >;
  const map: Record<string, number[]> = {};
  for (const [name, info] of Object.entries(body)) {
    const ports: number[] = [];
    for (const l of info.listen ?? []) {
      if (typeof l.port === "number") ports.push(l.port);
    }
    if (typeof info.port === "number") ports.push(info.port);
    map[name] = ports;
  }
  return map;
}

export interface Occupier {
  kind: "emulator-suite" | "unknown";
  projectId?: string;
  pid?: number | null;
  processName?: string;
  hubOrigin?: string;
  detail: string;
}

// Last-resort OS lookup for a listening port's owner when no live
// emulator hub claims it — e.g. an orphaned java.exe Firestore emulator
// whose suite's hub already died. Read-only; returns null when the
// platform tools are unavailable.
export function osPortOwner(
  port: number,
): { pid: number; name: string } | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const pid = out
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .find(
          (c) =>
            (c[0] === "TCP" || c[0] === "TCP6") &&
            c[1]?.endsWith(`:${port}`) &&
            c[3] === "LISTENING",
        )?.[4];
      if (!pid) return null;
      const name = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", timeout: 10_000 },
      )
        .split(",")[0]
        ?.replace(/"/g, "")
        .trim();
      return { pid: Number(pid), name: name || "?" };
    }
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    const pid = Number(out.split("\n")[0]);
    if (!pid) return null;
    const name = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return { pid, name: name || "?" };
  } catch {
    return null;
  }
}

// Identify what occupies `port`: a live emulator suite (with its
// projectId, from the locator filename + hub /emulators mapping) or an
// unknown non-emulator process.
export async function identifyOccupier(
  port: number,
  locators: HubLocator[],
): Promise<Occupier> {
  for (const loc of locators) {
    if (!loc.pidAlive) continue;
    for (const origin of loc.origins) {
      let map: Record<string, number[]>;
      try {
        map = await hubEmulatorPorts(origin);
      } catch {
        continue;
      }
      for (const [name, ports] of Object.entries(map)) {
        if (ports.includes(port)) {
          return {
            kind: "emulator-suite",
            projectId: loc.projectId,
            pid: loc.pid,
            hubOrigin: origin,
            detail: `${name} emulator of suite "${loc.projectId}"`,
          };
        }
      }
    }
    // The hub itself auto-bumps ports, so a locator can exist without
    // owning this port — keep scanning other locators.
  }
  const os = osPortOwner(port);
  return {
    kind: "unknown",
    pid: os?.pid ?? null,
    processName: os?.name,
    detail: os
      ? `${os.name} (pid ${os.pid}) — no live emulator hub claims the ` +
        `port; likely an orphaned emulator process or unrelated server`
      : "not a Firebase emulator (or a suite whose hub is gone)",
  };
}
