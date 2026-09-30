"use server";

// Public registration intake (#183, abuse controls #219). The browser
// never reaches Postgres: this action re-validates everything
// server-side and inserts the submission row. There is deliberately no
// authentication — this is the public form — so validation lives
// entirely in the domain service.
//
// Abuse posture (defense in depth):
// - Honeypot: a hidden `website` field that no human or assistive
//   technology fills. A hit returns a fake success shape — nothing is
//   written, and the response is indistinguishable from a real success
//   so the field cannot be probed as a bot oracle.
// - Rate limit: a fixed-window Postgres counter keyed by a salted hash
//   of the trusted client IP (src/lib/request-identity.ts documents the
//   trust boundary). Over-limit attempts get an honest, retryable
//   "throttled" result — the client shows a calm message and preserves
//   the form.
// - Receipt upload: no direct unauthenticated Storage writes. After the
//   row lands, the browser POSTs the file to
//   /api/receipts/[submissionId] — a bounded route that rate-limits,
//   claims the row's receipt slot atomically, validates type/size from
//   the bytes themselves, and writes create-only through the Admin SDK.
//   storage.rules denies every client write.

import { headers } from "next/headers";
import {
  createRegistrationSubmission,
  type SubmissionInput,
} from "@/lib/registry/registrations";
import { checkRateLimit, warnThrottled } from "@/lib/rate-limit";
import { clientIpFromHeaders, subjectForIp } from "@/lib/request-identity";
import { logError, logWarn } from "@/lib/logger";

export interface SubmitRegistrationInput extends Omit<SubmissionInput, "receiptRequested"> {
  // Honeypot — must arrive empty. Any content marks automated tooling.
  website?: string;
  // Declares intent to attach a receipt; persisted on the row so the
  // upload route can refuse submissions that never asked for one.
  wantsReceipt?: boolean;
}

export type SubmitRegistrationResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: "invalid" | "error" | "throttled" };

async function intakeSubject(): Promise<string> {
  return subjectForIp(clientIpFromHeaders(await headers()));
}

export async function submitRegistrationAction(
  input: SubmitRegistrationInput,
): Promise<SubmitRegistrationResult> {
  // Honeypot first — no limiter hit, no write, generic success shape.
  if (typeof input.website === "string" && input.website.trim() !== "") {
    logWarn(
      "registration",
      "honeypot",
      "Public intake honeypot triggered",
    );
    return {
      ok: true,
      submissionId: input.submissionId ?? "",
    };
  }

  const gate = await checkRateLimit(
    "registration.submit",
    await intakeSubject(),
  );
  if (!gate.allowed) {
    warnThrottled("registration", "registration.submit", gate);
    return { ok: false, reason: "throttled" };
  }

  const { website: _hp, wantsReceipt, ...submission } = input;
  try {
    const result = await createRegistrationSubmission({
      ...submission,
      receiptRequested: wantsReceipt === true,
    });
    if (!result.ok) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, submissionId: result.submissionId };
  } catch (error) {
    // Failure contract: a clear retryable error, never a fake success.
    logError("registration", "submit", error);
    return { ok: false, reason: "error" };
  }
}
