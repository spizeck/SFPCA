import "server-only";

// Deployment lifecycle state (#275 pre-launch board demo).
//
// The single app_state row classifies what this deployment is allowed to
// be: 'prelaunch-demo' while the registry is empty and the board is
// evaluating seeded fictional data, 'live' once real records begin. The
// transition is one-way — the app_state_live_is_final database trigger
// refuses any update or delete of a 'live' row, so the only way back is
// deliberately dropping a database trigger (never an app action).
//
// Resolution rule: a MISSING row resolves to 'live' — normal operation.
// This is deliberate fail-safe direction: if the row were ever lost after
// go-live the site must not re-enter demo presentation (banner, noindex,
// email sink), and the demo tooling refuses rather than assuming a demo
// window exists. Demo mode is only ever entered by the migration's seed
// of a fresh database or by an operator re-engaging it explicitly.
//
// What 'prelaunch-demo' changes at runtime (all data-driven — no redeploy
// needed to leave demo mode, only to enter it):
//   - <PrelaunchDemoBanner/> renders on every surface (client component
//     polling /api/app-state — static HTML gets it without a rebuild)
//   - robots.txt disallows everything, the sitemap is empty, and every
//     response carries X-Robots-Tag: noindex (proxy.ts)
//   - the reminder cron swaps Resend for an inert demo-sink sender (or a
//     single operator-configured override inbox) — board actions can
//     never emit real email (src/lib/email.ts)
// Sentry's environment label is build-time config instead: setting
// NEXT_PUBLIC_SENTRY_ENVIRONMENT=prelaunch-demo in Vercel tags this
// deployment's events 'prelaunch-demo' until the next deploy
// (src/lib/sentry.ts).

import { eq } from "drizzle-orm";
import { appState } from "./db/schema";
import { getRegistryDb } from "./db/client";
import { logWarn } from "./logger";
import type { RegistryDb } from "./db/client";
import {
  APP_LIFECYCLE_LIVE,
  APP_LIFECYCLE_PRELAUNCH_DEMO,
  type AppLifecycleLabel,
} from "./app-lifecycle-label";

export {
  APP_LIFECYCLE_LIVE,
  APP_LIFECYCLE_PRELAUNCH_DEMO,
} from "./app-lifecycle-label";
export type AppLifecycle = AppLifecycleLabel;

// Pure classifier — separately testable, and the single place the
// "missing row means live" rule lives. A row's lifecycle value is
// CHECK-constrained to the two known states, but anything unexpected
// still resolves to 'live' (never assume demo mode).
export function resolveAppLifecycle(
  lifecycle: string | null | undefined,
): AppLifecycle {
  return lifecycle === APP_LIFECYCLE_PRELAUNCH_DEMO
    ? APP_LIFECYCLE_PRELAUNCH_DEMO
    : APP_LIFECYCLE_LIVE;
}

export function isPrelaunchDemo(lifecycle: AppLifecycle): boolean {
  return lifecycle === APP_LIFECYCLE_PRELAUNCH_DEMO;
}

// Strict lifecycle read for side-effecting paths (reminder sends,
// destructive sweeps): never guess 'live' on a read failure.
// `undefined` means "unknown" and the caller must fail closed.
export async function getAppLifecycleStrict(
  db?: RegistryDb,
): Promise<AppLifecycle | undefined> {
  try {
    // Resolved inside the try: getRegistryDb() throws when DATABASE_URL
    // is absent (e.g. a deployment that never touches the registry).
    const registry = db ?? getRegistryDb();
    const [row] = await registry
      .select({ lifecycle: appState.lifecycle })
      .from(appState)
      .where(eq(appState.id, 1))
      .limit(1);
    return resolveAppLifecycle(row?.lifecycle);
  } catch (error) {
    logWarn(
      "admin",
      "app-lifecycle read",
      `app_state read failed; lifecycle unknown: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return undefined;
  }
}

// Read the lifecycle row for presentation surfaces (banner, SEO,
// proxy). On any database failure this resolves to 'live' — the same
// fail-safe direction as a missing row — so a LIVE site never flashes a
// demo banner or deindexes on a transient error. Side-effecting
// callers must use getAppLifecycleStrict instead.
export async function getAppLifecycle(
  db?: RegistryDb,
): Promise<AppLifecycle> {
  return (await getAppLifecycleStrict(db)) ?? APP_LIFECYCLE_LIVE;
}

// Per-instance memoized read for the per-request proxy — one tiny query
// per TTL window per serverless instance instead of a Postgres roundtrip
// on every request. Staleness inside TTL is acceptable: the only runtime
// transition is go-live, and a ≤60s delay before the last noindex header
// drops is harmless.
const LIFECYCLE_CACHE_TTL_MS = 60_000;
let cached: { value: AppLifecycle; at: number } | null = null;

// Strict cached read: returns the last CONFIRMED lifecycle — fresh
// cached value, or a successful read, or a stale cached value when the
// read fails. `undefined` only when nothing was ever confirmed (a cold
// start during a read outage). Callers decide their own fail direction:
// crawler metadata should publish its restrictive variant on undefined;
// per-request headers should fall back to 'live'.
export async function getCachedAppLifecycleStrict(
  db?: RegistryDb,
  ttlMs: number = LIFECYCLE_CACHE_TTL_MS,
): Promise<AppLifecycle | undefined> {
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.value;
  }
  const value = await getAppLifecycleStrict(db);
  if (value === undefined) {
    return cached?.value;
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function getCachedAppLifecycle(
  db?: RegistryDb,
  ttlMs: number = LIFECYCLE_CACHE_TTL_MS,
): Promise<AppLifecycle> {
  // Read failure: preserve the last CONFIRMED state rather than
  // guessing. A demo-window outage then keeps the noindex posture
  // instead of flipping the demo site to live SEO; post-go-live the
  // cache only ever holds 'live', so an outage can never resurrect
  // the demo presentation. A cold-start failure still resolves
  // 'live' — the fail-safe direction for a fresh deploy.
  return (
    (await getCachedAppLifecycleStrict(db, ttlMs)) ?? APP_LIFECYCLE_LIVE
  );
}

// Test seam: reset the memo between isolated runs.
export function resetCachedAppLifecycle(): void {
  cached = null;
}
