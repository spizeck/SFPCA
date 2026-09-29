// Tests for the logging convention: errors are normalized to safe
// fields, messages are bounded, log entries never carry raw error
// objects, stacks, or arbitrary payloads — and caught unexpected
// failures forward to Sentry through the one centralized path (#218).
import { afterEach, describe, expect, test, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException }));

import {
  logError,
  logInfo,
  logWarn,
  normalizeError,
} from "@/lib/logger";

describe("normalizeError", () => {
  test("extracts name, code, and truncated message from errors", () => {
    const err = Object.assign(new Error("x".repeat(500)), {
      code: "permission-denied",
    });
    const safe = normalizeError(err);
    expect(safe.name).toBe("Error");
    expect(safe.code).toBe("permission-denied");
    expect(safe.message).toHaveLength(200);
    // The stack and any attached objects are dropped.
    expect(safe).not.toHaveProperty("stack");
    expect(Object.keys(safe).sort()).toEqual(["code", "message", "name"]);
  });

  test("handles strings and non-error throws", () => {
    expect(normalizeError("boom")).toEqual({
      name: "Error",
      message: "boom",
    });
    expect(normalizeError(undefined)).toEqual({
      name: "Error",
      message: "Non-error thrown",
    });
    expect(normalizeError({ weird: true }).name).toBe("Error");
  });
});

describe("log functions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("logError emits subsystem, operation, and safe error fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("registration", "submit", new Error("write failed"), {
      attempt: 2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [entry] = spy.mock.calls[0];
    const parsed =
      typeof entry === "string" ? JSON.parse(entry) : (entry as object);
    expect(parsed).toMatchObject({
      level: "error",
      subsystem: "registration",
      operation: "submit",
      errorName: "Error",
      errorMessage: "write failed",
      attempt: 2,
    });
    // In development the raw error is passed as a second arg for the
    // devtools stack — but the structured entry itself stays clean.
    if (spy.mock.calls[0].length > 1) {
      expect(spy.mock.calls[0][1]).toBeInstanceOf(Error);
    }
  });

  test("logError forwards the original Error to Sentry with safe context", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("pg connection lost"), {
      code: "ECONNREFUSED",
    });
    logError("communications", "reminder-cron", error, {
      asOf: "2026-01-01",
      attempt: 2,
    });
    // The real exception object is captured — never reduced to a
    // message string, so the original stack survives.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { subsystem: "communications", operation: "reminder-cron" },
      extra: { asOf: "2026-01-01", attempt: 2, errorCode: "ECONNREFUSED" },
    });
  });

  test("logError does not forward a Next.js digested server error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A server error serialized to the client carries a digest — the
    // real exception was already captured server-side; forwarding the
    // generic placeholder would double-report.
    const digested = Object.assign(
      new Error("An error occurred in the Server Components render"),
      { digest: "abc123" },
    );
    logError("animals", "admin-save-ui", digested);
    expect(captureException).not.toHaveBeenCalled();
  });

  test("logError honors the sentry opt-out for self-reporting sites", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    logError(
      "ui",
      "render",
      new Error("boundary"),
      { digest: "d" },
      { sentry: false },
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  test("logError forwards non-Error values unchanged", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    logError("content", "fetch-site-settings", "plain string failure");
    expect(captureException).toHaveBeenCalledWith(
      "plain string failure",
      expect.objectContaining({
        tags: { subsystem: "content", operation: "fetch-site-settings" },
      }),
    );
  });

  test("a Sentry failure cannot break the logging path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    captureException.mockImplementationOnce(() => {
      throw new Error("sentry exploded");
    });
    expect(() =>
      logError("reports", "export", new Error("real failure")),
    ).not.toThrow();
    // The structured console entry was still emitted.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("warn and info never touch Sentry", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    logWarn("session", "create", "session request rejected");
    logInfo("content", "fetch", "settings loaded");
    expect(captureException).not.toHaveBeenCalled();
  });

  test("warn and info carry static messages and safe context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logWarn("auth", "sign-in", "authentication rejected", {
      errorCode: "auth/wrong-password",
    });
    logInfo("content", "fetch", "settings loaded");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
