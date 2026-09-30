// Accessibility regression suite for the public website, run against the
// emulator-backed app (see tests/e2e/fixtures.ts for fixtures).
//
// Axe scans assert zero critical/serious violations — the two severities
// that map to real user barriers under a WCAG 2.2 AA baseline. Moderate
// and minor findings are attached to the test report for visibility
// instead of failing the build, so the suite stays meaningful without
// becoming a brittle pseudo-compliance gate.
import AxeBuilder from "@axe-core/playwright";
import { dbQuery, expect, test } from "./fixtures";
import { dismissConsentNotice, signIn } from "./helpers";
import { E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD } from "./env";

const PUBLIC_ROUTES = [
  "/",
  "/contact",
  "/faq",
  "/animal-adoptions",
  "/animal-registration",
  "/vet-services",
  "/statistics",
  "/lost-pets",
  "/under-construction",
  "/login",
] as const;

// Scans run under reduced-motion emulation for determinism: entrance
// animations render instantly at full opacity, the team carousel does not
// auto-rotate, and background videos stay inert behind their dark overlay.
// Axe cannot reliably evaluate text composited over a moving <video>, so
// this also exercises the reduced-motion code path end to end.
// The Klaro consent notice auto-focuses on first visit (correct dialog
// behavior). Route scans dismiss it so they measure the page itself
// deterministically; the notice/modal get their own dedicated scan below.
async function gotoAndSettle(
  page: import("@playwright/test").Page,
  route: string,
) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await expect(page.locator("main#main-content")).toBeVisible();
  await expect(page.locator("main h1")).toBeVisible();
  await dismissConsentNotice(page);

  // Client-side Firestore reads: wait for real seeded content.
  if (route === "/") {
    await expect(
      page.getByRole("button", { name: "What does SFPCA do?" }).first(),
    ).toBeVisible();
  }
  if (route === "/faq") {
    await expect(
      page.getByRole("button", { name: "What does SFPCA do?" }),
    ).toBeVisible();
  }
  if (route === "/animal-adoptions") {
    // "Max" appears in both the featured card and the available list.
    await expect(
      page.getByRole("heading", { name: "Max" }).first(),
    ).toBeVisible();
  }
  if (route === "/statistics") {
    // Assert the populated render, not the "temporarily unavailable"
    // fallback the page degrades to when the report query throws. The
    // phrase also appears in the "About these numbers" glossary, so
    // scope to the stat-card label.
    await expect(
      page
        .getByText("Active animals known to SFPCA", { exact: true })
        .first(),
    ).toBeVisible();
  }
  if (route === "/lost-pets") {
    // Publishing a case is an explicit staff opt-in, so the seeded
    // baseline is the empty state — this route scan measures exactly
    // that. The populated listing gets its own dedicated scan below.
    await expect(
      page.getByText("no animals listed as missing"),
    ).toBeVisible();
  }
}

async function scan(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  const highImpact = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );

  return { results, highImpact };
}

