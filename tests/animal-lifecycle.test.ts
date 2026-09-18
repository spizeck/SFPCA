// Unit tests for the canonical animal lifecycle module. Public visibility
// is security-sensitive: these tests pin down the fail-closed contract —
// only "available" is public, and unknown/malformed values are never
// treated as a supported state.
import { describe, expect, test } from "vitest";
import {
  ANIMAL_STATUSES,
  ANIMAL_STATUS_LABELS,
  PUBLIC_ANIMAL_STATUS,
  canTransitionAnimalStatus,
  getAnimalStatusLabel,
  getAnimalStatusVisibilityHint,
  isAnimalStatus,
  isPublicAnimalStatus,
} from "../src/lib/animal-lifecycle";

describe("supported statuses", () => {
  test("the lifecycle is exactly available/pending/adopted", () => {
    expect([...ANIMAL_STATUSES]).toEqual([
      "available",
      "pending",
      "adopted",
    ]);
  });

  test("every supported status has a human-readable label", () => {
    for (const status of ANIMAL_STATUSES) {
      expect(ANIMAL_STATUS_LABELS[status]).toBeTruthy();
      expect(getAnimalStatusLabel(status)).toBe(ANIMAL_STATUS_LABELS[status]);
    }
  });
});

describe("isAnimalStatus", () => {
  test.each(ANIMAL_STATUSES)("accepts supported status %s", (status) => {
    expect(isAnimalStatus(status)).toBe(true);
  });

  test.each([
    "Available", // case-sensitive
    "availble", // typo
    "draft",
    "archived",
    "",
    " available ",
  ])("rejects unrecognized status %j", (status) => {
    expect(isAnimalStatus(status)).toBe(false);
  });

  test.each([undefined, null, 0, 1, true, {}, [], "pending"])(
    "rejects non-string or valid-but-unexpected values correctly: %j",
    (value) => {
      expect(isAnimalStatus(value)).toBe(value === "pending");
    },
  );
});

describe("public visibility", () => {
  test("only 'available' is publicly visible", () => {
    expect(PUBLIC_ANIMAL_STATUS).toBe("available");
    expect(isPublicAnimalStatus("available")).toBe(true);
    for (const status of ANIMAL_STATUSES) {
      if (status !== "available") {
        expect(isPublicAnimalStatus(status)).toBe(false);
      }
    }
  });

  test.each([undefined, null, "", "quarantined", "Available", 42, {}])(
    "unknown or malformed status %j is never public",
    (value) => {
      expect(isPublicAnimalStatus(value)).toBe(false);
    },
  );
});

describe("admin presentation helpers", () => {
  test("unknown values get a non-authoritative label", () => {
    expect(getAnimalStatusLabel("mystery")).toBe("Unknown");
    expect(getAnimalStatusLabel(undefined)).toBe("Unknown");
  });

  test("visibility hints distinguish public from non-public states", () => {
    expect(getAnimalStatusVisibilityHint("available")).toMatch(/public/i);
    expect(getAnimalStatusVisibilityHint("pending")).toMatch(/hidden/i);
    expect(getAnimalStatusVisibilityHint("adopted")).toMatch(/hidden/i);
    expect(getAnimalStatusVisibilityHint("bogus")).toMatch(/unrecognized/i);
  });
});

describe("transitions", () => {
  test("every supported status can transition to every other", () => {
    for (const from of ANIMAL_STATUSES) {
      for (const to of ANIMAL_STATUSES) {
        expect(canTransitionAnimalStatus(from, to)).toBe(true);
      }
    }
  });

  test("transitions involving unrecognized values are rejected", () => {
    expect(canTransitionAnimalStatus("bogus", "available")).toBe(false);
    expect(canTransitionAnimalStatus("available", "bogus")).toBe(false);
    expect(canTransitionAnimalStatus(undefined, "available")).toBe(false);
    expect(canTransitionAnimalStatus("available", "")).toBe(false);
  });
});
