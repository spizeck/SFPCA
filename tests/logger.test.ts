// Tests for the logging convention: errors are normalized to safe
// fields, messages are bounded, and log entries never carry raw error
// objects, stacks, or arbitrary payloads.
import { afterEach, describe, expect, test, vi } from "vitest";
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
  afterEach(() => vi.restoreAllMocks());

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
