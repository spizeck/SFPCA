// Tests for /api/cron/sweep-receipts: cron-secret auth fails closed and
// preview deployments are refused (#271 — the sweep deletes objects in
// the SHARED production Storage bucket using the preview Neon branch's
// rows as the orphan oracle). The sweep internals are mocked — the
// route's own decisions are real.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockSweepReceipts, mockSweepVetDocs, mockBucket, mockDb } =
  vi.hoisted(() => ({
    mockSweepReceipts: vi.fn(),
    mockSweepVetDocs: vi.fn(),
    mockBucket: {},
    mockDb: {},
  }));

vi.mock("@/lib/firebase-admin-storage", () => ({
  adminReceiptBucket: () => mockBucket,
}));
vi.mock("@/lib/db/client", () => ({
  getRegistryDb: () => mockDb,
}));
// The demo-mode guard skips the sweep while prelaunch — resolve 'live'
// deterministically so these tests exercise the normal path.
vi.mock("@/lib/app-lifecycle", () => ({
  getAppLifecycle: vi.fn().mockResolvedValue("live"),
}));
vi.mock("@/lib/registry/receipt-sweep", () => ({
  sweepOrphanedReceipts: mockSweepReceipts,
}));
vi.mock("@/lib/registry/vet-document-sweep", () => ({
  sweepOrphanedVetDocuments: mockSweepVetDocs,
}));

import { GET } from "@/app/api/cron/sweep-receipts/route";

const SECRET = "cron-secret-test";

const request = (headers: Record<string, string> = {}) =>
  new NextRequest("https://sfpca.example.com/api/cron/sweep-receipts", {
    method: "GET",
    headers,
  });

const authed = () => request({ authorization: `Bearer ${SECRET}` });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", SECRET);
  mockSweepReceipts.mockReset().mockResolvedValue({ failed: 0 });
  mockSweepVetDocs.mockReset().mockResolvedValue({ failed: 0 });
});

describe("GET /api/cron/sweep-receipts", () => {
  test("fails closed: no secret configured, or wrong/missing bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(authed())).status).toBe(401);

    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await GET(request())).status).toBe(401);
    expect(
      (await GET(request({ authorization: "Bearer wrong" }))).status,
    ).toBe(401);
    expect(mockSweepReceipts).not.toHaveBeenCalled();
    expect(mockSweepVetDocs).not.toHaveBeenCalled();
  });

  test("preview deployments are refused before any sweep runs", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await GET(authed());
    expect(response.status).toBe(403);
    expect(mockSweepReceipts).not.toHaveBeenCalled();
    expect(mockSweepVetDocs).not.toHaveBeenCalled();
  });

  test("production and local runs execute both sweeps", async () => {
    for (const env of ["production", undefined]) {
      // stubEnv(name, undefined) deletes and stays tracked so
      // unstubAllEnvs restores correctly across the loop.
      vi.stubEnv("VERCEL_ENV", env);
      mockSweepReceipts.mockClear();
      mockSweepVetDocs.mockClear();
      const response = await GET(authed());
      expect(response.status).toBe(200);
      expect(mockSweepReceipts).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: mockBucket, db: mockDb }),
      );
      expect(mockSweepVetDocs).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: mockBucket, db: mockDb }),
      );
    }
  });
});
