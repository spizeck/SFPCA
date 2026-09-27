// Canonical reporting vocabulary (#179) — the ONE place that defines
// what the registry's population terms mean, the small-cell privacy
// policy for anonymous/public statistics, broad age bands, and the CSV
// encoding every export shares. Client-safe (no server-only, no DB):
// the reporting service, the staff page, the public statistics page,
// and tests all read the same definitions.
//
// THE governing distinction — three different populations:
//
//   known animal          — a durable `animals` row that is not a
//                           retired merge duplicate. "Animals known to
//                           SFPCA" — the whole registry.
//   active known animal   — a known animal whose lifecycle_status is
//                           'active' (living on Saba / in registry care
//                           per the current registry state).
//   registered for year Y — an animal with an authoritative
//                           registrations row (status='active') for the
//                           calendar-year period Y (#169 semantics).
//
// The TOTAL ANIMAL POPULATION OF SABA is none of these and is never
// reported: the registry only describes animals SFPCA knows about.
// Public copy must say "known to SFPCA" or "registered with SFPCA",
// never "animals on Saba".

import { isIsoDateString } from "./vaccinations";

// --- Small-cell privacy policy ------------------------------------------------
//
// Saba is small enough that a fine-grained combination can identify a
// household even with no names attached. The policy, in one place:
//
//   - PUBLIC breakdowns suppress every non-zero cell below
//     PUBLIC_SMALL_CELL_MIN (a suppressed cell renders as "Fewer than
//     N", never the true number, and the true number never leaves the
//     server in a public DTO).
//   - Exactly-zero cells are published: an empty category contains no
//     one to protect, and hiding it would make honest totals look
//     padded.
//   - COMPLEMENTARY suppression: if exactly one cell is suppressed, the
//     smallest surviving cell is suppressed too — otherwise a published
//     total plus the visible cells would isolate the suppressed value
//     by subtraction.
//   - PUBLIC percentages/rates are published only when their
//     denominator is at least the threshold, rounded to whole percent;
//     the numerator is never published separately.
//   - Staff reports are exempt from suppression (authorized users need
//     accurate numbers) but staff surfaces still carry no owner PII.
//
// The threshold lives here and ONLY here — no magic numbers in pages.

export const PUBLIC_SMALL_CELL_MIN = 5;

export interface PublicBreakdownCell {
  key: string;
  label: string;
  // null when suppressed — the true value must never reach the client.
  count: number | null;
  suppressed: boolean;
}

export interface BreakdownInput {
  key: string;
  label: string;
  count: number;
}

// Apply the policy to a labelled breakdown. Input order is preserved.
export function suppressSmallCells(
  cells: readonly BreakdownInput[],
  threshold: number = PUBLIC_SMALL_CELL_MIN,
): PublicBreakdownCell[] {
  const suppressed = new Set<string>();
  for (const c of cells) {
    if (c.count > 0 && c.count < threshold) suppressed.add(c.key);
  }
  // Complementary suppression: exactly one hidden cell is isolable when
  // the group total is known — hide the smallest visible cell too.
  if (suppressed.size === 1) {
    const visible = cells.filter((c) => !suppressed.has(c.key));
    if (visible.length > 0) {
      const smallest = visible.reduce((a, b) => (b.count < a.count ? b : a));
      suppressed.add(smallest.key);
    }
  }
  return cells.map((c) => ({
    key: c.key,
    label: c.label,
    count: suppressed.has(c.key) ? null : c.count,
    suppressed: suppressed.has(c.key),
  }));
}

// A public rate: whole percent, only when the denominator itself is a
// publishable-sized group. Returns null when the group is too small to
// describe safely — the UI renders "not published" text.
export function publicPercent(
  part: number,
  whole: number,
  threshold: number = PUBLIC_SMALL_CELL_MIN,
): number | null {
  if (whole < threshold || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

// --- Age bands -----------------------------------------------------------------
// Broad operational bands — never exact ages or dates, so public
// aggregates can't carry false precision (or identifying detail) about
// an animal's birth date. Months math mirrors formatAnimalAge in
// src/lib/animal-lifecycle.ts exactly so a report band always agrees
// with the age the profile displays.

export const AGE_BAND_KEYS = [
  "under-1",
  "1-3",
  "4-7",
  "8-11",
  "12-plus",
  "unknown",
] as const;
export type AgeBandKey = (typeof AGE_BAND_KEYS)[number];

export const AGE_BAND_LABELS: Record<AgeBandKey, string> = {
  "under-1": "Under 1 year",
  "1-3": "1–3 years",
  "4-7": "4–7 years",
  "8-11": "8–11 years",
  "12-plus": "12+ years",
  unknown: "Unknown",
};

// Completed months between birth_date and asOf (YYYY-MM-DD), or null
// when the date is missing, malformed, or in the future (bad data is
// "unknown", not a misleading age).
export function ageInMonths(
  birthDate: string | null,
  asOf: string,
): number | null {
  if (!birthDate || !isIsoDateString(birthDate) || !isIsoDateString(asOf)) {
    return null;
  }
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = asOf.split("-").map(Number);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  return months < 0 ? null : months;
}

export function ageBandForMonths(months: number | null): AgeBandKey {
  if (months === null) return "unknown";
  if (months < 12) return "under-1";
  if (months < 48) return "1-3";
  if (months < 96) return "4-7";
  if (months < 144) return "8-11";
  return "12-plus";
}

export function ageBandFor(
  birthDate: string | null,
  asOf: string,
): AgeBandKey {
  return ageBandForMonths(ageInMonths(birthDate, asOf));
}

// --- CSV encoding ---------------------------------------------------------------
// Shared by every staff export. RFC-4180 quoting plus a formula-
// injection guard: any text cell starting with =, +, -, @, tab, or CR is
// prefixed with an apostrophe so a spreadsheet can never evaluate a
// report value as a formula. Numbers pass through bare.

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

// Stable machine-readable output: one header row, then one line per
// record. Trailing CRLF per RFC 4180 so naive parsers don't drop the
// last row.
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((r) => r.map(csvCell).join(",")),
  ];
  return lines.join("\r\n") + "\r\n";
}
