"use client";

// The pre-launch demo banner. Mounted once in the root layout so it
// renders on every surface — public pages, the admin shell, and the
// owner portal — including statically-prerendered HTML (the client fetch
// is what makes the banner appear/disappear with the lifecycle row
// rather than with a rebuild). It renders nothing until the state is
// known, and nothing at all once the deployment is live.
//
// The banner is a fixed, non-interactive strip: it must be impossible
// for a board member to mistake seeded records for real SFPCA data, but
// it must not push content around or swallow clicks — it overlays the
// top edge of the viewport with pointer-events disabled and pages
// continue to scroll normally beneath it.
//
// Fetch-failure posture: once a demo lifecycle has been confirmed in
// this browser session, the confirmation is persisted in
// sessionStorage so a transient /api/app-state outage cannot silently
// unlabel fictional data mid-demo. The endpoint answers 503 on a
// failed lifecycle read rather than guessing 'live', and only a
// CONFIRMED live response clears the persisted label. A failed fetch
// retries once before giving up (a permanently-down API would leave
// the page degraded anyway). We deliberately do NOT render an
// "unknown" notice before the first response: after go-live every
// hard navigation would flash a demo caution on the real site for
// the duration of the fetch.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  APP_LIFECYCLE_LIVE,
  APP_LIFECYCLE_PRELAUNCH_DEMO,
} from "@/lib/app-lifecycle-label";

const SESSION_KEY = "sfpca:lifecycle";

// sessionStorage has no change events — the snapshot is only evaluated
// at hydration (restoring a persisted demo label) and again whenever a
// state update re-renders the component (picking up the storage write
// or removal the fetch handler just made). The server snapshot is
// always false, keeping SSR and first client render identical.
const subscribe = () => () => {};
const getClientSnapshot = () =>
  window.sessionStorage.getItem(SESSION_KEY) === APP_LIFECYCLE_PRELAUNCH_DEMO;
const getServerSnapshot = () => false;

export function PrelaunchDemoBanner() {
  const persistedDemo = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
  const [confirmed, setConfirmed] = useState<
    "prelaunch-demo" | "live" | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    let retried = false;

    const load = () =>
      fetch("/api/app-state", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (cancelled) return;
          const lifecycle = body?.lifecycle as string | undefined;
          if (lifecycle === APP_LIFECYCLE_PRELAUNCH_DEMO) {
            window.sessionStorage.setItem(SESSION_KEY, lifecycle);
            setConfirmed(APP_LIFECYCLE_PRELAUNCH_DEMO);
          } else if (lifecycle === APP_LIFECYCLE_LIVE) {
            // A CONFIRMED live response clears a persisted demo label —
            // go-live mid-session. The endpoint answers 503 on a failed
            // lifecycle read, which lands on neither branch.
            window.sessionStorage.removeItem(SESSION_KEY);
            setConfirmed(APP_LIFECYCLE_LIVE);
          }
        })
        .catch(() => {
          if (cancelled || retried) return;
          retried = true;
          setTimeout(load, 1500);
        });

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const demo =
    confirmed === APP_LIFECYCLE_LIVE
      ? false
      : confirmed === APP_LIFECYCLE_PRELAUNCH_DEMO || persistedDemo;

  if (!demo) return null;

  return (
    <div
      role="status"
      aria-label="Pre-launch demo notice"
      className="pointer-events-none fixed inset-x-0 top-0 z-[200] bg-amber-400/95 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-amber-950 shadow-md backdrop-blur-sm"
    >
      PRE-LAUNCH DEMO — every record shown is fictional and will be erased
      before the site goes live
    </div>
  );
}
