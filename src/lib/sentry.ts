// Shared Sentry configuration for every runtime (browser, server).
//
// Privacy boundary: SFPCA stores private animal-registration data
// (owner names, emails, phones, addresses, receipt paths). Everything
// that could carry it is stripped here before an event can leave the
// process. The rule is: if a field cannot confidently be shown to be
// safe, it is omitted. Non-sensitive diagnostic context (route,
// runtime, error type, release, digest) is preserved.
//
// This module is imported by the client bundle — it must stay free of
// server-only dependencies and must never contain real credentials.

import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";

// Firebase Auth codes that represent routine rejections (expired/
// revoked/malformed credentials, attacker-crafted input) rather than
// incidents. Mirrors EXPECTED_AUTH_ERROR_CODES in src/lib/auth.ts —
// that module is server-only (imports next/headers), so the set is
// duplicated here; keep both in agreement.
const EXPECTED_AUTH_ERROR_CODES = new Set([
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/session-cookie-expired",
  "auth/session-cookie-revoked",
  "auth/invalid-session-cookie",
  "auth/argument-error",
  "auth/user-disabled",
]);

// Structured PII shapes that can legitimately appear inside error
// messages or breadcrumb text (Firebase errors echo emails; receipt
// object paths name private documents). Free-form names/phones/
// addresses are not reliably regexable — those are prevented by
// stripping the carriers (request bodies, headers, cookies, locals)
// rather than by pattern-matching values.
const STRING_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Receipt object paths (receipts/<registration doc id>)
  [/\breceipts\/[\w-]+/g, "receipts/[redacted]"],
  // Bearer / token material embedded in messages
  [/Bearer\s+\S+/gi, "Bearer [redacted]"],
  // Email addresses
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]"],
];

// Keys that must never be transmitted regardless of where they appear.
// Includes the carriers themselves (headers, cookies, body, data,
// query) so a nested request object anywhere in the event cannot leak.
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|cookie|authorization|auth|receipt|email|phone|address|owner|api[-_]?key|private[-_]?key|session|credential|ssn|headers?|body|query|data/i;

export function getSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  // The DSN is public configuration (it is embedded in the client
  // bundle by design) — not an authentication secret. Absent DSN →
  // Sentry is never initialized and no event can leave the process.
  return env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

export function getSentryEnvironment(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
    env.SENTRY_ENVIRONMENT ||
    env.VERCEL_ENV ||
    env.NODE_ENV ||
    "development"
  );
}

function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Origin + pathname only — query strings and fragments can carry
// sensitive parameters and are stripped wholesale.
function stripUrlQuery(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not an absolute URL (e.g. a path or malformed value) — drop
    // anything after ? or # without trusting the shape.
    return redactString(url.split(/[?#]/)[0]);
  }
}

function scrubQueryParams(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("://") ? stripUrlQuery(value) : redactString(value);
  }
  return value;
}

// Deep-scrub a breadcrumb's data payload: strings are redacted, URL-ish
// keys lose their query strings, and keys whose names imply sensitive
// content are removed entirely.
function sanitizeBreadcrumbData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (/^url$|^from$|^to$/.test(key) && typeof value === "string") {
      out[key] = stripUrlQuery(value);
    } else {
      out[key] = scrubQueryParams(value);
    }
  }
  return out;
}

// Breadcrumb categories that are not worth the privacy surface:
// console.* text can echo application payloads, and ui.* crumbs record
// interactions with form controls (registration/contact inputs).
const DROP_BREADCRUMB_CATEGORIES = new Set([
  "console",
  "ui.input",
  "ui.click",
]);

export function sentryBeforeBreadcrumb(
  crumb: Breadcrumb,
): Breadcrumb | null {
  if (crumb.category && DROP_BREADCRUMB_CATEGORIES.has(crumb.category)) {
    return null;
  }
  const out: Breadcrumb = { ...crumb };
  if (typeof out.message === "string") {
    out.message = redactString(out.message);
  }
  out.data = sanitizeBreadcrumbData(out.data);
  return out;
}

function isExpectedAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && EXPECTED_AUTH_ERROR_CODES.has(code);
}

// Recursively scrub arbitrary event payloads (extra/contexts): strings
// are redacted, sensitive-named keys removed, depth bounded so a
// pathological object can't bloat the event.
function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((v) => sanitizePayload(v, depth + 1))
      .filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      const cleaned = sanitizePayload(v, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

export function sentryBeforeSend(
  event: ErrorEvent,
  hint: EventHint,
): ErrorEvent | null {
  // Backstop: expected auth rejections (classified in src/lib/auth.ts)
  // are caught and logged at warn level by callers — if one ever
  // escapes into a capture path anyway, it is still not an incident.
  if (isExpectedAuthError(hint?.originalException)) return null;

  const out: ErrorEvent = { ...event };

  // Identity is never set — no user id/email/IP association. The SDK
  // cannot attach what it does not have, and anything upstream adds
  // here is dropped unconditionally.
  delete out.user;
  delete out.server_name;

  // Request context: keep method + origin/path only. Headers, cookies,
  // bodies, and query strings are the carriers for registration PII,
  // session cookies, ID tokens, and Authorization material.
  if (out.request) {
    const { method, url } = out.request;
    out.request = {
      ...(method ? { method } : {}),
      ...(url ? { url: stripUrlQuery(url) } : {}),
    };
  }

  // Exception values: keep type + redacted message + stack frames.
  // frame.vars are local variables captured at throw time (the Node
  // LocalVariables integration) — they can contain request objects and
  // form data, so they are removed per-frame.
  if (out.exception?.values) {
    for (const value of out.exception.values) {
      if (typeof value.value === "string") {
        value.value = redactString(value.value);
      }
      if (value.stacktrace?.frames) {
        for (const frame of value.stacktrace.frames) {
          delete frame.vars;
        }
      }
    }
  }

  if (typeof out.message === "string") {
    out.message = redactString(out.message);
  }

  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .map((crumb) => sentryBeforeBreadcrumb(crumb))
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }

  if (out.extra) {
    out.extra = sanitizePayload(out.extra) as typeof out.extra;
  }
  if (out.contexts) {
    out.contexts = sanitizePayload(out.contexts) as typeof out.contexts;
  }
  if (out.tags) {
    out.tags = sanitizePayload(out.tags) as typeof out.tags;
  }

  return out;
}

// Tracing is deliberately not part of this integration (#139 is error
// monitoring only). Returning null guarantees no transaction, span, or
// profile payload can be emitted even if a default integration creates
// one — the option knobs are defense-in-depth, this is the boundary.
// `unknown` keeps this assignable to the SDK's typed hook without
// importing a type @sentry/nextjs does not re-export.
export function sentryBeforeSendTransaction(
  _event: unknown,
  _hint: unknown,
): null {
  return null;
}
