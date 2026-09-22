// Consent boundary: Klaro gates Google Tag Manager. All Google traffic is
// intercepted and fulfilled locally — nothing reaches real Google services.
import { expect, test, type Page } from "@playwright/test";

const GOOGLE_REQUESTS = /googletagmanager\.com/;
const CONSENT_KEY = "sfpca-consent";

async function interceptGoogle(page: Page, hits: string[]) {
  await page.route(GOOGLE_REQUESTS, async (route) => {
    hits.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "// intercepted fake gtm.js",
    });
  });
}

function notice(page: Page) {
  return page.locator(".cookie-notice");
}

// Klaro URL-encodes the JSON blob it stores.
function consentStorage(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : decodeURIComponent(raw);
  }, CONSENT_KEY);
}

test.describe("consent + GTM boundary", () => {
  test("first visit shows the notice, defaults to denied, loads nothing from Google", async ({
    page,
  }) => {
    const hits: string[] = [];
    await interceptGoogle(page, hits);
    await page.goto("/");

    await expect(notice(page)).toBeVisible();

    // Consent Mode v2 defaults are pushed before anything else could run.
    const defaults = await page.evaluate(
      () =>
        (window.dataLayer ?? []).find(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            (e as ArrayLike<unknown>)[0] === "consent" &&
            (e as ArrayLike<unknown>)[1] === "default",
        ) as unknown[] | undefined,
    );
    expect(defaults?.[2]).toEqual({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });

    // No stored consent yet and no Google traffic.
    expect(await consentStorage(page)).toBeNull();
    await page.waitForTimeout(300);
    expect(hits).toEqual([]);
  });

  test("declining keeps the site usable, stores the choice, and keeps analytics off", async ({
    page,
  }) => {
    const hits: string[] = [];
    await interceptGoogle(page, hits);
    await page.goto("/");

    await notice(page).getByRole("button", { name: "I decline" }).click();
    await expect(notice(page)).toBeHidden();

    // Site still works — normal navigation proceeds.
    await expect(
      page.getByRole("heading", {
        name: "Saba Foundation for Preventing Cruelty to Animals",
      }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Privacy policy" }).click();
    await expect(
      page.getByRole("heading", { name: "Privacy Policy" }),
    ).toBeVisible();

    // Choice persisted; a reload neither re-prompts nor loads Google.
    expect(await consentStorage(page)).toBeTruthy();
    await page.reload();
    await expect(notice(page)).toBeHidden();
    await page.waitForTimeout(300);
    expect(hits.filter((u) => u.includes("gtm.js"))).toEqual([]);
  });

  test("accepting loads GTM once; consent survives reload and client-side navigation", async ({
    page,
  }) => {
    const hits: string[] = [];
    await interceptGoogle(page, hits);
    await page.goto("/");

    await notice(page)
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await expect(notice(page)).toBeHidden();

    // gtm.js requested exactly once, injected as a single script element.
    await expect
      .poll(() => hits.filter((u) => u.includes("gtm.js")).length)
      .toBe(1);
    expect(hits[0]).toContain("gtm.js?id=GTM-E2ETEST");
    await expect(page.locator("script#sfpca-gtm-script")).toHaveCount(1);

    // A consent 'update' granting analytics_storage was pushed.
    const granted = await page.evaluate(() =>
      (window.dataLayer ?? []).some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as ArrayLike<unknown>)[0] === "consent" &&
          (e as ArrayLike<unknown>)[1] === "update" &&
          (e as ArrayLike<unknown>[])[2] &&
          ((e as ArrayLike<unknown>)[2] as Record<string, string>)
            .analytics_storage === "granted",
      ),
    );
    expect(granted).toBe(true);

    // Client-side navigation: same document, no re-injection, no new request.
    await page.getByRole("link", { name: "Privacy policy" }).click();
    await expect(
      page.getByRole("heading", { name: "Privacy Policy" }),
    ).toBeVisible();
    await expect(page.locator("script#sfpca-gtm-script")).toHaveCount(1);
    expect(hits.filter((u) => u.includes("gtm.js"))).toHaveLength(1);

    // Full reload: stored consent re-applies, notice stays away, GTM loads.
    await page.reload();
    await expect(notice(page)).toBeHidden();
    await expect
      .poll(() => hits.filter((u) => u.includes("gtm.js")).length)
      .toBe(2);
    await expect(page.locator("script#sfpca-gtm-script")).toHaveCount(1);
  });

  test("footer Cookie settings reopens the manager and a changed choice applies without reload", async ({
    page,
  }) => {
    const hits: string[] = [];
    await interceptGoogle(page, hits);
    await page.goto("/");

    // Decline first, then change our mind via the persistent footer control.
    await notice(page).getByRole("button", { name: "I decline" }).click();
    await page
      .getByRole("button", { name: "Cookie settings" })
      .click();
    const modal = page.locator(".cookie-modal");
    await expect(modal).toBeVisible();

    // The modal groups the single service under its purpose; the purpose
    // toggle is the visible control (the checkbox itself is covered by
    // Klaro's slider label — click the label, as a user would).
    await modal
      .locator('label.cm-list-label[for="purpose-item-analytics"]')
      .click();
    await modal.getByRole("button", { name: "Save" }).click();
    await expect(modal).toBeHidden();

    await expect
      .poll(() => hits.filter((u) => u.includes("gtm.js")).length)
      .toBe(1);
    const stored = await consentStorage(page);
    expect(stored).toContain('"google-tag-manager":true');
  });
});
