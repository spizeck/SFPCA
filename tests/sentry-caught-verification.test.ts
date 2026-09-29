// The caught-path half of /admin/sentry-check (#218): the action
// throws, catches, and logs through logError — the exact shape every
// operational catch block uses. This proves end-to-end (minus the
// network) that a caught failure produces a safe result AND reaches
// the Sentry capture path. The SDK is mocked; nothing can contact
// sentry.io.
import { afterEach, describe, expect, test, vi } from "vitest";

const { captureException, requireAdmin } = vi.hoisted(() => ({
  captureException: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException }));
vi.mock("@/lib/auth", () => ({ requireAdmin }));

import { fireSentryCaughtVerification } from "@/app/admin/sentry-check/actions";
import { SENTRY_VERIFICATION_MARKER } from "@/lib/sentry-verification";

describe("fireSentryCaughtVerification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("caught failure returns the safe result and reports via logError", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    requireAdmin.mockResolvedValue({ authorized: true });

    const result = await fireSentryCaughtVerification();

    // The caller sees the normal handled result, not the exception.
    expect(result).toEqual({ fired: true });

    // The real Error reached the Sentry capture path with the
    // subsystem/operation tags — the same payload every operational
    // logError produces.
    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, opts] = captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      `${SENTRY_VERIFICATION_MARKER}:caught`,
    );
    expect(opts).toMatchObject({
      tags: { subsystem: "admin", operation: "sentry-check-caught" },
    });

    // The structured console entry was emitted alongside the capture.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  test("unauthorized callers get the quiet denial — no log, no event", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    requireAdmin.mockResolvedValue({ authorized: false });

    const result = await fireSentryCaughtVerification();

    expect(result).toEqual({ fired: false });
    expect(captureException).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