test.describe("public accessibility", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`axe scan: ${route}`, async ({ page }) => {
      await gotoAndSettle(page, route);

      const { results, highImpact } = await scan(page);

      await test.info().attach(`axe-violations-${route.replace(/\//g, "_") || "_root"}.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });

      expect(
        highImpact.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
        ),
        `critical/serious axe violations on ${route}`,
      ).toEqual([]);
    });
  }

  test("axe scan: /lost-pets with a published missing case", async ({
    page,
  }) => {
    // Publishing is an explicit staff opt-in, so the seeded baseline is
    // the empty state the route scan above covers. Open + publish a
    // missing case on Daisy (the dedicated #176 fixture animal) through
    // the same datastore channel the suite uses for mid-test seeding,
    // then scan the populated listing users actually see — the animal
    // card, its metadata, and the sighting button.
    const [daisy] = await dbQuery<{ id: string }>(
      `select id from animals where name = 'Daisy'`,
    );
    await dbQuery(
      `insert into lost_found_cases
         (case_type, animal_id, reported_via, last_seen_on,
          last_seen_location, public_note, published_at, published_by)
       values ('missing', $1, 'staff', '2026-09-28', 'Windwardside',
               'Answers to Daisy — do not chase', now(), 'e2e-accessibility')`,
      [daisy.id],
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/lost-pets", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Daisy" }),
    ).toBeVisible();
    await dismissConsentNotice(page);

    const { results, highImpact } = await scan(page);
    await test.info().attach("axe-violations-_lost-pets-populated.json", {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
    expect(
      highImpact.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "critical/serious axe violations on /lost-pets (populated)",
    ).toEqual([]);

    // The sighting form is the page's interactive surface — scan it
    // open too (this also exercises the honeypot's aria-hidden wrapper).
    await page
      .getByRole("button", { name: "I've seen this animal" })
      .click();
    await expect(page.getByLabel("Where did you see it?")).toBeVisible();
    const { results: formResults, highImpact: formViolations } =
      await scan(page);
    await test.info().attach("axe-violations-_lost-pets-sighting-form.json", {
      body: JSON.stringify(formResults.violations, null, 2),
      contentType: "application/json",
    });
    expect(
      formViolations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "critical/serious axe violations on the /lost-pets sighting form",
    ).toEqual([]);
  });

  test("axe scan: homepage in dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAndSettle(page, "/");

    const { highImpact } = await scan(page);

    expect(
      highImpact.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "critical/serious axe violations on / in dark theme",
    ).toEqual([]);
  });

  test("consent notice and settings modal pass the axe scan", async ({
    page,
  }) => {
    // Same determinism as the route scans: mid-animation translucency
    // produces false color-contrast readings.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const notice = page.locator(".cookie-notice");
    await expect(notice).toBeVisible();
    expect(
      (await scan(page)).highImpact.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "axe violations on the consent notice",
    ).toEqual([]);

    await notice.getByRole("button", { name: "I decline" }).click();
    await page.getByRole("button", { name: "Cookie settings" }).click();
    await expect(page.locator(".cookie-modal")).toBeVisible();
    expect(
      (await scan(page)).highImpact.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "axe violations on the consent modal",
    ).toEqual([]);
  });

  test("skip link is first in tab order and moves focus to main", async ({
    page,
  }) => {
    await page.goto("/");
    await dismissConsentNotice(page);

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible(); // visually appears when focused

    await page.keyboard.press("Enter");
    await expect(page.locator("main#main-content")).toBeFocused();
  });

  test("every public page exposes exactly one main landmark and one h1", async ({
    page,
  }) => {
    for (const route of PUBLIC_ROUTES) {
      await gotoAndSettle(page, route);
      await expect(
        page.locator("main#main-content"),
        `main landmark on ${route}`,
      ).toHaveCount(1);
      await expect(
        page.locator("h1"),
        `h1 on ${route}`,
      ).toHaveCount(1);
    }
  });

  test("team carousel controls have accessible names and work by keyboard", async ({
    page,
  }) => {
    await page.goto("/");

    const carousel = page.getByRole("group", { name: "Who We Are" });
    await expect(carousel).toBeVisible();

    const previous = page.getByRole("button", {
      name: "Previous team members",
    });
    const next = page.getByRole("button", { name: "Next team members" });
    const pause = page.getByRole("button", { name: "Pause slideshow" });
    await expect(previous).toBeVisible();
    await expect(next).toBeVisible();
    await expect(pause).toBeVisible();

    // Slide navigation via a labelled dot control.
    await page.getByRole("button", { name: "Go to slide 2 of 2" }).click();
    await expect(
      page.getByRole("group", { name: "Slide 2 of 2" }),
    ).toBeVisible();

    // Previous button works with keyboard activation.
    await previous.press("Enter");
    await expect(
      page.getByRole("group", { name: "Slide 1 of 2" }),
    ).toBeVisible();

    // Pause toggles the auto-rotation control state.
    await pause.click();
    await expect(
      page.getByRole("button", { name: "Resume slideshow" }),
    ).toBeVisible();
  });

  test("FAQ accordion toggles via native button keyboard semantics", async ({
    page,
  }) => {
    await page.goto("/faq");

    const question = page.getByRole("button", {
      name: "What does SFPCA do?",
    });
    await expect(question).toHaveAttribute("aria-expanded", "false");

    await question.press("Enter");
    await expect(question).toHaveAttribute("aria-expanded", "true");
    const panelId = await question.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    await expect(page.locator(`#${panelId}`)).toBeVisible();

    await question.press("Enter");
    await expect(question).toHaveAttribute("aria-expanded", "false");
  });

  test("registration form exposes labels, groups, and descriptions", async ({
    page,
  }) => {
    await page.goto("/animal-registration");

    // Programmatic labels on owner fields plus sensible autocomplete.
    await expect(page.getByLabel(/Full Name/)).toHaveAttribute(
      "autocomplete",
      "name",
    );
    await expect(page.getByLabel(/Phone Number/)).toHaveAttribute(
      "autocomplete",
      "tel",
    );
    await expect(page.getByLabel(/Email Address/)).toHaveAttribute(
      "autocomplete",
      "email",
    );

    // Radio groups are named via fieldset/legend and required semantically.
    await expect(
      page.getByRole("group", { name: /^Sex/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: /spayed\/neutered/ }),
    ).toBeVisible();

    // File-upload help text is programmatically associated.
    await expect(page.getByLabel(/Upload Payment Receipt/)).toHaveAttribute(
      "aria-describedby",
      "paymentReceipt-help",
    );
  });

  test("login form uses labels and autocomplete", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByLabel("Email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    await expect(page.getByLabel("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
  });

  test("breadcrumb navigation is labelled and marks the current page", async ({
    page,
  }) => {
    await page.goto("/faq");

    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(nav).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveText("Faq");
  });

  test("embedded map iframe has a title", async ({ page }) => {
    await page.goto("/contact");
    await expect(page.locator("main#main-content iframe")).toHaveAttribute(
      "title",
      /Map showing the SFPCA location/,
    );
  });

  test("no horizontal overflow at 360px width on representative routes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });

    for (const route of [
      "/",
      "/faq",
      "/animal-registration",
      "/under-construction",
    ] as const) {
      await gotoAndSettle(page, route);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(1);
    }
  });

  test("decorative background video is hidden and does not autoplay under reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const video = page.locator("video").first();
    await expect(video).toBeAttached();
    await expect(video).toHaveAttribute("aria-hidden", "true");
    await expect(video).not.toHaveAttribute("autoplay", "");
  });
});

test.describe("authenticated accessibility", () => {
  test("axe scan: owner portal", async ({ page }) => {
    // The representative signed-in owner state — the real login flow
    // against the Auth emulator, landing on the pre-linked owner the
    // #166 fixtures seed (animals via both person and household
    // ownership, contact form, requests). This is the populated portal,
    // not the login redirect or the pending-claim shell.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");
    await expect(
      page.getByRole("heading", { name: "Owner Portal" }),
    ).toBeVisible();
    await expect(page.getByText("Signed in as E2E Owner")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Rexley" }),
    ).toBeVisible();
    await dismissConsentNotice(page);

    const { results, highImpact } = await scan(page);
    await test.info().attach("axe-violations-_portal-owner.json", {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
    expect(
      highImpact.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
      "critical/serious axe violations on /portal (signed-in owner)",
    ).toEqual([]);
  });
});
