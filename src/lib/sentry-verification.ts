// Controlled Sentry verification (Issue #140). The marker makes test
// events unmistakably identifiable in Sentry — an operator verifying
// release/environment/symbolication searches for it, and alert rules
// can exclude it if desired. Synthetic only: the message contains no
// real data, and every event still passes the privacy boundary in
// src/lib/sentry.ts like any other error.
export const SENTRY_VERIFICATION_MARKER = "SENTRY_VERIFICATION_EVENT";

export function sentryVerificationError(
  surface: "browser" | "server",
): Error {
  return new Error(
    `${SENTRY_VERIFICATION_MARKER}:${surface} — controlled synthetic test, safe to ignore`,
  );
}
