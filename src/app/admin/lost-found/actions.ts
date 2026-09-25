"use server";

// Server actions for the lost/found workspace (#176). Every action
// self-authorizes via requireAdmin — case records carry private
// reporter/owner contact details and must never leak into public
// surfaces. This is the #176 queue, NOT #177's cross-domain exception
// dashboard — #177 should compose the same listOpenCases reads rather
// than this page's internals.

import { requireAdmin } from "@/lib/auth";
import {
  getOpenCaseCounts,
  listClosedCases,
  listOpenCases,
  openFoundCase,
  type LostFoundCaseRecord,
} from "@/lib/registry/lost-found";
import type { LostFoundOutcome } from "@/lib/lost-found";
import { logError } from "@/lib/logger";

export interface LostFoundWorkspace {
  missing: LostFoundCaseRecord[];
  foundUnmatched: LostFoundCaseRecord[];
  foundMatched: LostFoundCaseRecord[];
  recentlyClosed: LostFoundCaseRecord[];
}

export async function getLostFoundWorkspaceAction(): Promise<LostFoundWorkspace> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  const [open, closed] = await Promise.all([
    listOpenCases(),
    listClosedCases({ limit: 10 }),
  ]);
  return {
    missing: open.filter((c) => c.caseType === "missing"),
    foundUnmatched: open.filter(
      (c) => c.caseType === "found" && !c.animalId,
    ),
    foundMatched: open.filter((c) => c.caseType === "found" && !!c.animalId),
    recentlyClosed: closed,
  };
}

export async function getLostFoundCountsAction(): Promise<{
  missing: number;
  foundUnmatched: number;
  foundMatched: number;
}> {
  const { authorized } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  return getOpenCaseCounts();
}

export interface LostFoundActionResult {
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
}

// "Report a found animal" intake — the unmatched path: description and
// found details, optional scanned chip. Never fabricates an animal row.
export async function openFoundCaseAction(input: {
  chipNumber?: string | null;
  foundOn?: string | null;
  foundLocation?: string | null;
  description?: string | null;
  reporterName?: string | null;
  reporterContact?: string | null;
  notes?: string | null;
  outcome?: LostFoundOutcome | null;
}): Promise<LostFoundActionResult> {
  const { authorized, user } = await requireAdmin();
  if (!authorized) throw new Error("Unauthorized");
  try {
    const result = await openFoundCase(input, user?.email ?? "unknown");
    if (!result.ok) return { ok: false, reason: result.reason, field: result.field };
    return { ok: true, caseId: result.case.id };
  } catch (error) {
    logError("lost-found", "admin-save", error);
    return { ok: false };
  }
}
