// Guard coverage for the unauthenticated intake server actions (#219):
// honeypot short-circuit, rate-limit enforcement, bucket separation,
// and the receipt-entitlement flow — all with the domain services,
// headers, and storage mocked so nothing leaves the process.

import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  checkRateLimit,
  warnThrottled,
  createRegistrationSubmission,
  attachReceiptToSubmission,
  submitPublicSighting,
  adminReceiptBucket,
  logError,
  logWarn,
  captureException,
  captureRequestError,
  headerStore,
} = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  warnThrottled: vi.fn(),
  createRegistrationSubmission: vi.fn(),
  attachReceiptToSubmission: vi.fn(),
  submitPublicSighting: vi.fn(),
  adminReceiptBucket: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
  headerStore: { current: new Map<string, string>() },
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerStore.current.get(k) ?? null }),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit, warnThrottled }));
vi.mock("@/lib/registry/registrations", () => ({
  createRegistrationSubmission,
  attachReceiptToSubmission,
}));
vi.mock("@/lib/registry/lost-found", () => ({ submitPublicSighting }));
vi.mock("@/lib/firebase-admin-storage", () => ({ adminReceiptBucket }));
vi.mock("@/lib/logger", () => ({ logError, logWarn }));
vi.mock("@sentry/nextjs", () => ({ captureException, captureRequestError }));

import {
  finalizeReceiptAction,
  submitRegistrationAction,
} from "@/app/animal-registration/actions";
import { submitSightingAction } from "@/app/lost-pets/actions";

const validInput = {
  submissionId: "11111111-2222-4333-8444-555555555555",
  receiptPath: null,
  ownerName: "Jane Owner",
  ownerAddress: "Windwardside, Saba",
  ownerPhone: "+599 416 0000",
  ownerEmail: "jane@example.com",
  animals: [{ name: "Rex", type: "Dog", sex: "male", isFixed: "yes" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  headerStore.current = new Map([
    ["x-vercel-forwarded-for", "203.0.113.7"],
  ]);
  checkRateLimit.mockResolvedValue({ allowed: true, status: "ok" });
  createRegistrationSubmission.mockResolvedValue({
    ok: true,
    submissionId: validInput.submissionId,
  });
  submitPublicSighting.mockResolvedValue({ ok: true });
  attachReceiptToSubmission.mockResolvedValue({ ok: true, attached: true });
  delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
});

describe("submitRegistrationAction guards", () => {
  test("a legitimate submission passes through to the domain service", async () => {
    const r = await submitRegistrationAction(validInput);
    expect(r.ok).toBe(true);
    expect(createRegistrationSubmission).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "registration.submit",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  test("honeypot-filled submission gets a generic success and writes nothing", async () => {
    const r = await submitRegistrationAction({
      ...validInput,
      website: "https://spam.example",
    });
    expect(r).toEqual({
      ok: true,
      submissionId: validInput.submissionId,
      receiptUpload: null,
    });
    expect(createRegistrationSubmission).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    // Recorded at warn level — expected outcome, never an error event.
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
    expect(captureRequestError).not.toHaveBeenCalled();
  });

  test("a throttled submission is honest, retryable, and writes nothing", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      status: "ok",
      retryAfterSeconds: 300,
    });
    const r = await submitRegistrationAction(validInput);
    expect(r).toEqual({ ok: false, reason: "throttled" });
    expect(createRegistrationSubmission).not.toHaveBeenCalled();
    expect(warnThrottled).toHaveBeenCalledTimes(1);
    // Throttling is not a production failure — no Sentry event.
    expect(logError).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  test("receipt entitlement is minted only after a validated insert", async () => {
    const getSignedUrl = vi
      .fn()
      .mockResolvedValue(["https://storage.example/signed"]);
    adminReceiptBucket.mockReturnValue({
      file: () => ({ getSignedUrl }),
    });
    const r = await submitRegistrationAction({
      ...validInput,
      wantsReceipt: true,
    });
    expect(r.ok && r.receiptUpload).toEqual({
      mode: "signed-url",
      url: "https://storage.example/signed",
    });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  test("the emulator takes the server-save path instead of signed URLs", async () => {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
    const r = await submitRegistrationAction({
      ...validInput,
      wantsReceipt: true,
    });
    expect(r.ok && r.receiptUpload).toEqual({ mode: "server-save" });
  });
});

describe("submitSightingAction guards", () => {
  const sighting = { caseId: "case-1", note: "saw near the trails" };

  test("a legitimate sighting reaches the service", async () => {
    const r = await submitSightingAction(sighting);
    expect(r.ok).toBe(true);
    expect(submitPublicSighting).toHaveBeenCalledTimes(1);
  });

  test("honeypot-filled sighting is silently accepted", async () => {
    const r = await submitSightingAction({ ...sighting, website: "x" });
    expect(r).toEqual({ ok: true });
    expect(submitPublicSighting).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  test("throttled sighting reports a distinct reason", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      status: "ok",
      retryAfterSeconds: 42,
    });
    const r = await submitSightingAction(sighting);
    expect(r).toEqual({ ok: false, reason: "throttled" });
    expect(submitPublicSighting).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("finalizeReceiptAction", () => {
  const submissionId = validInput.submissionId;

  function bucketWith(metadata?: { size: number; contentType: string }) {
    const file = {
      save: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue([metadata]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    adminReceiptBucket.mockReturnValue({ file: vi.fn(() => file) });
    return file;
  }

  test("server-save path validates the file and binds the derived path", async () => {
    const file = bucketWith();
    const receipt = new File([new Uint8Array(10)], "r.png", {
      type: "image/png",
    });
    const r = await finalizeReceiptAction({ submissionId, file: receipt });
    expect(r).toEqual({ ok: true });
    expect(file.save).toHaveBeenCalledTimes(1);
    expect(attachReceiptToSubmission).toHaveBeenCalledWith(submissionId);
  });

  test("signed-url path verifies the landed object before binding", async () => {
    const file = bucketWith({ size: 1024, contentType: "image/png" });
    const r = await finalizeReceiptAction({ submissionId });
    expect(r).toEqual({ ok: true });
    expect(file.save).not.toHaveBeenCalled();
    expect(file.delete).not.toHaveBeenCalled();
    expect(attachReceiptToSubmission).toHaveBeenCalledWith(submissionId);
  });

  test("an invalid landed object is deleted and never bound", async () => {
    const file = bucketWith({ size: 1024, contentType: "text/html" });
    const r = await finalizeReceiptAction({ submissionId });
    expect(r.ok).toBe(false);
    expect(file.delete).toHaveBeenCalledTimes(1);
    expect(attachReceiptToSubmission).not.toHaveBeenCalled();
  });

  test("oversized landed objects are rejected", async () => {
    bucketWith({ size: 5 * 1024 * 1024 + 1, contentType: "image/png" });
    const r = await finalizeReceiptAction({ submissionId });
    expect(r.ok).toBe(false);
    expect(attachReceiptToSubmission).not.toHaveBeenCalled();
  });

  test("receipt finalize is throttled on its own bucket", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      status: "ok",
      retryAfterSeconds: 10,
    });
    const r = await finalizeReceiptAction({ submissionId });
    expect(r).toEqual({ ok: false, reason: "throttled" });
    expect(checkRateLimit).toHaveBeenCalledWith(
      "receipt.finalize",
      expect.any(String),
    );
    expect(attachReceiptToSubmission).not.toHaveBeenCalled();
  });
});
