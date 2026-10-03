// Tests for /api/cron/retention (#130): cron-secret auth fails closed,
// as_of validation, preview can never purge, the RETENTION_PURGE_ENABLED
// rollout gate forces dry-run until set, and failures surface as 500.
// The pass and the storage/db factories are mocked — the route's own
// decisions are real.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockRunPass } = vi.hoisted(() => ({
  mockRunPass: vi.fn(),
}));

vi.mock("@/lib/registry/retention", () => ({
  runRetentionPass: mockRunPass,
}));

vi.mock("@/lib/db/client", () => ({
  getRegistryDb: () => ({}),
}));

vi.mock("@/lib/firebase-admin-storage", () => ({
  adminReceiptBucket: () => ({}),
}));

import { GET } from "@/app/api/cron/retention/route";

const HOST = "sfpca.example.com";
const SECRET = "cron-secret-test";

const EMPTY_SUMMARY = {
  asOf: "2026-10-05T00:00:00.000Z",
  dryRun: true,
  receipts: { eligible: 0, purged: 0, heldSkipped: 0, failed: 0 },
  abandonedSubmissions: {
    eligible: 0,
    deleted: 0,
    heldSkipped: 0,
    linkedSkipped: 0,
    failed: 0,
  },
  completedRecords: {
    registrationsEligible: 0,
    registrationsHeld: 0,
    submissionsAnonymized: 0,
    registrationsAnonymized: 0,
    paymentsAnonymized: 0,
    heldSkipped: 0,
    failed: 0,
  },
};

const request = (query = "", headers: Record<string, string> = {}) =>
  new NextRequest(`https://${HOST}/api/cron/retention${query}`, {
    method: "GET",
    headers,
  });

const authed = (query = "") =>
  request(query, { authorization: `Bearer ${SECRET}` });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", SECRET);
  mockRunPass.mockReset().mockResolvedValue(EMPTY_SUMMARY);
});

describe("GET /api/cron/retention", () => {
  test("fails closed: no secret configured, or wrong/missing bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(authed())).status).toBe(401);

    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await GET(request())).status).toBe(401);
    expect(
      (await GET(request("", { authorization: "Bearer wrong" }))).status,
    ).toBe(401);
    expect(mockRunPass).not.toHaveBeenCalled();
  });

  test("rejects a malformed as_of rather than guessing", async () => {
    const response = await GET(authed("?as_of=next-tuesday"));
    expect(response.status).toBe(400);
    expect(mockRunPass).not.toHaveBeenCalled();
  });

  test("a future as_of is rejected on live runs but allowed for dry runs", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RETENTION_PURGE_ENABLED", "true");
    const live = await GET(authed("?as_of=2999-01-01"));
    expect(live.status).toBe(400);
    expect(mockRunPass).not.toHaveBeenCalled();

    const dry = await GET(authed("?as_of=2999-01-01&dry_run=1"));
    expect(dry.status).toBe(200);
    expect(mockRunPass).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  test("preview deployments can never purge — even with the flag set", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("RETENTION_PURGE_ENABLED", "true");
    const live = await GET(authed());
    expect(live.status).toBe(403);
    expect(mockRunPass).not.toHaveBeenCalled();

    const dry = await GET(authed("?dry_run=1"));
    expect(dry.status).toBe(200);
    expect(mockRunPass).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  test("without RETENTION_PURGE_ENABLED every run is report-only", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const response = await GET(authed());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.purgeEnabled).toBe(false);
    expect(mockRunPass).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  test("with the flag set a scheduled run is destructive", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RETENTION_PURGE_ENABLED", "true");
    const response = await GET(authed());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.purgeEnabled).toBe(true);
    expect(mockRunPass).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  test("dry_run=1 stays read-only even with the flag set", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RETENTION_PURGE_ENABLED", "true");
    const response = await GET(authed("?dry_run=1&as_of=2026-10-05"));
    expect(response.status).toBe(200);
    expect(mockRunPass).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        now: new Date("2026-10-05T00:00:00Z"),
      }),
    );
  });

  test("partial failures surface as 500 with the summary", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RETENTION_PURGE_ENABLED", "true");
    mockRunPass.mockResolvedValue({
      ...EMPTY_SUMMARY,
      dryRun: false,
      receipts: { eligible: 2, purged: 1, heldSkipped: 0, failed: 1 },
    });
    const response = await GET(authed());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.result.receipts.purged).toBe(1);
  });

  test("a pass error is a 500, not a hang", async () => {
    mockRunPass.mockRejectedValue(new Error("db down"));
    const response = await GET(authed());
    expect(response.status).toBe(500);
  });
});
