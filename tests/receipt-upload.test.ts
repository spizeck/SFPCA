// @vitest-environment node
// Route-handler tests for POST /api/receipts/[submissionId] (#219
// review). Registry, limiter, storage, and logger are mocked at the
// module boundary — these tests pin down ordering (rate-limit → claim
// → bounded read → type check → create-only write), rejection status
// codes, and that no object is persisted before authorization.
// Claim/race semantics against real SQL live in receipt-claim.test.ts.
// Node environment: the route streams request.body, which jsdom does
// not implement.

import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  checkRateLimit,
  warnThrottled,
  claimReceiptSlot,
  releaseReceiptSlot,
  publicIntakeSubject,
  adminReceiptBucket,
  logError,
} = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  warnThrottled: vi.fn(),
  claimReceiptSlot: vi.fn(),
  releaseReceiptSlot: vi.fn(),
  publicIntakeSubject: vi.fn(),
  adminReceiptBucket: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit, warnThrottled }));
vi.mock("@/lib/request-identity", () => ({ publicIntakeSubject }));
vi.mock("@/lib/registry/registrations", () => ({
  claimReceiptSlot,
  releaseReceiptSlot,
}));
vi.mock("@/lib/firebase-admin-storage", () => ({ adminReceiptBucket }));
vi.mock("@/lib/logger", () => ({ logError, logWarn: vi.fn() }));

import { POST } from "@/app/api/receipts/[submissionId]/route";

const SUBMISSION_ID = "11111111-2222-4333-8444-555555555555";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(32)]);
const HTML = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>");
const OVER_MAX = Buffer.alloc(5 * 1024 * 1024 + 1);

function ctx(submissionId: string) {
  return { params: Promise.resolve({ submissionId }) };
}

function uploadRequest(
  body: BodyInit,
  contentType = "image/png",
  extraHeaders: Record<string, string> = {},
) {
  return new Request(`http://test/api/receipts/${SUBMISSION_ID}`, {
    method: "POST",
    headers: { "content-type": contentType, ...extraHeaders },
    body,
  });
}

function fakeBucket() {
  const file = {
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const fileFor = vi.fn(() => file);
  adminReceiptBucket.mockReturnValue({ file: fileFor });
  return { file, fileFor };
}

beforeEach(() => {
  vi.clearAllMocks();
  publicIntakeSubject.mockResolvedValue("s".repeat(64));
  checkRateLimit.mockResolvedValue({ allowed: true, status: "ok" });
  claimReceiptSlot.mockResolvedValue({ ok: true });
  releaseReceiptSlot.mockResolvedValue(undefined);
  fakeBucket();
});

describe("POST /api/receipts/[submissionId]", () => {
  test("a legitimate PNG lands create-only at the derived path", async () => {
    const { file, fileFor } = fakeBucket();
    const res = await POST(uploadRequest(PNG), ctx(SUBMISSION_ID));

    expect(res.status).toBe(200);
    expect(fileFor).toHaveBeenCalledWith(`receipts/${SUBMISSION_ID}`);
    // Detected (not declared) type is stored; write is create-only.
    expect(file.save).toHaveBeenCalledWith(
      PNG,
      expect.objectContaining({
        contentType: "image/png",
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
    );
    expect(releaseReceiptSlot).not.toHaveBeenCalled();
  });

  test("a legitimate PDF lands", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(PDF, "application/pdf"),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(200);
    expect(file.save).toHaveBeenCalledWith(
      PDF,
      expect.objectContaining({ contentType: "application/pdf" }),
    );
  });

  test("the limiter runs before the claim and before any bytes", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      status: "ok",
      retryAfterSeconds: 30,
    });
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(PNG, "image/png"),
      ctx(SUBMISSION_ID),
    );

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "receipt.finalize",
      "s".repeat(64),
    );
    // Nothing downstream ran: no claim, no write, no release.
    expect(claimReceiptSlot).not.toHaveBeenCalled();
    expect(file.save).not.toHaveBeenCalled();
    expect(warnThrottled).toHaveBeenCalledTimes(1);
  });

  test("a malformed submission id is rejected before any work", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(PNG),
      ctx("receipts/../../etc/passwd"),
    );
    expect(res.status).toBe(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(claimReceiptSlot).not.toHaveBeenCalled();
    expect(file.save).not.toHaveBeenCalled();
  });

  test("a nonexistent submission gets 404 and writes nothing", async () => {
    claimReceiptSlot.mockResolvedValue({ ok: false, reason: "not-found" });
    const { file } = fakeBucket();
    const res = await POST(uploadRequest(PNG), ctx(SUBMISSION_ID));
    expect(res.status).toBe(404);
    expect(file.save).not.toHaveBeenCalled();
  });

  test("an already-claimed submission gets 409 and writes nothing", async () => {
    claimReceiptSlot.mockResolvedValue({ ok: false, reason: "unavailable" });
    const { file } = fakeBucket();
    const res = await POST(uploadRequest(PNG), ctx(SUBMISSION_ID));
    expect(res.status).toBe(409);
    expect(file.save).not.toHaveBeenCalled();
    // The claim was never ours — never release someone else's slot.
    expect(releaseReceiptSlot).not.toHaveBeenCalled();
  });

  test("a body over 5 MB is rejected before persistence", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(OVER_MAX, "image/png"),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(413);
    expect(file.save).not.toHaveBeenCalled();
    // The claim is released so a legit retry can proceed.
    expect(releaseReceiptSlot).toHaveBeenCalledWith(SUBMISSION_ID);
  });

  test("a declared-over-limit Content-Length short-circuits the same way", async () => {
    const { file } = fakeBucket();
    const req = uploadRequest(PNG, "image/png", {
      "content-length": String(6 * 1024 * 1024),
    });
    const res = await POST(req, ctx(SUBMISSION_ID));
    expect(res.status).toBe(413);
    expect(file.save).not.toHaveBeenCalled();
  });

  test("an empty body is rejected before persistence", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      new Request(`http://test/api/receipts/${SUBMISSION_ID}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
      }),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(400);
    expect(file.save).not.toHaveBeenCalled();
  });

  test("non-receipt bytes are rejected before persistence", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(HTML, "image/png"),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(415);
    expect(file.save).not.toHaveBeenCalled();
    expect(releaseReceiptSlot).toHaveBeenCalledWith(SUBMISSION_ID);
  });

  test("bytes contradicting the declared type are rejected", async () => {
    const { file } = fakeBucket();
    // Declared PDF, actual PNG — the mismatch itself is disqualifying.
    const res = await POST(
      uploadRequest(PNG, "application/pdf"),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(415);
    expect(file.save).not.toHaveBeenCalled();
  });

  test("an HTML file is rejected even when declared as image", async () => {
    const { file } = fakeBucket();
    const res = await POST(
      uploadRequest(HTML, "image/html"),
      ctx(SUBMISSION_ID),
    );
    expect(res.status).toBe(415);
    expect(file.save).not.toHaveBeenCalled();
  });

  test("a storage write failure releases the claim and reports 500", async () => {
    const { file } = fakeBucket();
    file.save.mockRejectedValue(new Error("gcs down"));
    const res = await POST(uploadRequest(PNG), ctx(SUBMISSION_ID));
    expect(res.status).toBe(500);
    expect(releaseReceiptSlot).toHaveBeenCalledWith(SUBMISSION_ID);
    // A real infrastructure fault logs through the error channel.
    expect(logError).toHaveBeenCalledWith(
      "receipt",
      "upload-write",
      expect.any(Error),
    );
  });
});
