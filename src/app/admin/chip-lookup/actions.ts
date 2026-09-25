"use server";

// Server actions for the staff chip lookup / found-animal tool (#168,
// scan events now live in #176's lost/found cases). Every action
// self-authorizes via requireAdmin — owner contact information is
// staff data and these are the only paths that expose it; nothing here
// is reachable from a public surface.

import { requireAdmin } from "@/lib/auth";
import {
  lookupChip,
  type ChipLookupResult,
} from "@/lib/registry/microchips";
import { openFoundCase, resolveCase } from "@/lib/registry/lost-found";
import type { LostFoundOutcome } from "@/lib/lost-found";
import { logError } from "@/lib/logger";

// The scanner workflow's read path: raw input straight from the field —
// normalization happens inside the canonical service, never here.
// Staff-authorized only; the result carries owner contact data.
export async function lookupChipAction(
  rawInput: string,
): Promise<ChipLookupResult> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    return await lookupChip(rawInput);
  } catch (error) {
    logError("microchips", "chip-lookup", error);
    return { status: "error" };
  }
}

export interface FoundScanActionResult {
  ok: boolean;
  reason?:
    | "invalid"
    | "not-found"
    | "conflict"
    | "not-open"
    | "not-unmatched"
    | "has-open-case";
  field?: string;
  caseId?: string;
  // True when the scan folded into an already-open case — the UI reports
  // "added to the existing case", not "created".
  existing?: boolean;
  // True when the animal had an open MISSING case — the scan landed on
  // that case (the missing animal was found), not a new found case.
  matchedMissing?: boolean;
}

// Record a found-animal scan from the lookup result. Deterministic
// routing inside the service: an open missing case on the animal gets
// the scan as evidence, an open found/unmatched case gets a rescan
// note, otherwise a new found case opens — or resolves immediately when
// an outcome is supplied ("scanned, phoned owner, dog went home").
export async function recordFoundScanAction(input: {
  animalId?: string | null;
  microchipRecordId?: string | null;
  chipNumber: string;
  notes?: string | null;
  outcome?: string | null;
}): Promise<FoundScanActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await openFoundCase(
      {
        animalId: input.animalId ?? null,
        microchipRecordId: input.microchipRecordId ?? null,
        chipNumber: input.chipNumber,
        notes: input.notes ?? null,
        outcome: input.outcome ?? null,
      },
      user?.email ?? "unknown",
    );
    if (!result.ok) {
      return { ok: false, reason: result.reason, field: result.field };
    }
    return {
      ok: true,
      caseId: result.case.id,
      existing: result.existing,
      matchedMissing: result.matchedMissing,
    };
  } catch (error) {
    logError("microchips", "found-scan-save", error);
    return { ok: false };
  }
}

// Close an open case surfaced by the lookup (the missing case the scan
// attached to, or an open found case) with an outcome.
export async function resolveOpenCaseAction(
  caseId: string,
  outcome: LostFoundOutcome,
  notes?: string | null,
): Promise<FoundScanActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await resolveCase(
      caseId,
      { outcome, resolutionNote: notes },
      user?.email ?? "unknown",
    );
    return result.ok
      ? { ok: true, caseId: result.case.id }
      : { ok: false, reason: result.reason, field: result.field };
  } catch (error) {
    logError("microchips", "case-resolve", error);
    return { ok: false };
  }
}
