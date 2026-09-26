"use server";

// Public "I think I saw this animal" submission (#176). Deliberately
// unauthenticated — anyone may report a sighting — but the server
// action writes ONLY a case-update row: reporter contact stays inside
// the staff case record and is never echoed back or exposed publicly.
// No owner details, no case data beyond an opaque ok/error result.

import { submitPublicSighting } from "@/lib/registry/lost-found";
import { logError } from "@/lib/logger";

export async function submitSightingAction(input: {
  caseId: string;
  location?: string | null;
  note?: string | null;
  reporterName?: string | null;
  reporterContact?: string | null;
}): Promise<{ ok: boolean }> {
  try {
    const result = await submitPublicSighting(input.caseId, {
      location: input.location,
      note: input.note,
      reporterName: input.reporterName,
      reporterContact: input.reporterContact,
    });
    return { ok: result.ok };
  } catch (error) {
    logError("lost-found", "public-sighting", error);
    return { ok: false };
  }
}
