// Minimal structured logging convention for application-controlled
// operational events. Server-side calls are captured by Vercel runtime
// logs; client-side calls stay in the visitor's browser console. Both
// emit one JSON object per event so fields are queryable rather than
// buried in free text.
//
// Severity contract (#218):
// - logError = a genuinely UNEXPECTED failure the code caught and
//   handled. In addition to the console entry it is reported to Sentry
//   through the normally-initialized SDK (no-op when the SDK is not
//   initialized — local dev, CI, and E2E never initialize it, #235).
// - logWarn/logInfo = expected outcomes (auth denials, validation
//   rejections, not-found, user cancellation, known business rules)
//   and routine operational notes — console only, never Sentry.
// - Uncaught errors need no logging call: Next/Sentry instrumentation
//   (`onRequestError`, the shared ErrorFallback capture) reports them.
//   Prefer returning a safe result over catching-then-rethrowing —
//   a rethrown error is captured a second time by the framework.
//
// Hard rule: never pass request bodies, Firestore documents, form
// payloads, receipt paths, tokens, cookies, headers, or env values to
// these functions. Errors are normalized to name/code/message — the
// raw Error object is only echoed in development for stack traces.
// Sentry context follows the same rule; every event additionally
// passes the privacy boundary in src/lib/sentry.ts before leaving
// the process.

import * as Sentry from "@sentry/nextjs";

export type LogSubsystem =
  | "auth"
  | "session"
  | "registration"
  | "receipt"
  | "rate-limit"
  | "admin"
  | "animals"
  | "vaccinations"
  | "medical"
  | "microchips"
  | "communications"
  | "lost-found"
  | "dashboard"
  | "reports"
  | "content"
  | "portal"
  | "owners"
  | "sentry"
  | "ui";

export interface SafeError {
  name: string;
  code?: string;
  message?: string;
}

const MAX_ERROR_MESSAGE = 200;

// Firebase SDK errors carry a short stable code ("permission-denied",
// "storage/unauthorized", "auth/id-token-expired", gRPC status codes)
// that is the most useful diagnostic field. The message is included
// but hard-truncated; the stack and any attached request/response
// objects are deliberately dropped.
export function normalizeError(error: unknown): SafeError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name || "Error",
      ...(typeof code === "string" ? { code } : {}),
      ...(error.message
        ? { message: error.message.slice(0, MAX_ERROR_MESSAGE) }
        : {}),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: error.slice(0, MAX_ERROR_MESSAGE) };
  }
  return { name: "Error", message: "Non-error thrown" };
}

type SafeContext = Record<string, string | number | boolean | undefined>;

export interface LogErrorOptions {
  // Set false only when the call site reports the same error to Sentry
  // itself — the shared ErrorFallback's digest-tagged capture is the
  // one such site. Everything else keeps the default so caught
  // operational failures stay observable.
  sentry?: boolean;
}

// The single caught-error → Sentry path (#218). Two deliberate skips:
//
// - `options.sentry === false`: the call site captured the error
//   itself; forwarding would double-report.
// - `error.digest` set: a server error Next.js serialized for the
//   client carries a digest and a generic message. The real exception
//   was already captured server-side (onRequestError or the action's
//   own logError) — forwarding the placeholder would add a second,
//   information-free event.
//
// When the SDK was never initialized (local dev, CI, E2E — #235 keeps
// sending off and skips Sentry.init entirely) captureException is a
// documented no-op. The whole call is fire-and-forget: a reporting
// failure must never break the application's own error handling.
function reportCaughtError(
  subsystem: LogSubsystem,
  operation: string,
  error: unknown,
  context: SafeContext | undefined,
  errorCode: string | undefined,
) {
  try {
    if (typeof (error as { digest?: unknown })?.digest === "string") {
      return;
    }
    Sentry.captureException(error, {
      tags: { subsystem, operation },
      extra: { ...context, ...(errorCode ? { errorCode } : {}) },
    });
  } catch {
    // Reporting is best-effort — never propagate.
  }
}

function emit(
  level: "info" | "warn" | "error",
  subsystem: LogSubsystem,
  operation: string,
  fields: SafeContext,
  rawError?: unknown,
) {
  const entry = { level, subsystem, operation, ...fields };
  // In development, pass the raw error as a second console argument so
  // devtools show the real stack. In production only the normalized
  // JSON fields are emitted.
  if (process.env.NODE_ENV === "production") {
    console[level](JSON.stringify(entry));
  } else {
    console[level](entry, rawError);
  }
}

export function logError(
  subsystem: LogSubsystem,
  operation: string,
  error: unknown,
  context?: SafeContext,
  options?: LogErrorOptions,
) {
  const safe = normalizeError(error);
  emit(
    "error",
    subsystem,
    operation,
    {
      ...context,
      errorName: safe.name,
      errorCode: safe.code,
      errorMessage: safe.message,
    },
    error,
  );
  if (options?.sentry !== false) {
    reportCaughtError(subsystem, operation, error, context, safe.code);
  }
}

export function logWarn(
  subsystem: LogSubsystem,
  operation: string,
  message: string,
  context?: SafeContext,
) {
  emit("warn", subsystem, operation, { ...context, message });
}

export function logInfo(
  subsystem: LogSubsystem,
  operation: string,
  message: string,
  context?: SafeContext,
) {
  emit("info", subsystem, operation, { ...context, message });
}
