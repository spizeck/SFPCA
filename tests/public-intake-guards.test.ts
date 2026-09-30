// Guard coverage for the unauthenticated intake server actions (#219):
// honeypot short-circuit, rate-limit enforcement, bucket separation,
// and the receipt-entitlement flow — all with the domain services,
// headers, and storage mocked so nothing leaves the process.

import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  checkRateLimit,
  warnThrottled,
  createRegistrationSubmission,
  submitPublicSighting,
  logError,
  logWarn,
  captureException,
  captureRequestError,
  headerStore,
} = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  warnThrottled: vi.fn(),
  createRegistrationSubmission: vi.fn(),
  submitPublicSighting: vi.fn(),
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
}));
vi.mock("@/lib/registry/lost-found", () => ({ submitPublicSighting }));
vi.mock("@/lib/logger", () => ({ logError, logWarn }));
vi.mock("@sentry/nextjs", () => ({ captureException, captureRequestError }));

import { submitRegistrationAction } from "@/app/animal-registration/actions";
import { submitSightingAction } from "@/app/lost-pets/actions";

const validInput = {
  submissionId: "11111111-2222-4333-8444-555555555555",
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

  test("receipt intent is persisted on the row for the upload route", async () => {
    // The upload entitlement is durable: /api/receipts/[id] refuses
    // submissions whose row never declared receiptRequested, so a
    // known submission id alone cannot entitle an attach.
    await submitRegistrationAction({ ...validInput, wantsReceipt: true });
    expect(createRegistrationSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ receiptRequested: true }),
    );
    await submitRegistrationAction({ ...validInput, wantsReceipt: false });
    expect(createRegistrationSubmission).toHaveBeenLastCalledWith(
      expect.objectContaining({ receiptRequested: false }),
    );
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
