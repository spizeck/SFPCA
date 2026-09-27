// Reporting vocabulary tests (#179) — the small-cell privacy policy,
// age-band assignment, and CSV encoding are pure functions, so every
// disclosure-control property is proven here without a database:
//   - non-zero cells below the threshold are suppressed, zeros are not;
//   - exactly-one-suppressed triggers complementary suppression so a
//     published total can't isolate the hidden cell by subtraction;
//   - public rates require a publishable-sized denominator;
//   - age bands agree with the canonical month math and keep unknown
//     data honest;
//   - CSV cells can never evaluate as spreadsheet formulas.

import { describe, test, expect } from "vitest";
import {
  ageBandFor,
  ageBandForMonths,
  ageInMonths,
  csvCell,
  PUBLIC_SMALL_CELL_MIN,
  publicPercent,
  suppressSmallCells,
  toCsv,
} from "@/lib/reports";

describe("suppressSmallCells — the public small-cell policy", () => {
  const cells = (counts: Record<string, number>) =>
    Object.entries(counts).map(([key, count]) => ({
      key,
      label: key,
      count,
    }));

  test("cells at/above the threshold publish exactly", () => {
    const out = suppressSmallCells(cells({ dogs: 40, cats: 5 }));
    expect(out).toEqual([
      { key: "dogs", label: "dogs", count: 40, suppressed: false },
      { key: "cats", label: "cats", count: 5, suppressed: false },
    ]);
  });

  test("a non-zero cell below the threshold is suppressed", () => {
    const out = suppressSmallCells(
      cells({ dogs: 40, cats: 12, other: 3, extra: 8 }),
    );
    const other = out.find((c) => c.key === "other")!;
    // Exactly one small cell → complementary suppression kicks in, so
    // the smallest visible cell (extra=8) is hidden too.
    expect(other).toMatchObject({ count: null, suppressed: true });
    const suppressed = out.filter((c) => c.suppressed);
    expect(suppressed.map((c) => c.key).sort()).toEqual(["extra", "other"]);
    // The published cells never carry the hidden value.
    expect(JSON.stringify(out)).not.toContain('"count":3');
  });

  test("complementary suppression: a single hidden cell is never isolable", () => {
    // {10, 2}: hiding only the 2 would let total-10 expose it.
    const out = suppressSmallCells(cells({ dogs: 10, other: 2 }));
    expect(out.every((c) => c.suppressed)).toBe(true);
  });

  test("two small cells both suppress without complementing", () => {
    const out = suppressSmallCells(cells({ dogs: 40, cats: 3, other: 2 }));
    expect(out.filter((c) => c.suppressed).map((c) => c.key).sort()).toEqual([
      "cats",
      "other",
    ]);
    expect(out.find((c) => c.key === "dogs")).toMatchObject({
      count: 40,
      suppressed: false,
    });
  });

  test("zero counts publish — an empty category protects no one", () => {
    const out = suppressSmallCells(cells({ dogs: 40, cats: 0 }));
    expect(out.find((c) => c.key === "cats")).toMatchObject({
      count: 0,
      suppressed: false,
    });
  });

  test("a lone small cell with no complement suppresses itself only", () => {
    const out = suppressSmallCells(cells({ other: 2 }));
    expect(out[0]).toMatchObject({ count: null, suppressed: true });
  });

  test("custom thresholds apply the same rules", () => {
    const out = suppressSmallCells(cells({ a: 9, b: 20, c: 30 }), 10);
    expect(out.find((c) => c.key === "a")!.suppressed).toBe(true);
    // Complementary hides the smallest survivor (b=20).
    expect(out.find((c) => c.key === "b")!.suppressed).toBe(true);
    expect(out.find((c) => c.key === "c")!.count).toBe(30);
  });

  test("the canonical threshold is exported once and positive", () => {
    expect(PUBLIC_SMALL_CELL_MIN).toBe(5);
  });
});

