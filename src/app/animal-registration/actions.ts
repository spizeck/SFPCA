"use server";

// Public registration intake (#183). The browser never reaches Postgres:
// the form uploads its receipt to Storage, then calls this action, which
// re-validates everything server-side and inserts the submission row.
// There is deliberately no authentication — this is the public form —
// so validation lives entirely in the domain service.

import { createRegistrationSubmission } from "@/lib/registry/registrations";
import type { SubmissionInput } from "@/lib/registry/registrations";
import { logError } from "@/lib/logger";

export type SubmitRegistrationResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: "invalid" | "error" };

export async function submitRegistrationAction(
  input: SubmissionInput,
): Promise<SubmitRegistrationResult> {
  try {
    return await createRegistrationSubmission(input);
  } catch (error) {
    // Failure contract: a clear retryable error, never a fake success.
    logError("registration", "submit", error);
    return { ok: false, reason: "error" };
  }
}
