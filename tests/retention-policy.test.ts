// Unit tests for the retention policy constants/math (#130). These pin
// the calendar semantics the whole policy stands on: registration-year
// end, the 7-years-after-year-end boundary, the 90-day receipt cutoff,
// the 12-month abandoned cutoff, and the rollout gate.
import { describe, expect, test } from "vitest";
import {
  abandonedSubmissionCutoff,
  completedRetentionBoundary,
  isRetentionHoldEntityType,
  isRetentionPurgeEnabled,
  maxCompletedRetentionYear,
  registrationYearEnd,
  RETENTION_PURGE_ENABLED_ENV,
  verifiedReceiptCutoff,
} from "@/lib/retention";

describe("registrationYearEnd", () => {
  test("a registration year ends Dec 31 UTC", () => {
    expect(registrationYearEnd(2026).toISOString()).toBe(
      "2026-12-31T00:00:00.000Z",
    );
  });
});

describe("completedRetentionBoundary", () => {
  test("7 years after year end is expressed calendar-wise, not 7*365d", () => {
    // 2019's records are retained through end-2025 plus 7 full years —
    // they become eligible at the first instant of 2027: 2019 + 7 + 1,
    // expressed calendar-wise in UTC.
    expect(completedRetentionBoundary(2019).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    // Across a leap span this stays calendar-true (2018→2026 crosses
    // two leap days; naive 365d math lands wrong).
    expect(completedRetentionBoundary(2018).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("maxCompletedRetentionYear", () => {
  test("boundary-exact: Jan 1 admits year-7, Dec 31 does not", () => {
    expect(
      maxCompletedRetentionYear(new Date("2026-01-01T00:00:00Z")),
    ).toBe(2018);
    expect(
      maxCompletedRetentionYear(new Date("2025-12-31T23:59:59Z")),
    ).toBe(2017);
    // Mid-year the latest eligible year stays year-8 (a 2019 record is
    // not eligible until Jan 1 2027).
    expect(
      maxCompletedRetentionYear(new Date("2026-10-05T12:00:00Z")),
    ).toBe(2018);
  });
});

describe("verifiedReceiptCutoff", () => {
  test("the 90-day line is exact day arithmetic", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(verifiedReceiptCutoff(now).toISOString()).toBe(
      "2026-07-07T12:00:00.000Z",
    );
  });
});

describe("abandonedSubmissionCutoff", () => {
  test("12 months back keeps the day-of-month", () => {
    expect(
      abandonedSubmissionCutoff(new Date("2026-10-05T12:00:00Z")).toISOString(),
    ).toBe("2025-10-05T12:00:00.000Z");
  });
});

describe("rollout gate + hold vocabulary", () => {
  test("purge requires the env var exactly 'true'", () => {
    expect(isRetentionPurgeEnabled({})).toBe(false);
    expect(
      isRetentionPurgeEnabled({ [RETENTION_PURGE_ENABLED_ENV]: "1" }),
    ).toBe(false);
    expect(
      isRetentionPurgeEnabled({ [RETENTION_PURGE_ENABLED_ENV]: "true" }),
    ).toBe(true);
  });

  test("only the two holdable entity types are accepted", () => {
    expect(isRetentionHoldEntityType("registration_submission")).toBe(true);
    expect(isRetentionHoldEntityType("registration")).toBe(true);
    expect(isRetentionHoldEntityType("animal")).toBe(false);
    expect(isRetentionHoldEntityType("payments")).toBe(false);
    expect(isRetentionHoldEntityType(42)).toBe(false);
  });
});
