import type { MetadataRoute } from "next";
import { buildRobots } from "@/lib/seo";
import { getCachedAppLifecycle } from "@/lib/app-lifecycle";

// Dynamic: the demo lifecycle is a database row, not a build artifact —
// robots must reflect go-live the moment it happens without a redeploy.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  return buildRobots(process.env, await getCachedAppLifecycle());
}
