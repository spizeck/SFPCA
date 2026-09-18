// Canonical SEO/site-URL helpers. `NEXT_PUBLIC_SITE_URL` is the single
// configured source of truth for the public origin; the production domain is
// the fallback so that builds without the variable still canonicalize to the
// real site. `VERCEL_URL` is deliberately never consulted: it points at
// per-deployment preview domains and must never become canonical.
import type { Metadata, MetadataRoute } from "next";
import { isMaintenanceMode } from "@/lib/maintenance";

export const PRODUCTION_SITE_URL = "https://www.sabafpca.com";

export const SITE_NAME = "SFPCA";
export const SITE_DESCRIPTION =
  "Dedicated to animal welfare, veterinary services, and pet adoption on Saba. Register your pet, adopt an animal, or learn about our veterinary services.";

export const SHARE_IMAGE_ALT =
  "SFPCA — Saba Foundation for Preventing Cruelty to Animals";

// Explicit share-image references. A segment that defines its own
// `openGraph` does not inherit the parent segment's file-convention
// `opengraph-image`, so pages that set OG metadata must name the generated
// image explicitly. Relative URLs resolve against `metadataBase`.
export const SHARE_OG_IMAGES = [
  {
    url: "/opengraph-image",
    width: 1200,
    height: 630,
    alt: SHARE_IMAGE_ALT,
    type: "image/png",
  },
];

export const SHARE_TWITTER_IMAGES = [
  {
    url: "/twitter-image",
    width: 1200,
    height: 630,
    alt: SHARE_IMAGE_ALT,
    type: "image/png",
  },
];

export function getSiteUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.NEXT_PUBLIC_SITE_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : PRODUCTION_SITE_URL;
}

export function absoluteUrl(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${getSiteUrl(env)}${normalized}`;
}

// Shared metadata for an indexable public page. Relative canonical/OG URLs
// resolve against the root `metadataBase`, producing absolute production
// URLs on every route.
export function pageMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      images: SHARE_OG_IMAGES,
    },
    twitter: {
      // Page-level twitter fields replace the root twitter object, so the
      // card type must be restated here.
      card: "summary_large_image",
      title,
      description,
      images: SHARE_TWITTER_IMAGES,
    },
  };
}

// Robots directives for operational/non-indexable surfaces.
export const NOINDEX_ROBOTS: Metadata["robots"] = {
  index: false,
  follow: false,
};

// Indexable public routes. `/under-construction`, `/login`, `/admin/**`, and
// API routes are deliberately absent.
const INDEXABLE_PATHS = [
  "/",
  "/animal-adoptions",
  "/animal-registration",
  "/contact",
  "/faq",
  "/vet-services",
] as const;

export function buildSitemap(
  env: Record<string, string | undefined> = process.env,
): MetadataRoute.Sitemap {
  // Gated public routes must not be advertised to crawlers while the site
  // is under construction; the normal sitemap returns when the gate lifts.
  if (isMaintenanceMode(env)) {
    return [];
  }

  const siteUrl = getSiteUrl(env);
  // No `lastModified`: there is no meaningful per-route timestamp source, and
  // fabricating one is worse than omitting it.
  return INDEXABLE_PATHS.map((path) => ({
    // The root entry has no trailing slash: that is exactly how Next.js
    // renders the resolved canonical/og:url for "/".
    url: `${siteUrl}${path === "/" ? "" : path}`,
    changeFrequency: "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}

export function buildRobots(
  env: Record<string, string | undefined> = process.env,
): MetadataRoute.Robots {
  // While the public site is gated, discourage crawling/indexing entirely.
  // Normal rules resume automatically once maintenance mode is disabled.
  if (isMaintenanceMode(env)) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  // `/under-construction` is intentionally not disallowed: it carries a
  // noindex directive that crawlers can only see if they may fetch it.
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin/", "/api/", "/login"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml", env),
  };
}

// Static Organization JSON-LD containing only facts verifiable from the
// repository. Social `sameAs` is omitted: profile URLs live in Firestore
// siteSettings and are not available statically here.
export function organizationJsonLd(
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const siteUrl = getSiteUrl(env);
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Saba Foundation for Preventing Cruelty to Animals",
    alternateName: SITE_NAME,
    url: siteUrl,
    logo: `${siteUrl}/android-chrome-512x512.png`,
    description:
      "Dedicated to animal welfare, veterinary services, and pet adoption on the island of Saba.",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Saba",
      addressCountry: "BQ",
    },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "animal welfare services",
    },
  };
}
