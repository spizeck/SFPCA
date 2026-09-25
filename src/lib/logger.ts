// Minimal structured logging convention for application-controlled
// operational events. Server-side calls are captured by Vercel runtime
// logs; client-side calls stay in the visitor's browser console (there
// is no centralized browser telemetry — see README's observability
// section). Both emit one JSON object per event so fields are
// queryable rather than buried in free text.
//
// Hard rule: never pass request bodies, Firestore documents, form
// payloads, receipt paths, tokens, cookies, headers, or env values to
// these functions. Errors are normalized to name/code/message — the
// raw Error object is only echoed in development for stack traces.

export type LogSubsystem =
  | "auth"
  | "session"
  | "registration"
  | "receipt"
  | "admin"
  | "animals"
  | "vaccinations"
  | "medical"
  | "microchips"
  | "communications"
  | "lost-found"
  | "content"
  | "portal"
  | "owners"
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
