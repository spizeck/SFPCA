// Hydration regression coverage for issue #153: Framer Motion components
// previously rendered different markup on the server and first client render
// under `prefers-reduced-motion` (shouldReduceMotion() read matchMedia during
// render), which both logged a React hydration mismatch and — because React
// does not patch mismatched attributes — left SSR-hidden elements
// permanently invisible. These tests fail on hydration warnings rather than
// allowlisting them, and assert that animated content actually reaches
// opacity 1 (Playwright's toBeVisible passes for opacity:0 elements).
import { expect, test, type Page } from "@playwright/test";

const PUBLIC_ROUTES = [
  "/",
  "/animal-adoptions",
  "/animal-registration",
  "/veterinary-services",
  "/faq",
  "/contact",
] as const;

const HYDRATION_MISMATCH =
  /hydrat|server rendered HTML|didn't match the client|did not match/i;

function collectHydrationErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && HYDRATION_MISMATCH.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (HYDRATION_MISMATCH.test(error.message)) {
      errors.push(error.message);
    }
  });
  return errors;
}

// Reveal animations use whileInView, so scroll the full page to trigger
// every one before asserting visibility.
async function scrollThroughPage(page: Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight / 2;
    const height = document.documentElement.scrollHeight;
    for (let y = 0; y <= height; y += step) {
      // The site sets scroll-behavior:smooth, which animates plain
      // scrollTo() calls and can skip intermediate positions — always
      // scroll instantly so every whileInView element intersects.
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  });
}

// Elements currently inside the viewport whose computed opacity is 0 —
// the pre-fix failure mode was SSR-hidden content that never revealed.
// Below-fold elements legitimately stay hidden until scrolled to, so only
// in-viewport elements are counted.
function hiddenInViewportCount(page: Page) {
  return page.evaluate(() => {
    let count = 0;
    document.querySelectorAll("[style]").forEach((el) => {
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      // Skip deliberately hidden controls (e.g. Radix's visually-hidden
      // checkbox/radio inputs use pointer-events:none); only animation-hidden
      // content matters here.
      const pointerHidden = (el.getAttribute("style") || "").includes(
        "pointer-events: none",
      );
      if (inViewport && !pointerHidden && getComputedStyle(el).opacity === "0")
        count++;
    });
    return count;
  });
}

async function expectCleanHydration(page: Page, route: string) {
  const hydrationErrors = collectHydrationErrors(page);
  await page.goto(route);

  const h1 = page.getByRole("heading", { level: 1 }).first();
  await expect(h1).toBeVisible();
  // The pre-fix bug left the hero at opacity:0 forever under reduced motion.
  await expect
    .poll(() => h1.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");

  await scrollThroughPage(page);

  // Nothing inside the viewport may remain hidden at any scroll position.
  const positions = await page.evaluate(() => {
    const height = document.documentElement.scrollHeight;
    return [0, 0.25, 0.5, 0.75, 1].map((f) =>
      Math.min(Math.round(height * f), height - window.innerHeight),
    );
  });
  for (const y of positions) {
    await page.evaluate(
      (top) => window.scrollTo({ top, behavior: "instant" }),
      y,
    );
    await expect
      .poll(() => hiddenInViewportCount(page), { timeout: 5_000 })
      .toBe(0);
  }

  expect(hydrationErrors).toEqual([]);
}

test.describe("hydration", () => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test.describe(`prefers-reduced-motion: ${reducedMotion}`, () => {
      test.use({ reducedMotion });

      for (const route of PUBLIC_ROUTES) {
        test(`${route} hydrates without mismatches and reveals content`, async ({
          page,
        }) => {
          await expectCleanHydration(page, route);
        });
      }
    });
  }

  test.describe("mobile viewport", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      test.describe(`prefers-reduced-motion: ${reducedMotion}`, () => {
        test.use({ reducedMotion });

        test("homepage hydrates without mismatches and reveals content", async ({
          page,
        }) => {
          await expectCleanHydration(page, "/");
        });
      });
    }
  });

  // JavaScript disabled: SSR markup ships the hidden initial styles, so the
  // noscript override in the root layout must be what reveals the content.
  test("homepage content is not hidden without JavaScript", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const html = await page.content();
      // Reveal animations still ship their hidden initial styles in SSR HTML.
      expect(html).toMatch(/opacity:\s*0/);
      // The noscript fallback must be present to restore them.
      expect(html).toMatch(/<noscript>[\s\S]*opacity:1 !important[\s\S]*<\/noscript>/);
      expect(html).toMatch(/transform:none !important/);
    } finally {
      await context.close();
    }
  });
});
