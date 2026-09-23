// Unit tests for the Postgres-aware orphan-receipt sweeper (#183).
// The submission-existence check is mocked; the scan/delete decision
// matrix (grace period, malformed names, per-object failure isolation,
// log privacy) is real.
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockExists } = vi.hoisted(() => ({ mockExists: vi.fn() }));

vi.mock("@/lib/registry/registrations", () => ({
  registrationSubmissionExists: mockExists,
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
// existence seam owns it.
const db = {} as Parameters<typeof sweepOrphanedReceipts>[0]["db"];

beforeEach(() => {
  mockExists.mockReset().mockResolvedValue(false);
});

describe("sweepOrphanedReceipts", () => {
  test("deletes orphans, keeps referenced and recent objects", async () => {
    const log = fakeLog();
    const orphan = fakeFile("orphan-id");
    const referenced = fakeFile("known-id");
    const recent = fakeFile("inflight-id", 5 * 60 * 1000);
    const nested = { name: "receipts/nested/path" } as SweepFile;
    mockExists.mockImplementation(async (id: string) => id === "known-id");

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
      failed: 0,
    });
    expect(log.calls.info[0]).toMatchObject({ outcome: "ok" });
    // Submission ids / receipt paths must never appear in logs.
    for (const name of ["orphan-id", "known-id", "inflight-id"]) {
      expect(log.all()).not.toContain(name);
    }
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

  test("an existence-check error counts as failure without deleting", async () => {
    const log = fakeLog();
    mockExists.mockRejectedValue(new Error("db down"));
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
