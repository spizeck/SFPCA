"use server";

// Public "I think I saw this animal" submission (#176, abuse controls
// #219). Deliberately unauthenticated — anyone may report a sighting —
// but the server action writes ONLY a case-update row: reporter contact
// stays inside the staff case record and is never echoed back or exposed
// publicly. No owner details, no case data beyond an opaque result.
//
// Abuse posture mirrors the registration intake: a honeypot field that
// returns a generic success when triggered (nothing written, no signal
// for a bot to probe), then a fixed-window Postgres rate limit keyed by
// a salted client-IP digest.

import { headers } from "next/headers";
import { submitPublicSighting } from "@/lib/registry/lost-found";
import { checkRateLimit, warnThrottled } from "@/lib/rate-limit";
import { clientIpFromHeaders, subjectForIp } from "@/lib/request-identity";
import { logError, logWarn } from "@/lib/logger";

export interface SubmitSightingInput {
  caseId: string;
  location?: string | null;
  note?: string | null;
  reporterName?: string | null;
  reporterContact?: string | null;
  // Honeypot — must arrive empty.
  website?: string;
}

export interface SubmitSightingResult {
  ok: boolean;
  reason?: "invalid" | "error" | "throttled";
}

export async function submitSightingAction(
  input: SubmitSightingInput,
): Promise<SubmitSightingResult> {
  if (typeof input.website === "string" && input.website.trim() !== "") {
    logWarn("lost-found", "honeypot", "Public intake honeypot triggered");
    return { ok: true };
  }

  const gate = await checkRateLimit(
    "sighting.submit",
    subjectForIp(clientIpFromHeaders(await headers())),
  );
  if (!gate.allowed) {
    warnThrottled("lost-found", "sighting.submit", gate);
    return { ok: false, reason: "throttled" };
  }

  try {
    const result = await submitPublicSighting(input.caseId, {
      location: input.location,
      note: input.note,
      reporterName: input.reporterName,
      reporterContact: input.reporterContact,
    });
    return { ok: result.ok, ...(result.ok ? {} : { reason: "invalid" as const }) };
  } catch (error) {
    logError("lost-found", "public-sighting", error);
    return { ok: false, reason: "error" };
  }
}
