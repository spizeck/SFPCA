// SEO smoke checks against the rendered application head. The E2E server
// does not set NEXT_PUBLIC_SITE_URL, so canonical/OG URLs must resolve to
// the production fallback origin — proving preview/local origins cannot
// become canonical.
import { expect, test } from "@playwright/test";

const ORIGIN = "https://www.sabafpca.com";

const INDEXABLE_ROUTES = [
  "/",
  "/animal-adoptions",
  "/animal-registration",
  "/contact",
  "/faq",
  "/vet-services",
];

test.describe("SEO metadata", () => {
  for (const path of INDEXABLE_ROUTES) {
    test(`${path} has production canonical and OG URL`, async ({ page }) => {
      // domcontentloaded: pages with background <video> never finish `load`
      // because the media stream stays open; head metadata is already in the
      // SSR HTML.
      await page.goto(path, { waitUntil: "domcontentloaded" });

      const canonical = await page
        .locator('link[rel="canonical"]')
        .getAttribute("href");
      expect(canonical).toBe(`${ORIGIN}${path === "/" ? "" : path}`);

      const ogUrl = await page
        .locator('meta[property="og:url"]')
        .getAttribute("content");
      expect(ogUrl).toBe(`${ORIGIN}${path === "/" ? "" : path}`);

      const ogImage = await page
        .locator('meta[property="og:image"]')
        .first()
        .getAttribute("content");
      expect(ogImage).toBe(`${ORIGIN}/opengraph-image`);
    });
  }

  test("non-indexable surfaces carry noindex", async ({ page }) => {
    for (const path of ["/login", "/under-construction"]) {
      await page.goto(path);
      const robots = await page
        .locator('meta[name="robots"]')
        .getAttribute("content");
      expect(robots).toContain("noindex");
    }
  });

  test("organization JSON-LD is present and parseable", async ({ page }) => {
    await page.goto("/");
    const jsonLd = await page
      .locator('script[type="application/ld+json"]')
      .textContent();
    const data = JSON.parse(jsonLd ?? "{}");
    expect(data["@type"]).toBe("Organization");
    expect(data.url).toBe(ORIGIN);
  });

  test("robots.txt permits the public site and points at the sitemap", async ({
    request,
  }) => {
    const body = await (await request.get("/robots.txt")).text();
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /admin/");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /login");
    expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  test("sitemap.xml lists only indexable public routes", async ({
    request,
  }) => {
    const body = await (await request.get("/sitemap.xml")).text();
    for (const path of INDEXABLE_ROUTES) {
      expect(body).toContain(`${ORIGIN}${path === "/" ? "" : path}`);
    }
    expect(body).not.toContain("under-construction");
    expect(body).not.toContain("login");
    expect(body).not.toContain("admin");
  });

  test("generated share image is served as a PNG", async ({ request }) => {
    const res = await request.get("/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
});
