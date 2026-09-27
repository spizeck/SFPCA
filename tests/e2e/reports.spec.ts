// E2E for #179 reporting — the two journeys the issue asks for:
//
//   STAFF:  sign in → /admin/reports → see the defined active-known
//           population → switch the registration period → watch
//           registration/payment metrics move → read health and
//           workload sections → download a CSV that carries the same
//           period.
//   PUBLIC: /statistics without any session → labeled aggregate
//           metrics → wording that never claims a Saba-wide census →
//           the seeded single-cat species cell suppressed → no owner
//           PII or chip numbers anywhere in the DOM.
//
// Suite ordering note: specs share one seeded PGlite datastore and run
// alphabetically, so assertions are presence/wording-based, never
// absolute totals. The seeded fixtures guarantee a prior-year
// registration (Reggie) and a 1-cat species cell regardless of what
// other suites added before this file runs.

import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("staff reporting workspace", () => {
  test("defined metrics, period switch, and period-matched CSV export", async ({
    page,
  }) => {
    const year = new Date().getFullYear();
    await signInAsAdmin(page);
    await page.goto("/admin/reports");

    // The workspace leads with the defined population, not a bare count.
    await expect(
      page.getByRole("heading", { name: "Registry reports" }),
    ).toBeVisible();
    await expect(
      page.getByText("Active animals known to SFPCA", { exact: true }),
    ).toBeVisible();
    // Mandatory scope guard: the registry is never a census.
    await expect(
      page.getByText(/not a census of all animals on Saba/),
    ).toBeVisible();

    // Registration/payment sections for the current period.
    await expect(
      page.getByRole("heading", {
        name: `Registration — ${year}`,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `Registration payments — ${year}` }),
    ).toBeVisible();
    await expect(
      page.getByText("Animals registered for", { exact: false }),
    ).toBeVisible();

    // Health/prevention + identification + workload sections exist.
    await expect(
      page.getByRole("heading", { name: "Health & prevention" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Identification — microchips" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Program workload" }),
    ).toBeVisible();

    // Switching the period to the prior year — Reggie's seeded prior-year
    // registration — must move the registration metric.
    await page.getByLabel("Registration period").selectOption(`${year - 1}`);
    await page.getByRole("button", { name: "Update report" }).click();
    await expect(page).toHaveURL(new RegExp(`year=${year - 1}`));
    await expect(
      page.getByRole("heading", { name: `Registration — ${year - 1}` }),
    ).toBeVisible();
    // The seeded prior-year registration is present in the trend table.
    await expect(
      page.getByRole("row", { name: new RegExp(`^${year - 1}`) }),
    ).toBeVisible();

    // CSV export corresponds to the selected period — verify the actual
    // download, not just the link.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("link", { name: `Registration detail (${year - 1})` })
        .click(),
    ]);
    expect(download.suggestedFilename()).toContain(`${year - 1}`);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv).toContain("section,metric,value,denominator,period,as_of");
    expect(csv).toContain(`unique_animals_registered`);
    expect(csv).toContain(`period ${year - 1}`);

    // Mobile layout still scans.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.getByRole("heading", { name: "Registry reports" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("export endpoint is not reachable anonymously or by non-admin", async ({
    page,
  }) => {
    // Anonymous: the site-wide proxy redirects /admin/* to /login before
    // the handler runs. Inspect the redirect itself rather than following
    // it to the (200) login page.
    const anon = await page.request.get(
      "/admin/reports/export?report=overview",
      { maxRedirects: 0 },
    );
    expect(anon.status()).toBe(307);
    expect(anon.headers()["location"]).toContain("/login");

    // Signed-in non-admin: the proxy lets a session cookie through, so
    // the handler's own requireAdmin() is the boundary — and it forbids.
    await page.goto("/login");
    await dismissConsentNotice(page);
    await page.getByLabel("Email").fill(E2E_USER_EMAIL);
    await page.getByLabel("Password").fill(E2E_USER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/portal");
    const forbidden = await page.request.get(
      "/admin/reports/export?report=overview",
    );
    expect(forbidden.status()).toBe(403);
    expect(await forbidden.text()).not.toContain("unique_animals_registered");
  });
});

test.describe("public statistics", () => {
  test("anonymous aggregates with suppression and no PII", async ({
    page,
  }) => {
    await page.goto("/statistics");
    await dismissConsentNotice(page);

    await expect(
      page.getByRole("heading", { name: "Registry Statistics" }),
    ).toBeVisible();
    await expect(
      page.getByText("Active animals known to SFPCA", { exact: true }).first(),
    ).toBeVisible();

    // The scope promise: never "total animals on Saba" as a claim —
    // only the explicit disclaimer.
    await expect(
      page
        .getByText(/cannot estimate the total number of animals on Saba/)
        .first(),
    ).toBeVisible();

    // Seeded small cell: exactly one cat is below the suppression
    // threshold → renders as a withheld category, not a count.
    const speciesTable = page.getByRole("table").first();
    await expect(speciesTable.getByText("Cats")).toBeVisible();
    await expect(speciesTable.getByText(/Fewer than/).first()).toBeVisible();

    // No seeded owner PII, contact detail, or chip number leaks into
    // the DOM.
    const body = await page.content();
    for (const pii of [
      "E2E Owner",
      "e2e-owner@example.com",
      "+599 416 0001",
      "Windwardside",
      "985113001234567",
      "985-113-001-234-567",
    ]) {
      expect(body).not.toContain(pii);
    }

    // Mobile layout: the stat cards still read at phone width.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.getByRole("heading", { name: "Registry Statistics" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
