"use server";

// Server actions for the staff chip lookup / found-animal tool (#168).
// Every action self-authorizes via requireAdmin — owner contact
// information is staff data and these are the only paths that expose
// it; nothing here is reachable from a public surface.

import { requireAdmin } from "@/lib/auth";
import {
  lookupChip,
  recordFoundReport,
  resolveFoundReport,
  type ChipLookupResult,
} from "@/lib/registry/microchips";
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

export interface FoundReportActionResult {
  ok: boolean;
  reason?: "invalid" | "not-found" | "conflict";
  field?: string;
}

// Log a found report from the scan result — open follow-up item when
// no outcome is given, or an immediately-resolved record when one is
// ("scanned, phoned owner, dog went home").
export async function recordFoundReportAction(input: {
  animalId?: string | null;
  microchipRecordId?: string | null;
  chipNumber: string;
  notes?: string | null;
  outcome?: string | null;
}): Promise<FoundReportActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await recordFoundReport(input, user?.email ?? "unknown");
    return result.ok
      ? { ok: true }
      : { ok: false, reason: result.reason, field: result.field };
  } catch (error) {
    logError("microchips", "found-report-save", error);
    return { ok: false };
  }
}

// Close an open found report with an outcome.
export async function resolveFoundReportAction(
  reportId: string,
  outcome: string,
  notes?: string | null,
): Promise<FoundReportActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await resolveFoundReport(
      reportId,
      { outcome, notes },
      user?.email ?? "unknown",
    );
    return result.ok
      ? { ok: true }
      : { ok: false, reason: result.reason, field: result.field };
  } catch (error) {
    logError("microchips", "found-report-resolve", error);
    return { ok: false };
  }
}
