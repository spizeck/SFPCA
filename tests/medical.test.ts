// Pure-function tests for the veterinary continuity rules (#174) —
// weight parsing/conversion, derived medication activity, timeline
// ordering. The service-level behavior (FKs, audits, concurrency) is
// covered by tests/db/medical.test.ts.

import { describe, test, expect } from "vitest";
import {
  compareTimelineItems,
  followUpState,
  formatWeightGrams,
  isMedicationActive,
  isPastOrTodayIsoDate,
  parseWeightToGrams,
  MAX_WEIGHT_GRAMS,
} from "@/lib/medical";

describe("parseWeightToGrams", () => {
  test("converts kg and lb to integer grams", () => {
    expect(parseWeightToGrams("12.4", "kg")).toBe(12400);
    expect(parseWeightToGrams("10", "lb")).toBe(4536); // 4535.92 → 4536
    expect(parseWeightToGrams("0.125", "kg")).toBe(125);
  });

  test("rejects empty, non-numeric, and non-positive input", () => {
    expect(parseWeightToGrams("", "kg")).toBeNull();
    expect(parseWeightToGrams("   ", "kg")).toBeNull();
    expect(parseWeightToGrams("abc", "kg")).toBeNull();
    expect(parseWeightToGrams("0", "kg")).toBeNull();
    expect(parseWeightToGrams("-3", "lb")).toBeNull();
  });

  test("rejects implausible values above the CHECK bound", () => {
    expect(parseWeightToGrams("201", "kg")).toBeNull();
    expect(parseWeightToGrams("200", "kg")).toBe(MAX_WEIGHT_GRAMS);
  });
});

describe("formatWeightGrams", () => {
  test("renders kg with one decimal", () => {
    expect(formatWeightGrams(12400)).toBe("12.4 kg");
    expect(formatWeightGrams(4536)).toBe("4.5 kg");
  });
});

describe("isMedicationActive", () => {
  test("a course is active inside [startOn, endOn], open end = ongoing", () => {
    expect(isMedicationActive("2026-01-01", "2026-02-01", "2026-01-15")).toBe(
      true,
    );
    expect(isMedicationActive("2026-01-01", "2026-02-01", "2026-02-01")).toBe(
      true,
    );
    expect(isMedicationActive("2026-01-01", "2026-02-01", "2026-02-02")).toBe(
      false,
    );
    expect(isMedicationActive("2026-01-01", null, "2099-01-01")).toBe(true);
    expect(isMedicationActive("2026-06-01", null, "2026-01-01")).toBe(false);
  });
});

describe("compareTimelineItems", () => {
  const item = (date: string | null, createdAt: string) => ({
    date,
    createdAt,
  });

  test("newest date first; undated entries sink to the bottom", () => {
    const sorted = [
      item("2026-01-01", "2026-01-01T00:00:00Z"),
      item(null, "2026-01-01T00:00:00Z"),
      item("2026-03-01", "2026-01-01T00:00:00Z"),
    ].sort(compareTimelineItems);
    expect(sorted.map((i) => i.date)).toEqual([
      "2026-03-01",
      "2026-01-01",
      null,
    ]);
  });

  test("same-date ties break on createdAt, newest first", () => {
    const sorted = [
      item("2026-03-01", "2026-03-01T08:00:00Z"),
      item("2026-03-01", "2026-03-01T12:00:00Z"),
    ].sort(compareTimelineItems);
    expect(sorted[0].createdAt).toBe("2026-03-01T12:00:00Z");
  });
});

describe("isPastOrTodayIsoDate", () => {
  test("accepts past/today real dates and rejects future or malformed", () => {
    expect(isPastOrTodayIsoDate("2026-01-01", "2026-03-01")).toBe(true);
    expect(isPastOrTodayIsoDate("2026-03-01", "2026-03-01")).toBe(true);
    expect(isPastOrTodayIsoDate("2026-03-02", "2026-03-01")).toBe(false);
    expect(isPastOrTodayIsoDate("2026-02-30", "2026-03-01")).toBe(false);
    expect(isPastOrTodayIsoDate("not-a-date", "2026-03-01")).toBe(false);
  });
});

// #175: the queue's headline state is derived, never stored. The exact
// boundary is part of the contract — due today is DUE, not overdue.
describe("followUpState", () => {
  const TODAY = "2026-10-15";

  test("terminal stored states win over any date", () => {
    expect(followUpState("2020-01-01", "completed", TODAY)).toBe("completed");
    expect(followUpState("2099-01-01", "cancelled", TODAY)).toBe("cancelled");
  });

  test("open items derive overdue / due / upcoming from due_on vs today", () => {
    expect(followUpState("2026-10-14", "open", TODAY)).toBe("overdue");
    // The boundary: due today is 'due', not overdue.
    expect(followUpState(TODAY, "open", TODAY)).toBe("due");
    expect(followUpState("2026-10-16", "open", TODAY)).toBe("upcoming");
  });

  test("an unexpected stored status still derives a date-relative state", () => {
    // Defensive: an unknown status behaves like 'open' — the date is
    // the only trustworthy signal.
    expect(followUpState("2026-10-14", "legacy-done", TODAY)).toBe("overdue");
  });
});
