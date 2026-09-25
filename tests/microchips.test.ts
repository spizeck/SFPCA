// Canonical microchip normalization tests (#168). The normalization
// function is THE single definition used by lookup, creation,
// correction, search, imports, and duplicate detection — its behavior
// is a registry contract, so every documented edge is pinned here.

import { describe, expect, test } from "vitest";
import {
  chipDisplayValue,
  chipNumberProblem,
  CHIP_NUMBER_MAX_LENGTH,
  CHIP_NUMBER_MIN_LENGTH,
  isValidChipNumber,
  normalizeChipNumber,
} from "@/lib/microchips";

describe("normalizeChipNumber", () => {
  test("trims leading/trailing whitespace", () => {
    expect(normalizeChipNumber("  985112345678901  ")).toBe("985112345678901");
    expect(normalizeChipNumber("\t985112345678901\n")).toBe("985112345678901");
  });

  test("removes embedded spaces and common separators", () => {
    // Scanner and paperwork formatting the issue calls out.
    expect(normalizeChipNumber("985 112 345 678 901")).toBe(
      "985112345678901",
    );
    expect(normalizeChipNumber("985-113-001-234-567")).toBe(
      "985113001234567",
    );
    expect(normalizeChipNumber("985.113.001.234.567")).toBe(
      "985113001234567",
    );
    expect(normalizeChipNumber("AVID*123*456*789")).toBe("AVID123456789");
    expect(normalizeChipNumber("985/113/001")).toBe("985113001");
    expect(normalizeChipNumber("985_113_001")).toBe("985113001");
  });

  test("uppercases letters — they are meaningful, not stripped", () => {
    expect(normalizeChipNumber("avid123456789")).toBe("AVID123456789");
    expect(normalizeChipNumber("tr-9910abc")).toBe("TR9910ABC");
  });

  test("is deterministic and idempotent", () => {
    const raw = "  985-113-001-234-567 ";
    const once = normalizeChipNumber(raw);
    expect(normalizeChipNumber(once)).toBe(once);
    expect(normalizeChipNumber(raw)).toBe(normalizeChipNumber(raw));
  });

  test("handles null/undefined/empty input", () => {
    expect(normalizeChipNumber(null)).toBe("");
    expect(normalizeChipNumber(undefined)).toBe("");
    expect(normalizeChipNumber("")).toBe("");
    expect(normalizeChipNumber("   - .  ")).toBe("");
  });

  test("strips every non-alphanumeric formatting character", () => {
    // Real chip formats (ISO 11784/11785, AVID, Trovan, Datamars) are
    // alphanumeric only — nothing meaningful is ever dropped.
    expect(normalizeChipNumber("(985) [113] {001}")).toBe("985113001");
    expect(normalizeChipNumber("985'113'001")).toBe("985113001");
  });

  test("two representations of the same chip normalize identically", () => {
    const variants = [
      "985112345678901",
      "985 112 345 678 901",
      "985-112-345-678-901",
      " 985112345678901 ",
      "985.112.345.678.901",
    ];
    const normalized = new Set(variants.map(normalizeChipNumber));
    expect(normalized.size).toBe(1);
  });
});

describe("isValidChipNumber / chipNumberProblem", () => {
  test("accepts plausible chip numbers", () => {
    expect(isValidChipNumber("985112345678901")).toBe(true); // ISO 15-digit
    expect(isValidChipNumber("AVID123456789")).toBe(true);
    expect(isValidChipNumber("A".repeat(CHIP_NUMBER_MIN_LENGTH))).toBe(true);
    expect(isValidChipNumber("9".repeat(CHIP_NUMBER_MAX_LENGTH))).toBe(true);
  });

  test("rejects empty, too short, and too long input", () => {
    expect(chipNumberProblem("")).toBe("empty");
    expect(chipNumberProblem("AB")).toBe("too-short");
    expect(chipNumberProblem("9".repeat(CHIP_NUMBER_MAX_LENGTH + 1))).toBe(
      "too-long",
    );
    expect(isValidChipNumber("")).toBe(false);
    expect(isValidChipNumber("12")).toBe(false);
  });
});

describe("chipDisplayValue", () => {
  test("keeps the as-entered formatting for display", () => {
    expect(chipDisplayValue("AVID*123*456*789", "AVID123456789")).toBe(
      "AVID*123*456*789",
    );
    expect(chipDisplayValue("985 112 345 678 901", "985112345678901")).toBe(
      "985 112 345 678 901",
    );
  });

  test("trims surrounding whitespace but not interior", () => {
    expect(chipDisplayValue("  985-113-001  ", "985113001")).toBe(
      "985-113-001",
    );
  });

  test("falls back to the normalized form when nothing was entered", () => {
    expect(chipDisplayValue("   ", "985113001")).toBe("985113001");
    expect(chipDisplayValue(null, "985113001")).toBe("985113001");
    expect(chipDisplayValue(undefined, "985113001")).toBe("985113001");
  });
});
