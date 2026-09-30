// PGlite-backed tests for the public-intake rate limiter (#219).
// Fixed windows, per-bucket isolation, expiry cleanup, and the
// fail-open degradation contract are all exercised against real SQL —
// no sleeps: the clock is injected.

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { runMigrationsOnPglite } from "@/lib/db/migrate";

const { logError, logWarn } = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logError, logWarn }));

import {
  checkRateLimit,
  rateLimitRules,
  RATE_LIMIT_DEFAULTS,
} from "@/lib/rate-limit";
import type { RegistryDb } from "@/lib/registry/public-animals";

let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await runMigrationsOnPglite(db);
}, 60_000);

afterAll(async () => {
  await pglite.close();
});

const SUBJECT = "a".repeat(64);
const T0 = new Date("2026-09-29T12:00:00Z");

async function windowRows() {
  const res = await db.execute(
    sql`select count(*)::int as n from rate_limit_windows`,
  );
  return (res as unknown as { rows: { n: number }[] }).rows[0].n;
}

describe("checkRateLimit", () => {
  test("allows up to the configured max, then throttles with a retry bound", async () => {
    const bucket = "registration.submit"; // default max 8 / 600s
    for (let i = 0; i < 8; i++) {
      const d = await checkRateLimit(bucket, SUBJECT, db, T0);
      expect(d.allowed).toBe(true);
      expect(d.status).toBe("ok");
    }
    const ninth = await checkRateLimit(bucket, SUBJECT, db, T0);
    expect(ninth.allowed).toBe(false);
    if (!ninth.allowed) {
      expect(ninth.retryAfterSeconds).toBeGreaterThan(0);
      expect(ninth.retryAfterSeconds).toBeLessThanOrEqual(600);
    }
  });

  test("different buckets do not consume each other's quota", async () => {
    const now = new Date(T0.getTime() + 610_000);
    for (let i = 0; i < 8; i++) {
      await checkRateLimit("registration.submit", SUBJECT, db, now);
    }
    // A different bucket on the same subject is untouched.
    const sighting = await checkRateLimit("sighting.submit", SUBJECT, db, now);
    expect(sighting.allowed).toBe(true);
    // A different subject on the same bucket is untouched.
    const other = await checkRateLimit(
      "registration.submit",
      "b".repeat(64),
      db,
      now,
    );
    expect(other.allowed).toBe(true);
  });

  test("a fresh window resets the count", async () => {
    const subject = "c".repeat(64);
    const w0 = new Date("2026-09-30T00:00:00Z");
    for (let i = 0; i < 9; i++) {
      await checkRateLimit("sighting.submit", subject, db, w0);
    }
    const later = new Date(w0.getTime() + 601_000);
    const d = await checkRateLimit("sighting.submit", subject, db, later);
    expect(d.allowed).toBe(true);
  });

  test("expired windows are swept on subsequent hits", async () => {
    const subject = "d".repeat(64);
    const past = new Date("2026-09-25T00:00:00Z");
    await checkRateLimit("registration.submit", subject, db, past);
    await checkRateLimit("sighting.submit", subject, db, past);
    const before = await windowRows();
    expect(before).toBeGreaterThanOrEqual(2);

    // A hit far in the future sweeps everything expired.
    await checkRateLimit(
      "registration.submit",
      subject,
      db,
      new Date("2026-10-01T00:00:00Z"),
    );
    const after = await windowRows();
    expect(after).toBe(1); // only the just-created row remains
  });

  test("a broken limiter store degrades to allowed and reports normally", async () => {
    const broken = {
      insert: () => {
        throw new Error("db unreachable");
      },
    } as unknown as RegistryDb;
    const d = await checkRateLimit(
      "registration.submit",
      SUBJECT,
      broken,
      T0,
    );
    expect(d.allowed).toBe(true);
    expect(d.status).toBe("degraded");
    // Mechanism failure is an operational error (→ Sentry via logError),
    // NOT a warn — and it carries no subject material.
    expect(logError).toHaveBeenCalledWith(
      "rate-limit",
      "rate-limit-check",
      expect.any(Error),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe("rateLimitRules", () => {
  test("defaults when no override is configured", () => {
    expect(rateLimitRules({})).toEqual(RATE_LIMIT_DEFAULTS);
  });

  test("valid overrides apply per bucket", () => {
    const rules = rateLimitRules({
      RATE_LIMIT_CONFIG: JSON.stringify({
        "sighting.submit": { max: 2 },
      }),
    });
    expect(rules["sighting.submit"].max).toBe(2);
    expect(rules["sighting.submit"].windowSeconds).toBe(600);
    expect(rules["registration.submit"]).toEqual(
      RATE_LIMIT_DEFAULTS["registration.submit"],
    );
  });

  test("malformed config can never widen or zero a limit", () => {
    const bad = rateLimitRules({
      RATE_LIMIT_CONFIG: JSON.stringify({
        "registration.submit": { max: -5, windowSeconds: 0 },
        "sighting.submit": "bogus",
      }),
    });
    expect(bad["registration.submit"]).toEqual(
      RATE_LIMIT_DEFAULTS["registration.submit"],
    );
    expect(bad["sighting.submit"]).toEqual(
      RATE_LIMIT_DEFAULTS["sighting.submit"],
    );
    expect(rateLimitRules({ RATE_LIMIT_CONFIG: "{not json" })).toEqual(
      RATE_LIMIT_DEFAULTS,
    );
  });
});
