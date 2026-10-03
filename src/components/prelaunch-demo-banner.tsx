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
import { useEffect, useState } from "react";
import { APP_LIFECYCLE_PRELAUNCH_DEMO } from "@/lib/app-lifecycle-label";

export function PrelaunchDemoBanner() {
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/app-state", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) {
          setDemo(body?.lifecycle === APP_LIFECYCLE_PRELAUNCH_DEMO);
        }
      })
      .catch(() => {
        // Fail-open: a transient fetch failure must not break the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
