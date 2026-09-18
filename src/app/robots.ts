import type { MetadataRoute } from "next";
import { isMaintenanceMode } from "@/lib/maintenance";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.sabafpca.com";

  // While the public site is gated, discourage crawling/indexing entirely.
  // Normal rules resume automatically once maintenance mode is disabled.
  if (isMaintenanceMode()) {
    return {
      rules: [
        {
          userAgent: "*",
          disallow: "/",
        },
      ],
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin/", "/api/", "/login"],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
