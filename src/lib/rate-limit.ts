import "server-only";

// Server-side rate limiting for unauthenticated public intake (#219).
//
// Design: a fixed-window counter per (bucket, subject) row in Postgres.
// Postgres is the only durable store both the Vercel functions and the
// local/E2E harness already share — an in-memory map would throttle only
// per instance, which on serverless is closer to a hint than a limit.
// The upsert is a single INSERT ... ON CONFLICT ... DO UPDATE, so
// concurrent hits on one window serialize on the row lock and the
// returned count is exact.
//
// Fail-open, loudly: if the limiter store itself fails, the mutation is
// allowed and the failure is reported through the normal
// caught-operational-error path (logError → Sentry). Availability of the
// public forms outranks throttle strictness at this app's scale, and a
// silently-degraded limiter would be invisible — a noisily-degraded one
// is not.
//
// Limits live in RATE_LIMIT_DEFAULTS below — one named place, not
// scattered through handlers. RATE_LIMIT_CONFIG (JSON) overrides per
// bucket for tests/E2E, e.g.:
//   {"sighting.submit":{"max":2,"windowSeconds":3600}}

import { lt, sql } from "drizzle-orm";
import { getRegistryDb } from "@/lib/db/client";
import type { RegistryDb } from "@/lib/registry/public-animals";
import { rateLimitWindows } from "@/lib/db/schema";
import { logError, logWarn } from "@/lib/logger";

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

export type RateLimitBucket =
  | "registration.submit"
  | "sighting.submit"
  | "receipt.finalize";

// Sized for real island traffic, not one-request-per-person: the
// registration form takes a whole household's animals in a single
// submit, but retries, staff-assisted kiosk sessions, and several users
// behind one NAT/mobile carrier all share an IP-derived identity. The
// limits stop scripted bursts; a determined human pacing below them is
// a staff-triage concern, not an abuse-control one.
export const RATE_LIMIT_DEFAULTS: Record<RateLimitBucket, RateLimitRule> = {
  "registration.submit": { max: 8, windowSeconds: 600 },
  "sighting.submit": { max: 10, windowSeconds: 600 },
  "receipt.finalize": { max: 12, windowSeconds: 600 },
};

function isRule(value: unknown): value is Partial<RateLimitRule> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.max === undefined ||
      (typeof v.max === "number" && Number.isInteger(v.max) && v.max > 0)) &&
    (v.windowSeconds === undefined ||
      (typeof v.windowSeconds === "number" &&
        Number.isInteger(v.windowSeconds) &&
        v.windowSeconds > 0))
  );
}

// RATE_LIMIT_CONFIG is a JSON object keyed by bucket name; malformed
// entries are ignored rather than trusted — a bad override must never
// widen or zero a limit.
export function rateLimitRules(
  env: Record<string, string | undefined> = process.env,
): Record<RateLimitBucket, RateLimitRule> {
  const rules = { ...RATE_LIMIT_DEFAULTS };
  const raw = env.RATE_LIMIT_CONFIG;
  if (!raw) return rules;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const bucket of Object.keys(rules) as RateLimitBucket[]) {
      const override = parsed[bucket];
      if (isRule(override)) {
        rules[bucket] = { ...rules[bucket], ...override };
      }
    }
  } catch {
    // Invalid JSON → defaults. Intentionally silent: env parsing runs on
    // every call and a warn per request would spam the logs.
  }
  return rules;
}

export type RateLimitOutcome =
  | { allowed: true; status: "ok" }
  | { allowed: true; status: "degraded" }
  | { allowed: false; status: "ok"; retryAfterSeconds: number };

// Count one attempt against a bucket/window for the given subject. The
// subject is already a salted digest — this module never sees a raw IP.
export async function checkRateLimit(
  bucket: RateLimitBucket,
  subject: string,
  db: RegistryDb = getRegistryDb(),
  now: Date = new Date(),
): Promise<RateLimitOutcome> {
  const rule = rateLimitRules()[bucket];
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(
    Math.floor(now.getTime() / windowMs) * windowMs,
  );
  const expiresAt = new Date(windowStart.getTime() + windowMs);

  try {
    const [{ count }] = await db
      .insert(rateLimitWindows)
      .values({
        bucket,
        subject,
        windowStart,
        count: 1,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          rateLimitWindows.bucket,
          rateLimitWindows.subject,
          rateLimitWindows.windowStart,
        ],
        set: { count: sql`${rateLimitWindows.count} + 1` },
      })
      .returning();

    // Retention is structural: every hit sweeps rows whose window has
    // fully expired. Indexed on expires_at, so the delete is cheap and
    // the table stays proportional to active subjects — not to uptime.
    // lt() (not sql`... < ${now}`) — the raw template passes the Date
    // through unmapped and the PGlite wire bridge rejects it.
    await db
      .delete(rateLimitWindows)
      .where(lt(rateLimitWindows.expiresAt, now));

    if (count <= rule.max) {
      return { allowed: true, status: "ok" };
    }
    return {
      allowed: false,
      status: "ok",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
      ),
    };
  } catch (error) {
    // Limiter infrastructure failure is a real operational fault — it
    // follows the normal caught-error convention (→ Sentry) so a broken
    // limiter pages someone, while the intake path stays available. The
    // subsystem is "rate-limit" regardless of which intake path called:
    // the fault is in the limiter, and the runbook monitors that name.
    logError("rate-limit", "rate-limit-check", error);
    return { allowed: true, status: "degraded" };
  }
}

// The throttle event itself is an expected security outcome — warn-level
// operational signal, never a Sentry error, and it carries no subject
// material (the digest stays out of logs too: nothing to key on anyway).
export function warnThrottled(
  subsystem: "registration" | "lost-found" | "receipt",
  bucket: RateLimitBucket,
  outcome: Extract<RateLimitOutcome, { allowed: false }>,
) {
  logWarn(subsystem, "rate-limited", "Public intake request throttled", {
    bucket,
    retryAfterSeconds: outcome.retryAfterSeconds,
  });
}
