import type { MetadataRoute } from "next";
import { buildRobots } from "@/lib/seo";
import { getCachedAppLifecycleStrict } from "@/lib/app-lifecycle";
import { APP_LIFECYCLE_PRELAUNCH_DEMO } from "@/lib/app-lifecycle-label";

// Dynamic: the demo lifecycle is a database row, not a build artifact —
// robots must reflect go-live the moment it happens without a redeploy.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  // An unconfirmed lifecycle publishes the RESTRICTIVE variant: during a
  // demo-window outage a fresh instance must not flip to crawlable
  // rules. Post-launch a transient disallow-all is bounded — indexed
  // pages stay indexed (Disallow blocks recrawling, not the index) and
  // crawlers refetch robots.txt regularly.
  const lifecycle =
    (await getCachedAppLifecycleStrict()) ?? APP_LIFECYCLE_PRELAUNCH_DEMO;
  return buildRobots(process.env, lifecycle);
}