describe("publicPercent — rates with a denominator floor", () => {
  test("rounds to whole percent over a publishable denominator", () => {
    expect(publicPercent(33, 40)).toBe(83); // 82.5 → 83
    expect(publicPercent(0, 40)).toBe(0);
    expect(publicPercent(40, 40)).toBe(100);
  });

  test("refuses a rate when the denominator is a small cell", () => {
    expect(publicPercent(4, 4)).toBeNull();
    expect(publicPercent(1, 4)).toBeNull();
    expect(publicPercent(0, 0)).toBeNull();
    expect(publicPercent(5, 0)).toBeNull();
  });
});

describe("age bands", () => {
  const asOf = "2026-03-15";

  test("month boundaries match the display math", () => {
    expect(ageBandFor("2025-04-01", asOf)).toBe("under-1"); // 11 months
    expect(ageBandFor("2025-03-15", asOf)).toBe("1-3"); // exactly 1 year
    expect(ageBandFor("2023-06-01", asOf)).toBe("1-3");
    expect(ageBandFor("2022-03-15", asOf)).toBe("4-7"); // exactly 4 years
    expect(ageBandFor("2017-01-01", asOf)).toBe("8-11"); // ~9.2 years
    expect(ageBandFor("2010-01-01", asOf)).toBe("12-plus");
  });

  test("day-of-month rollover is handled", () => {
    // Birthday later this month → the month isn't complete yet.
    expect(ageInMonths("2025-03-20", asOf)).toBe(11);
    expect(ageBandFor("2025-03-20", asOf)).toBe("under-1");
  });

  test("missing, malformed, and future birth dates are unknown", () => {
    expect(ageBandFor(null, asOf)).toBe("unknown");
    expect(ageBandFor("not-a-date", asOf)).toBe("unknown");
    expect(ageBandFor("2030-01-01", asOf)).toBe("unknown");
  });

  test("ageBandForMonths boundary table", () => {
    expect(ageBandForMonths(null)).toBe("unknown");
    expect(ageBandForMonths(0)).toBe("under-1");
    expect(ageBandForMonths(11)).toBe("under-1");
    expect(ageBandForMonths(12)).toBe("1-3");
    expect(ageBandForMonths(47)).toBe("1-3");
    expect(ageBandForMonths(48)).toBe("4-7");
    expect(ageBandForMonths(95)).toBe("4-7");
    expect(ageBandForMonths(96)).toBe("8-11");
    expect(ageBandForMonths(143)).toBe("8-11");
    expect(ageBandForMonths(144)).toBe("12-plus");
  });
});

describe("csvCell — spreadsheet-safety encoding", () => {
  test("plain values pass through", () => {
    expect(csvCell("dogs")).toBe("dogs");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  test("formula-leading characters are prefixed with an apostrophe", () => {
    for (const bad of ["=SUM(A1)", "+123", "-99", "@cmd", "\tevil"]) {
      expect(csvCell(bad).startsWith("'")).toBe(true);
    }
    // A leading CR also forces RFC quoting — the apostrophe then sits
    // inside the quotes, which is equally formula-safe.
    expect(csvCell("\revil")).toBe("\"'\revil\"");
    // Mid-string operators are harmless — no prefix added.
    expect(csvCell("a-b")).toBe("a-b");
  });

  test("commas, quotes, and newlines are RFC-4180 escaped", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  test("injection and quoting compose correctly", () => {
    // Needs both guards: apostrophe prefix AND quoting for the
    // comma/quote content.
    expect(csvCell('=cmd,"x"')).toBe('"\'=cmd,""x"""');
  });
});

describe("toCsv — stable wire format", () => {
  test("headers first, CRLF rows, trailing newline", () => {
    const csv = toCsv(
      ["metric", "value"],
      [
        ["dogs", 3],
        ["cats", null],
      ],
    );
    expect(csv).toBe("metric,value\r\ndogs,3\r\ncats,\r\n");
  });
});
