// Unit tests for the canonical animal lifecycle module (#167). Two
// deliberately separate vocabularies are pinned down here:
//   - registry lifecycle (active/deceased/moved-off-saba/unknown) — the
//     animal's real state, never public;
//   - adoption listing state (not-listed/available/pending/adopted) —
//     the public catalog switch.
// Public visibility is security-sensitive: only adoption_status
// 'available' on a lifecycle 'active' animal is public, and
// unknown/malformed values are never treated as a supported state.
import { describe, expect, test } from "vitest";
import {
  ANIMAL_ADOPTION_LABELS,
  ANIMAL_ADOPTION_STATUSES,
  ANIMAL_LIFECYCLE_LABELS,
  ANIMAL_LIFECYCLE_STATUSES,
  ANIMAL_STERILIZATION_STATUSES,
  canTransitionAnimalLifecycle,
  formatAnimalAge,
  getAdoptionVisibilityHint,
  getAnimalAdoptionLabel,
  getAnimalLifecycleLabel,
  isAnimalAdoptionStatus,
  isAnimalLifecycleStatus,
  isPubliclyListed,
  OWNERSHIP_ENDING_STATUSES,
} from "../src/lib/animal-lifecycle";

describe("registry lifecycle vocabulary", () => {
  test("the lifecycle is exactly active/deceased/moved-off-saba/unknown", () => {
    expect([...ANIMAL_LIFECYCLE_STATUSES]).toEqual([
      "active",
      "deceased",
      "moved-off-saba",
      "unknown",
    ]);
  });

  test("every lifecycle status has a human-readable label", () => {
    for (const status of ANIMAL_LIFECYCLE_STATUSES) {
      expect(ANIMAL_LIFECYCLE_LABELS[status]).toBeTruthy();
      expect(getAnimalLifecycleLabel(status)).toBe(
        ANIMAL_LIFECYCLE_LABELS[status],
      );
    }
  });

  test.each(ANIMAL_LIFECYCLE_STATUSES)(
    "isAnimalLifecycleStatus accepts %s",
    (status) => {
      expect(isAnimalLifecycleStatus(status)).toBe(true);
    },
  );

  test.each([
    "available", // adoption-era value is NOT a lifecycle state
    "adopted",
    "pending",
    "Active",
    "",
    " unknown ",
    "lost",
  ])("isAnimalLifecycleStatus rejects %j", (status) => {
    expect(isAnimalLifecycleStatus(status)).toBe(false);
  });

  test.each([undefined, null, 0, true, {}, []])(
    "isAnimalLifecycleStatus rejects non-strings: %j",
    (value) => {
      expect(isAnimalLifecycleStatus(value)).toBe(false);
    },
  );

  test("ownership-ending states are exactly deceased + moved-off-saba", () => {
    expect([...OWNERSHIP_ENDING_STATUSES].sort()).toEqual([
      "deceased",
      "moved-off-saba",
    ]);
  });
});

describe("adoption listing vocabulary", () => {
  test("the listing states are not-listed/available/pending/adopted", () => {
    expect([...ANIMAL_ADOPTION_STATUSES]).toEqual([
      "not-listed",
      "available",
      "pending",
      "adopted",
    ]);
  });

  test("every listing state has a label", () => {
    for (const status of ANIMAL_ADOPTION_STATUSES) {
      expect(getAnimalAdoptionLabel(status)).toBe(
        ANIMAL_ADOPTION_LABELS[status],
      );
    }
    expect(getAnimalAdoptionLabel("mystery")).toBe("Unknown");
  });

  test.each(ANIMAL_ADOPTION_STATUSES)(
    "isAnimalAdoptionStatus accepts %s",
    (status) => {
      expect(isAnimalAdoptionStatus(status)).toBe(true);
    },
  );

  test.each(["active", "deceased", "Available", "", null, 42])(
    "isAnimalAdoptionStatus rejects %j",
    (value) => {
      expect(isAnimalAdoptionStatus(value)).toBe(false);
    },
  );
});

