// Canonical microchip-number normalization and validation (#168).
//
// THE one normalization definition for the whole registry: chip lookup,
// record creation/correction, registry search, imports, scanner input,
// and duplicate detection all call normalizeChipNumber so two
// representations of the same chip can never diverge into different
// stored values.
//
// Semantics — uppercase, then strip everything that is not A–Z or 0–9:
//   - leading/trailing whitespace            → removed (harmless entry)
//   - embedded spaces                        → removed ("985 112 345 678")
//   - hyphens, dots, asterisks, slashes      → removed (common scanner
//     and paperwork formatting, e.g. "AVID*123*456*789")
//   - letters                                → preserved, uppercased —
//     they are meaningful (manufacturer prefixes like AVID), never
//     transliterated or transliterated-away beyond case folding
//
// Anything outside A–Z0–9 after case folding is treated as formatting.
// Real chip identifiers (ISO 11784/11785 15-digit FDX-B, AVID, Trovan,
// Datamars) are alphanumeric only, so no meaningful character is ever
// dropped. The transformation is total and deterministic — the same
// input always produces the same output — and is deliberately kept
// free of any database/server dependency so client components can
// normalize identically to the server.
//
// The AS-ENTERED representation is preserved separately on the record
// (microchip_records.chip_display) whenever it carries formatting the
// normalized form cannot reproduce.

export const CHIP_NUMBER_MIN_LENGTH = 4;
export const CHIP_NUMBER_MAX_LENGTH = 32;

export function normalizeChipNumber(input: string | null | undefined): string {
  return (input ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

// A normalized chip number is plausible registry data only inside the
// length bound — the floor matches the minimum a partial search/entry
// can meaningfully identify, the ceiling rejects pasted garbage without
// touching any real chip format (longest common formats are ~16 chars).
export type ChipNumberProblem = "empty" | "too-short" | "too-long";

export function chipNumberProblem(
  normalized: string,
): ChipNumberProblem | null {
  if (normalized.length === 0) return "empty";
  if (normalized.length < CHIP_NUMBER_MIN_LENGTH) return "too-short";
  if (normalized.length > CHIP_NUMBER_MAX_LENGTH) return "too-long";
  return null;
}

export function isValidChipNumber(normalized: string): boolean {
  return chipNumberProblem(normalized) === null;
}

// The display form kept on the record: what was actually typed/scanned,
// trimmed of surrounding whitespace only — interior formatting is the
// point of preserving it. Falls back to the normalized form when the
// raw input is empty or identical after normalization (no information
// would be lost by storing it, but the column stays honest: "what was
// entered").
export function chipDisplayValue(
  rawInput: string | null | undefined,
  normalized: string,
): string {
  const trimmed = (rawInput ?? "").trim();
  return trimmed || normalized;
}
