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

// Server/test env resolution only. Browser code must NOT route through
// these helpers: a defaulted env object defeats Next.js client-bundle
// inlining, which only substitutes statically analyzable
// `process.env.NEXT_PUBLIC_*` member expressions (#146). The client
// bundle receives the RESOLVED decision instead — next.config.ts calls
// resolveSentryRuntime() at build time and injects the result as
// NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT / NEXT_PUBLIC_SENTRY_SEND_EVENTS.
export function getSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  // The DSN is public configuration (it is embedded in the client
  // bundle by design) — not an authentication secret. The DSN being
  // present is necessary but NOT sufficient for events to leave the
  // process: resolveSentryRuntime().sendEvents is the sending boundary.
  return env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

// Environment classification (#235). `vercel env pull` copies the
// production environment into a developer's .env.local — including
// VERCEL_ENV="production" and NEXT_PUBLIC_SENTRY_ENVIRONMENT="production"
// — so VERCEL_ENV and NODE_ENV alone can never prove deployment
// context. The variables below are only populated on Vercel's own
// infrastructure (VERCEL_DEPLOYMENT_ID at build AND runtime,
// VERCEL_REGION at runtime) and are never emitted by `env pull`, which
// makes them the reliable "this process is a real Vercel deployment"
// signal.
function isVercelDeployment(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(env.VERCEL_DEPLOYMENT_ID || env.VERCEL_REGION);
}

// Test/E2E contexts: the Playwright webServer sets
// NEXT_PUBLIC_USE_FIREBASE_EMULATOR, `firebase emulators:exec` exports
// the emulator host vars to the whole process tree, vitest sets
// NODE_ENV=test / VITEST, and CI (GitHub Actions) is never an
// operational runtime. Checked only AFTER isVercelDeployment — Vercel
// also sets CI=1 during builds, and ordering is what keeps a real
// deployment from being mislabeled.
function isTestRuntime(env: Record<string, string | undefined>): boolean {
  return (
    env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true" ||
    Boolean(env.FIREBASE_AUTH_EMULATOR_HOST) ||
    Boolean(env.FIRESTORE_EMULATOR_HOST) ||
    env.NODE_ENV === "test" ||
    Boolean(env.VITEST) ||
    Boolean(env.CI)
  );
}

function sentryEnvironmentOverride(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || env.SENTRY_ENVIRONMENT;
}

// The single environment decision for every runtime. `environment` is
// a Sentry LABEL, never proof of deployment: off Vercel infrastructure
// it can resolve to "development" or "test" but NEVER "production" —
// a pulled .env.local describing the production project cannot
// reclassify the process that runs it.
export function resolveSentryEnvironment(
  env: Record<string, string | undefined> = process.env,
): string {
  if (isVercelDeployment(env)) {
    // Real deployment: VERCEL_ENV is authoritative (custom Vercel
    // environments report "preview"). The explicit override remains as
    // a documented escape hatch for a missing/unexpected VERCEL_ENV —
    // it can never run ahead of it, so a mis-scoped override cannot
    // relabel a preview deployment as production.
    if (env.VERCEL_ENV === "production") return "production";
    if (env.VERCEL_ENV === "preview") return "preview";
    return sentryEnvironmentOverride(env) || "development";
  }
  // Off Vercel: honor an explicit override only when it is itself
  // non-production — this keeps a deliberate local label working for
  // debugging while making "production" unreachable.
  const override = sentryEnvironmentOverride(env);
  if (override && override !== "production") return override;
  return isTestRuntime(env) ? "test" : "development";
}

export interface SentryRuntimeDecision {
  // Present iff a DSN is configured; sendEvents already implies it.
  dsn: string | undefined;
  // The environment tag events will carry if sendEvents is true.
  environment: string;
  // Whether Sentry may deliver events from this process at all.
  sendEvents: boolean;
}

// The single send/no-send decision (#235). On real Vercel deployments
// the DSN's project-side scoping decides which environments report
// (Production + Preview is the recommended setup). Everywhere else —
// local dev, CI, Playwright E2E, emulator runs — outbound delivery is
// OFF unless SENTRY_ENABLE_LOCAL=true is set deliberately, in which
// case events still carry the non-production label resolved above.
// When sendEvents is false the SDK is never initialized at all, rather
// than initializing and filtering each event afterward.
export function resolveSentryRuntime(
  env: Record<string, string | undefined> = process.env,
): SentryRuntimeDecision {
  const dsn = getSentryDsn(env);
  return {
    dsn,
    environment: resolveSentryEnvironment(env),
    sendEvents:
      Boolean(dsn) &&
      (isVercelDeployment(env) || env.SENTRY_ENABLE_LOCAL === "true"),
  };
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
