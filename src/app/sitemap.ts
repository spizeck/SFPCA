import type { MetadataRoute } from "next";
import { buildSitemap } from "@/lib/seo";
import { getCachedAppLifecycleStrict } from "@/lib/app-lifecycle";
import { APP_LIFECYCLE_PRELAUNCH_DEMO } from "@/lib/app-lifecycle-label";

// Dynamic: same reason as robots.ts — the sitemap follows the live
// lifecycle row, so the pre-launch demo can never leave stale demo URLs
// advertised once the site goes live.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Unconfirmed lifecycle → empty sitemap: an outage during the demo
  // must not advertise URLs, and an empty sitemap post-launch is
  // harmless (it is a discovery hint, not a removal directive).
  const lifecycle =
    (await getCachedAppLifecycleStrict()) ?? APP_LIFECYCLE_PRELAUNCH_DEMO;
  return buildSitemap(process.env, lifecycle);
}
