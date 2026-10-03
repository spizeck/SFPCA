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

// Read the lifecycle row. On any database failure this resolves to
// 'live' — the same fail-safe direction as a missing row — and warns
// once per process so the outage is diagnosable rather than silently
// flipping demo surfaces off (or a live site into a non-indexable
// state) on a transient error.
let lifecycleReadFailed = false;

export async function getAppLifecycle(
  db?: RegistryDb,
): Promise<AppLifecycle> {
  try {
    // Resolved inside the try: getRegistryDb() throws when DATABASE_URL
    // is absent (e.g. a deployment that never touches the registry),
    // and a default-parameter evaluation would escape this catch and
    // fail every proxied request instead of resolving 'live'.
    const registry = db ?? getRegistryDb();
    const [row] = await registry
      .select({ lifecycle: appState.lifecycle })
      .from(appState)
      .where(eq(appState.id, 1))
      .limit(1);
    return resolveAppLifecycle(row?.lifecycle);
  } catch (error) {
    if (!lifecycleReadFailed) {
      lifecycleReadFailed = true;
      logWarn(
        "admin",
        "app-lifecycle read",
        `app_state read failed; resolving as 'live': ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    return APP_LIFECYCLE_LIVE;
  }
}

// Per-instance memoized read for the per-request proxy — one tiny query
// per TTL window per serverless instance instead of a Postgres roundtrip
// on every request. Staleness inside TTL is acceptable: the only runtime
// transition is go-live, and a ≤60s delay before the last noindex header
// drops is harmless.
const LIFECYCLE_CACHE_TTL_MS = 60_000;
let cached: { value: AppLifecycle; at: number } | null = null;

export async function getCachedAppLifecycle(
  db?: RegistryDb,
  ttlMs: number = LIFECYCLE_CACHE_TTL_MS,
): Promise<AppLifecycle> {
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.value;
  }
  const value = await getAppLifecycle(db);
  cached = { value, at: Date.now() };
  return value;
}

// Test seam: reset the memo between isolated runs.
export function resetCachedAppLifecycle(): void {
  cached = null;
}