describe("public visibility", () => {
  test("only adoption 'available' on lifecycle 'active' is public", () => {
    expect(isPubliclyListed("active", "available")).toBe(true);
    for (const lifecycle of ANIMAL_LIFECYCLE_STATUSES) {
      for (const adoption of ANIMAL_ADOPTION_STATUSES) {
        const expected = lifecycle === "active" && adoption === "available";
        expect(isPubliclyListed(lifecycle, adoption)).toBe(expected);
      }
    }
  });

  test.each([undefined, null, "", "quarantined", 42, {}])(
    "malformed lifecycle %j is never public",
    (value) => {
      expect(isPubliclyListed(value, "available")).toBe(false);
    },
  );

  test.each([undefined, null, "", "available ", 42])(
    "malformed listing state %j is never public",
    (value) => {
      expect(isPubliclyListed("active", value)).toBe(false);
    },
  );
});

describe("lifecycle transitions", () => {
  test("every state can transition to every other state (corrections)", () => {
    for (const from of ANIMAL_LIFECYCLE_STATUSES) {
      for (const to of ANIMAL_LIFECYCLE_STATUSES) {
        expect(canTransitionAnimalLifecycle(from, to)).toBe(from !== to);
      }
    }
  });

  test("a same-state 'transition' is not a transition", () => {
    for (const s of ANIMAL_LIFECYCLE_STATUSES) {
      expect(canTransitionAnimalLifecycle(s, s)).toBe(false);
    }
  });

  test("transitions involving unrecognized values are rejected", () => {
    expect(canTransitionAnimalLifecycle("bogus", "active")).toBe(false);
    expect(canTransitionAnimalLifecycle("active", "bogus")).toBe(false);
    expect(canTransitionAnimalLifecycle(undefined, "active")).toBe(false);
    expect(canTransitionAnimalLifecycle("active", "")).toBe(false);
  });
});

describe("admin presentation helpers", () => {
  test("unknown lifecycle values get a non-authoritative label", () => {
    expect(getAnimalLifecycleLabel("mystery")).toBe("Unknown");
    expect(getAnimalLifecycleLabel(undefined)).toBe("Unknown");
  });

  test("visibility hints explain the two-state interaction", () => {
    expect(getAdoptionVisibilityHint("active", "available")).toMatch(
      /public adoptions page/i,
    );
    expect(getAdoptionVisibilityHint("active", "pending")).toMatch(/hidden/i);
    expect(getAdoptionVisibilityHint("deceased", "available")).toMatch(
      /not public/i,
    );
    expect(getAdoptionVisibilityHint("active", "bogus")).toMatch(
      /unrecognized/i,
    );
  });
});

describe("birth semantics", () => {
  test("sterilization vocabulary is unknown/sterilized/intact", () => {
    expect([...ANIMAL_STERILIZATION_STATUSES]).toEqual([
      "unknown",
      "sterilized",
      "intact",
    ]);
  });

  test("formatAnimalAge derives display age from a birth date", () => {
    const today = "2026-06-15";
    expect(formatAnimalAge("2024-06-15", false, today)).toBe("2 years");
    expect(formatAnimalAge("2024-06-16", false, today)).toBe("1 year");
    expect(formatAnimalAge("2026-01-01", false, today)).toBe("5 months");
    expect(formatAnimalAge("2026-06-15", false, today)).toBe("0 months");
  });

  test("estimated dates render with the ~ prefix", () => {
    expect(formatAnimalAge("2024-06-15", true, "2026-06-15")).toBe("~2 years");
  });

  test("unknown or impossible birth data renders nothing", () => {
    expect(formatAnimalAge(null, false, "2026-06-15")).toBeNull();
    expect(formatAnimalAge("not-a-date", false, "2026-06-15")).toBeNull();
    // A future birth date is bad data — show nothing rather than a
    // negative age.
    expect(formatAnimalAge("2027-01-01", false, "2026-06-15")).toBeNull();
  });
});
