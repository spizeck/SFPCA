// Unit tests for the SEO helpers in src/lib/seo.ts.
// Run via `npm test` (no emulator or credentials needed).
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  PRODUCTION_SITE_URL,
  getSiteUrl,
  absoluteUrl,
  pageMetadata,
  buildSitemap,
  buildRobots,
  organizationJsonLd,
} from "../src/lib/seo";

const ON = { SITE_MAINTENANCE_MODE: "true" };
const OFF = {};

// --- Canonical origin -----------------------------------------------------

test("site URL falls back to the production domain", () => {
  assert.equal(getSiteUrl(OFF), PRODUCTION_SITE_URL);
});

test("configured site URL wins and trailing slashes are stripped", () => {
  assert.equal(
    getSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://staging.example.com/" }),
    "https://staging.example.com",
  );
});

test("VERCEL_URL-style preview origins are never consulted", () => {
  assert.equal(
    getSiteUrl({ VERCEL_URL: "sfpca-abc123.vercel.app" }),
    PRODUCTION_SITE_URL,
  );
});

test("absoluteUrl joins origin and path", () => {
  assert.equal(absoluteUrl("/contact", OFF), `${PRODUCTION_SITE_URL}/contact`);
  assert.equal(absoluteUrl("faq", OFF), `${PRODUCTION_SITE_URL}/faq`);
});

// --- Page metadata --------------------------------------------------------

test("pageMetadata produces canonical, OG, and Twitter fields", () => {
  const meta = pageMetadata({
    path: "/contact",
    title: "Contact Us",
    description: "Get in touch.",
  });
  assert.equal(meta.title, "Contact Us");
  assert.equal(meta.description, "Get in touch.");
  assert.equal(meta.alternates?.canonical, "/contact");
  assert.equal(meta.openGraph && "url" in meta.openGraph && meta.openGraph.url, "/contact");
  assert.equal(meta.twitter && "title" in meta.twitter && meta.twitter.title, "Contact Us");
});

// --- Sitemap --------------------------------------------------------------

test("live sitemap contains exactly the indexable public routes", () => {
  const urls = buildSitemap(OFF).map((entry) => entry.url);
  assert.deepEqual(urls, [
    `${PRODUCTION_SITE_URL}`,
    `${PRODUCTION_SITE_URL}/animal-adoptions`,
    `${PRODUCTION_SITE_URL}/animal-registration`,
    `${PRODUCTION_SITE_URL}/contact`,
    `${PRODUCTION_SITE_URL}/faq`,
    `${PRODUCTION_SITE_URL}/privacy`,
    `${PRODUCTION_SITE_URL}/vet-services`,
  ]);
});

test("sitemap excludes operational and gated surfaces", () => {
  const urls = buildSitemap(OFF).map((entry) => entry.url);
  for (const url of urls) {
    assert.ok(!url.includes("/admin"), url);
    assert.ok(!url.includes("/login"), url);
    assert.ok(!url.includes("/api"), url);
    assert.ok(!url.includes("/under-construction"), url);
  }
});

test("sitemap omits lastModified rather than fabricating timestamps", () => {
  for (const entry of buildSitemap(OFF)) {
    assert.equal(entry.lastModified, undefined);
  }
});

test("maintenance mode returns an empty sitemap", () => {
  assert.deepEqual(buildSitemap(ON), []);
});

// --- Robots ---------------------------------------------------------------

test("live robots allows the public site and excludes private surfaces", () => {
  const robots = buildRobots(OFF);
  const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
  assert.equal(rule?.userAgent, "*");
  assert.equal(rule?.allow, "/");
  assert.deepEqual(rule?.disallow, ["/admin/", "/api/", "/login"]);
  assert.equal(robots.sitemap, `${PRODUCTION_SITE_URL}/sitemap.xml`);
});

test("live robots does not disallow /under-construction (its noindex must be fetchable)", () => {
  const robots = buildRobots(OFF);
  const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
  const disallowed = Array.isArray(rule?.disallow)
    ? rule.disallow
    : [rule?.disallow];
  assert.ok(!disallowed.some((d) => d?.includes("under-construction")));
});

test("maintenance robots disallows everything and drops the sitemap", () => {
  const robots = buildRobots(ON);
  const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
  assert.equal(rule?.disallow, "/");
  assert.equal(robots.sitemap, undefined);
});

// --- Structured data ------------------------------------------------------

test("organization JSON-LD contains only verified facts", () => {
  const data = organizationJsonLd(OFF);
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "Organization");
  assert.equal(data.name, "Saba Foundation for Preventing Cruelty to Animals");
  assert.equal(data.alternateName, "SFPCA");
  assert.equal(data.url, PRODUCTION_SITE_URL);
  assert.equal(data.logo, `${PRODUCTION_SITE_URL}/android-chrome-512x512.png`);
  assert.equal(JSON.stringify(data).includes("<"), false);
});
