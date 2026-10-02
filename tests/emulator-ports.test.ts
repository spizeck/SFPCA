// Unit tests for emulator-port collision detection — port requirement
// derivation from firebase.json, hub-locator parsing, and occupier
// identification. A live hub is stubbed with a local HTTP server so the
// suite→port attribution path is exercised without real emulators.

import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findHubLocators,
  identifyOccupier,
  requiredPorts,
} from "../scripts/lib/emulator-ports";

const FIREBASE_JSON = {
  emulators: {
    auth: { port: 9099 },
    firestore: { port: 8080 },
    storage: { port: 9199 },
    ui: { enabled: false },
    singleProjectMode: true,
  },
};

describe("requiredPorts", () => {
  it("returns configured fixed-port emulators for --only", () => {
    expect(
      requiredPorts(FIREBASE_JSON, ["auth", "firestore", "storage"]),
    ).toEqual([
      { name: "auth", port: 9099 },
      { name: "firestore", port: 8080 },
      { name: "storage", port: 9199 },
    ]);
  });
  it("skips auto-selecting emulators (hub/ui/logging)", () => {
    const cfg = {
      emulators: {
        ...FIREBASE_JSON.emulators,
        hub: { port: 4400 },
        ui: { port: 4000 },
      },
    };
    const ports = requiredPorts(cfg, null);
    expect(ports.map((p) => p.name)).not.toContain("hub");
    expect(ports.map((p) => p.name)).not.toContain("ui");
  });
  it("falls back to firebase-tools default ports", () => {
    const ports = requiredPorts({ emulators: { firestore: {} } }, [
      "firestore",
    ]);
    expect(ports).toEqual([{ name: "firestore", port: 8080 }]);
  });
  it("only=null means every configured emulator", () => {
    const ports = requiredPorts(FIREBASE_JSON, null);
    expect(ports.map((p) => p.name).sort()).toEqual([
      "auth",
      "firestore",
      "storage",
    ]);
  });
});

describe("findHubLocators", () => {
  it("parses hub-<project>.json files and flags dead pids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubloc-"));
    fs.writeFileSync(
      path.join(dir, "hub-demo-foreign.json"),
      JSON.stringify({
        version: "15.0.0",
        origins: ["http://127.0.0.1:4400"],
        // pid 1 init/systemd is always alive but we can't rely on it on
        // Windows — use a definitely-dead pid instead.
        pid: 999_999_999,
      }),
    );
    fs.writeFileSync(path.join(dir, "hub-malformed.json"), "{not json");
    fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");
    const locators = findHubLocators(dir);
    expect(locators).toHaveLength(1);
    expect(locators[0].projectId).toBe("demo-foreign");
    expect(locators[0].pidAlive).toBe(false);
    expect(locators[0].origins).toEqual(["http://127.0.0.1:4400"]);
  });
});

describe("identifyOccupier", () => {
  it("attributes a port to the suite whose live hub claims it", async () => {
    // Stub a foreign suite's hub /emulators endpoint.
    const hub: Server = createServer((req, res) => {
      if (req.url === "/emulators") {
        res.end(
          JSON.stringify({
            firestore: {
              listen: [{ address: "127.0.0.1", port: 8080, family: "IPv4" }],
            },
          }),
        );
      } else {
        res.end("{}");
      }
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    const addr = hub.address();
    const hubPort = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const occ = await identifyOccupier(8080, [
        {
          projectId: "demo-foreign",
          pid: process.pid, // alive
          origins: [`http://127.0.0.1:${hubPort}`],
          pidAlive: true,
        },
      ]);
      expect(occ.kind).toBe("emulator-suite");
      expect(occ.projectId).toBe("demo-foreign");
      expect(occ.detail).toMatch(/firestore/);
    } finally {
      hub.close();
    }
  });

  it("skips stale locators (dead pid) and falls back to OS lookup", async () => {
    const occ = await identifyOccupier(8080, [
      {
        projectId: "demo-foreign",
        pid: 999_999_999,
        origins: ["http://127.0.0.1:4499"],
        pidAlive: false,
      },
    ]);
    // No hub queryable → unknown; OS lookup may or may not resolve
    // depending on whether 8080 is actually listening on this machine.
    expect(occ.kind).toBe("unknown");
  });
});
