// Public intake abuse controls (#219): honeypot and Postgres-backed
// rate limiting on the two unauthenticated write surfaces.
//
// The Playwright webServer sets RATE_LIMIT_CONFIG with tiny windows
// (registration.submit 2/hour, sighting.submit 2/hour) so throttle
// coverage trips on the third attempt without sleeping. The per-test
// fixture reset truncates rate_limit_windows along with every other
// table, so counts never bleed across tests or retries.
//
// Identity note: there is no proxy in front of `next dev` here, so
// x-vercel-forwarded-for is absent and every request shares the
// loopback-derived subject — that is exactly what makes the limiter
// observable from a single browser context.
import { expect, test, dbQuery } from "./fixtures";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
} from "./env";
import { dismissConsentNotice } from "./helpers";

async function fillAndSubmitRegistration(
  page: import("@playwright/test").Page,
  suffix: string,
) {
  await page.goto("/animal-registration");
  await dismissConsentNotice(page);
  await page.getByLabel("Full Name").fill(`E2E Guard ${suffix}`);
  await page
    .getByRole("textbox", { name: "Address", exact: true })
    .fill("Windwardside, Saba (synthetic)");
  await page.getByLabel("Phone Number").fill("+599 416 0000");
  await page
    .getByLabel("Email Address")
    .fill(`e2e-guard-${suffix}@example.com`);
  await page.getByLabel("Animal's Name").fill(`Guard Pet ${suffix}`);
  await page.getByLabel("Type of Animal").fill("Dog");
  await page.getByText("Male", { exact: true }).click();
  await page.getByText("Yes", { exact: true }).click();
  await page.getByLabel(/I certify/).check();
  await page.getByRole("button", { name: /Submit Registration/ }).click();
}

// Bots reach hidden fields by setting DOM values; Playwright must do
// the same through the native setter so React's controlled input picks
// the value up (fill() refuses non-visible elements — correctly).
async function triggerHoneypot(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page
    .locator(`input[name="${name}"]`)
    .evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, "https://spam.example");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test.describe("public intake guards (#219)", () => {
  test("registration throttles after the configured limit and preserves the form", async ({
    page,
  }) => {
    const suffix = `${Date.now()}`;

    // Limit is 2 — the first two land, the third is turned away.
    await fillAndSubmitRegistration(page, `${suffix}-a`);
    await expect(
      page.getByText("Registration Submitted").first(),
    ).toBeVisible();
    await fillAndSubmitRegistration(page, `${suffix}-b`);
    await expect(
      page.getByText("Registration Submitted").first(),
    ).toBeVisible();
    await fillAndSubmitRegistration(page, `${suffix}-c`);
    await expect(
      page.getByText("Please wait a moment").first(),
    ).toBeVisible();

    // Calm UX: the message explains retry and the entries survived.
    // (.first() — the toast renders text + an aria-live duplicate.)
    await expect(
      page.getByText(/entries are preserved/).first(),
    ).toBeVisible();
    await expect(page.getByLabel("Full Name")).toHaveValue(
      `E2E Guard ${suffix}-c`,
    );

    // Exactly two rows — the throttled attempt wrote nothing.
    const rows = await dbQuery<{ n: number }>(
      `select count(*)::int as n from registration_submissions
       where owner_name like 'E2E Guard ${suffix}-%'`,
    );
    expect(rows[0].n).toBe(2);
  });

  test("a honeypot-filled registration looks successful but writes nothing", async ({
    page,
  }) => {
    const suffix = `${Date.now()}`;
    await page.goto("/animal-registration");
    await dismissConsentNotice(page);
    await triggerHoneypot(page, "website");
    await page.getByLabel("Full Name").fill(`E2E Bot ${suffix}`);
    await page
      .getByRole("textbox", { name: "Address", exact: true })
      .fill("Nowhere");
    await page.getByLabel("Phone Number").fill("+599 416 0000");
    await page
      .getByLabel("Email Address")
      .fill(`e2e-bot-${suffix}@example.com`);
    await page.getByLabel("Animal's Name").fill("Bot Pet");
    await page.getByLabel("Type of Animal").fill("Dog");
    await page.getByText("Male", { exact: true }).click();
    await page.getByText("Yes", { exact: true }).click();
    await page.getByLabel(/I certify/).check();
    await page.getByRole("button", { name: /Submit Registration/ }).click();

    // Generic success — no oracle signal distinguishing a bot.
    await expect(
      page.getByText("Registration Submitted").first(),
    ).toBeVisible();

    const rows = await dbQuery<{ n: number }>(
      `select count(*)::int as n from registration_submissions
       where owner_name = 'E2E Bot ${suffix}'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test("sighting reports throttle after the configured limit", async ({
    page,
  }) => {
    // A published case is required for the public form — open Daisy's
    // missing case and publish it as staff would.
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/admin");

    await page.goto("/admin/animals");
    await page
      .getByRole("row", { name: /Daisy/ })
      .getByRole("link", { name: "Daisy" })
      .click();
    await page.getByRole("button", { name: "Report missing" }).click();
    await page
      .getByLabel("Last seen location (optional)")
      .fill("Windwardside");
    await page
      .getByRole("button", { name: "Open missing case" })
      .click();
    await expect(
      page.getByText("Missing case opened", { exact: true }),
    ).toBeVisible();
    // Publish lives on the case page, not the animal profile.
    await page.getByRole("link", { name: "Open case" }).click();
    await page
      .getByRole("button", { name: "Publish to the lost-pets page" })
      .click();
    await page
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(
      page.getByText("Published to the lost-pets page", { exact: true }),
    ).toBeVisible();

    // Three reports from the public page — the third must throttle.
    await page.goto("/lost-pets");
    for (const n of [1, 2, 3]) {
      await page
        .getByRole("button", { name: "I've seen this animal" })
        .click();
      await page
        .getByLabel("Where did you see it?")
        .fill(`Sighting ${n} near the harbour`);
      await page.getByRole("button", { name: "Send report" }).click();
      if (n < 3) {
        await expect(
          page.getByText(
            "Thank you — your report has been sent to SFPCA.",
          ),
        ).toBeVisible();
        // The sent state replaces the form — reload to report again.
        await page.reload();
      }
    }
    await expect(
      page.getByText(/Too many reports in a short time/),
    ).toBeVisible();

    // Two sighting updates landed; the throttled third wrote nothing.
    const rows = await dbQuery<{ n: number }>(
      `select count(*)::int as n from lost_found_updates
       where kind = 'sighting' and source = 'public'
         and location like 'Sighting % near the harbour'`,
    );
    expect(rows[0].n).toBe(2);
  });
});
