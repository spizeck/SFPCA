import type { MetadataRoute } from "next";
import { buildSitemap } from "@/lib/seo";
import { getCachedAppLifecycle } from "@/lib/app-lifecycle";

// Dynamic: same reason as robots.ts — the sitemap follows the live
// lifecycle row, so the pre-launch demo can never leave stale demo URLs
// advertised once the site goes live.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(process.env, await getCachedAppLifecycle());
}
