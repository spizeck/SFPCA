// Unit tests for the Postgres-aware orphan-receipt sweeper (#183,
// claim-aware per #219 review). The claim/existence seam is mocked;
// the scan/delete/clear decision matrix (grace period, malformed
// names, per-object failure isolation, dangling claims, log privacy)
// is real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockClaims, mockListClaims, mockClearClaim } = vi.hoisted(() => ({
  mockClaims: vi.fn(),
  mockListClaims: vi.fn(),
  mockClearClaim: vi.fn(),
}));

vi.mock("@/lib/registry/registrations", () => ({
  submissionClaimsReceipt: mockClaims,
  listReceiptClaims: mockListClaims,
  clearReceiptClaim: mockClearClaim,
}));

import {
  sweepOrphanedReceipts,
  type SweepBucket,
  type SweepFile,
} from "@/lib/registry/receipt-sweep";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-01T12:00:00Z");

function fakeBucket(files: SweepFile[]): SweepBucket {
  return { getFiles: async () => [files] };
}

function fakeLog() {
  const calls = {
    info: [] as object[],
    warn: [] as object[],
    error: [] as object[],
  };
  return {
    calls,
    info: (e: object) => calls.info.push(e),
    warn: (e: object) => calls.warn.push(e),
    error: (e: object) => calls.error.push(e),
    all: () => JSON.stringify(calls),
  };
}

interface FakeFile extends SweepFile {
  deleted: boolean;
}

function fakeFile(
  name: string,
  ageMs = 2 * HOUR,
  failDelete = false,
): FakeFile {
  return {
    name: `receipts/${name}`,
    metadata: { timeCreated: new Date(NOW - ageMs).toISOString() },
    deleted: false,
    delete: async function () {
      if (failDelete) throw Object.assign(new Error("io"), { code: "500" });
      this.deleted = true;
    },
  };
}

// The sweeper never dereferences the db argument itself — the mocked
// claim seam owns it.
const db = {} as Parameters<typeof sweepOrphanedReceipts>[0]["db"];

beforeEach(() => {
  mockClaims.mockReset().mockResolvedValue(false);
  mockListClaims.mockReset().mockResolvedValue([]);
  mockClearClaim.mockReset().mockResolvedValue(undefined);
});

describe("sweepOrphanedReceipts", () => {
  test("deletes orphans, keeps claimed and recent objects", async () => {
    const log = fakeLog();
    const orphan = fakeFile("orphan-id");
    const referenced = fakeFile("known-id");
    const recent = fakeFile("inflight-id", 5 * 60 * 1000);
    const nested = { name: "receipts/nested/path" } as SweepFile;
    mockClaims.mockImplementation(
      async (path: string) => path === "receipts/known-id",
    );

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([orphan, referenced, recent, nested]),
      db,
      nowMs: NOW,
      log,
      runId: "run-1",
    });

    expect(orphan.deleted).toBe(true);
    expect(referenced.deleted).toBe(false);
    expect(recent.deleted).toBe(false);
    expect(counts).toEqual({
      scanned: 3,
      deleted: 1,
      skippedRecent: 1,
      skippedMalformed: 1,
      danglingCleared: 0,
      failed: 0,
    });
    expect(log.calls.info[0]).toMatchObject({ outcome: "ok" });
    // Submission ids / receipt paths must never appear in logs.
    for (const name of ["orphan-id", "known-id", "inflight-id"]) {
      expect(log.all()).not.toContain(name);
    }
  });

  test("an object at a known submission id is still deleted when the row does not claim it", async () => {
    // The #219 fix: a submission row existing is no longer sufficient —
    // the row must claim THIS path. An attacker-written object at a
    // legitimate id gets swept like any other orphan.
    const log = fakeLog();
    const squat = fakeFile("squatted-id");
    mockClaims.mockResolvedValue(false);

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([squat]),
      db,
      nowMs: NOW,
      log,
    });

    expect(squat.deleted).toBe(true);
    expect(counts.deleted).toBe(1);
  });

  test("a migrated legacy-named receipt survives when its row claims the path", async () => {
    // Pre-#219 rows carry paths like receipts/scan-001.pdf — not
    // receipts/<uuid>. The claim lookup matches the stored path, so a
    // legacy-named object a row still references is never swept.
    const log = fakeLog();
    const legacy = fakeFile("scan-001.pdf");
    mockClaims.mockImplementation(
      async (path: string) => path === "receipts/scan-001.pdf",
    );

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([legacy]),
      db,
      nowMs: NOW,
      log,
    });

    expect(legacy.deleted).toBe(false);
    expect(counts.deleted).toBe(0);
    expect(mockClaims).toHaveBeenCalledWith("receipts/scan-001.pdf", db);
  });

  test("a claim whose object never landed is cleared past the grace window", async () => {
    // Upload route writes claim → object; a claim older than grace with
    // no matching object is a wedged submission — clear it so retries
    // can proceed.
    const log = fakeLog();
    mockListClaims.mockResolvedValue([
      {
        id: "dangling-id",
        paymentReceiptPath: "receipts/dangling-id",
        claimedAt: new Date(NOW - 2 * HOUR),
      },
      {
        id: "fresh-id",
        paymentReceiptPath: "receipts/fresh-id",
        claimedAt: new Date(NOW - 5 * 60 * 1000),
      },
      {
        id: "live-id",
        paymentReceiptPath: "receipts/live-id",
        claimedAt: new Date(NOW - 2 * HOUR),
      },
    ]);
    const live = fakeFile("live-id");
    mockClaims.mockImplementation(
      async (path: string) => path === "receipts/live-id",
    );

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([live]),
      db,
      nowMs: NOW,
      log,
    });

    expect(counts.danglingCleared).toBe(1);
    expect(mockClearClaim).toHaveBeenCalledWith("dangling-id", db);
    // Fresh claims (still inside the grace window) and claims whose
    // object exists are untouched.
    expect(mockClearClaim).not.toHaveBeenCalledWith("fresh-id", db);
    expect(mockClearClaim).not.toHaveBeenCalledWith("live-id", db);
    expect(live.deleted).toBe(false);
  });

  test("per-object failure is counted, the run continues, error logged", async () => {
    const log = fakeLog();
    const bad = fakeFile("bad-id", 2 * HOUR, true);
    const good = fakeFile("good-id");

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([bad, good]),
      db,
      nowMs: NOW,
      log,
    });

    expect(counts.deleted).toBe(1);
    expect(counts.failed).toBe(1);
    expect(good.deleted).toBe(true);
    expect(log.calls.error[0]).toMatchObject({ outcome: "partial-failure" });
    expect(log.all()).not.toContain("bad-id");
  });

  test("a claim-check error counts as failure without deleting", async () => {
    const log = fakeLog();
    mockClaims.mockRejectedValue(new Error("db down"));
    const file = fakeFile("any-id");

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([file]),
      db,
      nowMs: NOW,
      log,
    });

    expect(file.deleted).toBe(false);
    expect(counts.failed).toBe(1);
    expect(counts.deleted).toBe(0);
  });

  test("undated objects are never deleted", async () => {
    const undated = {
      name: "receipts/undated-id",
      metadata: {},
      delete: vi.fn(),
    } as unknown as SweepFile;

    const counts = await sweepOrphanedReceipts({
      bucket: fakeBucket([undated]),
      db,
      nowMs: NOW,
      log: fakeLog(),
    });

    expect(counts.skippedRecent).toBe(1);
    expect(undated.delete).not.toHaveBeenCalled();
  });
});
