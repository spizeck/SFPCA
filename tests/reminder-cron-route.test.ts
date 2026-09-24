// Tests for /api/cron/reminders (#172): cron-secret auth fails closed,
// as_of validation, dry-run cannot send, and a live run refuses to
// silently queue when no provider is configured. The cycle and the
// provider factory are mocked — the route's own decisions are real.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockRunCycle, mockCreateSender } = vi.hoisted(() => ({
  mockRunCycle: vi.fn(),
  mockCreateSender: vi.fn(),
}));

vi.mock("@/lib/registry/reminders", () => ({
  runReminderCycle: mockRunCycle,
}));

vi.mock("@/lib/email", () => ({
  createResendSender: mockCreateSender,
}));

import { GET } from "@/app/api/cron/reminders/route";

const HOST = "sfpca.example.com";
const SECRET = "cron-secret-test";

const request = (query = "", headers: Record<string, string> = {}) =>
  new NextRequest(`https://${HOST}/api/cron/reminders${query}`, {
    method: "GET",
    headers,
  });

const authed = (query = "") =>
  request(query, { authorization: `Bearer ${SECRET}` });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", SECRET);
  mockRunCycle.mockReset().mockResolvedValue({
    asOf: "2026-09-23",
    dryRun: false,
    evaluated: 0,
    queued: 0,
    skipped: 0,
    suppressed: 0,
    suppressedByReason: {},
    skippedByReason: {},
    delivery: { claimed: 0, sent: 0, requeued: 0, failed: 0, malformed: 0, reclaimed: 0 },
  });
  mockCreateSender.mockReset().mockReturnValue({ provider: "resend", send: vi.fn() });
});

describe("GET /api/cron/reminders", () => {
  test("fails closed: no secret configured, or wrong/missing bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(authed())).status).toBe(401);

    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await GET(request())).status).toBe(401);
    expect(
      (await GET(request("", { authorization: "Bearer wrong" }))).status,
    ).toBe(401);
    expect(mockRunCycle).not.toHaveBeenCalled();
  });

  test("rejects a malformed as_of rather than guessing", async () => {
    const response = await GET(authed("?as_of=next-tuesday"));
    expect(response.status).toBe(400);
    expect(mockRunCycle).not.toHaveBeenCalled();
  });

  test("a live run refuses when the provider is not configured", async () => {
    mockCreateSender.mockReturnValue(null);
    const response = await GET(authed());
    expect(response.status).toBe(503);
    expect(mockRunCycle).not.toHaveBeenCalled();
  });

  test("dry-run runs with no provider and can never send", async () => {
    mockCreateSender.mockReturnValue(null); // must not matter
    mockRunCycle.mockResolvedValue({
      asOf: "2026-09-23",
      dryRun: true,
      evaluated: 3,
      queued: 2,
      skipped: 1,
      suppressed: 0,
      suppressedByReason: {},
      skippedByReason: { "missing-email": 1 },
      delivery: "dry-run",
    });
    const response = await GET(authed("?dry_run=1&as_of=2026-09-23"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.result.delivery).toBe("dry-run");
    // The dry-run path is handed a null sender — structurally unable
    // to deliver regardless of provider configuration.
    expect(mockRunCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        asOf: "2026-09-23",
        dryRun: true,
        sender: null,
      }),
    );
  });

  test("a live run passes the sender through and reports the result", async () => {
    const sender = { provider: "resend", send: vi.fn() };
    mockCreateSender.mockReturnValue(sender);
    const response = await GET(authed("?as_of=2026-09-23"));
    expect(response.status).toBe(200);
    expect(mockRunCycle).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: "2026-09-23", dryRun: false, sender }),
    );
  });

  test("a cycle error is a 500, not a hang", async () => {
    mockRunCycle.mockRejectedValue(new Error("db down"));
    const response = await GET(authed());
    expect(response.status).toBe(500);
  });
});
