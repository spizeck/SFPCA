// E2E for the #177 exception dashboard — the realistic volunteer
// session the issue asks for:
//   sign in → see several seeded exceptions → click an overdue vet
//   count → land on the filtered queue → resolve it canonically →
//   click an unpaid-registration count → land on that queue → resolve
//   it → back on the dashboard both counts have moved.
//
// Ordering note: the e2e suite shares one PGlite datastore and runs
// files alphabetically on a single worker. This file runs BEFORE the
// specs that create vet/registration state, so "overdue vet work" and
// "awaiting payment" counts here are exactly what this spec creates.
// Assertions about shared queues (unregistered animals, confirmations)
// are presence-based, never absolute totals.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  // The Klaro notice is role="dialog" and collides with medical dialogs.
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("volunteer exception dashboard (#177)", () => {
  test("dashboard → filtered queue → resolve → count updates", async ({
    page,
  }) => {
    const year = new Date().getFullYear();
    await signInAsAdmin(page);

    // --- Dashboard immediately answers "what needs my attention?" -----
    await expect(
      page.getByRole("heading", { name: "Operations dashboard" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Needs attention" }),
    ).toBeVisible();

    // Seeded exceptions are already visible without remembering pages:
    // animals missing current registration, overdue confirmations, and
    // the seeded open chip conflict.
    await expect(
      page.getByRole("link", {
        name: new RegExp(`animals? missing ${year} registration`),
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /overdue ownership confirmations?/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /microchip conflicts? to resolve/ }),
    ).toBeVisible();

    // Mobile: the queue must still scan cleanly on a phone.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.getByRole("heading", { name: "Needs attention" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: new RegExp(`animals? missing ${year} registration`),
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });

    // --- Create overdue vet work through the canonical workflow -------
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);
    await page.getByRole("button", { name: "Add Animal" }).click();
    const animalDialog = page.getByRole("dialog");
    await animalDialog.getByLabel("Name").fill("E2E Dash Dog");
    await animalDialog.getByRole("button", { name: "Add Animal" }).click();
    await expect(
      page.getByText("Animal added successfully", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("row", { name: /E2E Dash Dog/ })
      .getByRole("link", { name: "E2E Dash Dog" })
      .click();
    await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]{36}/);
    const dashDogUrl = page.url();

    await page.getByRole("button", { name: "Log visit" }).click();
    const visitDialog = page.getByRole("dialog");
    await visitDialog.getByLabel(/^Reason/).fill("Limping");
    await visitDialog.getByLabel("Schedule a recheck / follow-up").check();
    await visitDialog.getByLabel("Recheck date").fill("2020-01-01");
    await visitDialog.getByLabel("Recheck for").fill("Recheck limp");
    await visitDialog.getByRole("button", { name: "Save entry" }).click();
    await expect(
      page.getByText("Entry recorded", { exact: true }),
    ).toBeVisible();

    // --- Dashboard → filtered vet queue → resolve → back ---------------
    await page.goto("/admin");
    await page
      .getByRole("link", { name: /vet items? overdue/ })
      .click();
    // The count lands on the queue pre-filtered to overdue work.
    await expect(page).toHaveURL(/\/admin\/vet\?window=overdue/);
    const recheckRow = page.getByRole("row", { name: /Recheck limp/ });
    await expect(recheckRow).toBeVisible();
    await expect(recheckRow.getByText("E2E Dash Dog")).toBeVisible();

    await recheckRow
      .getByRole("button", {
        name: "Complete Recheck limp — E2E Dash Dog",
      })
      .click();
    await expect(
      page.getByRole("row", { name: /Recheck limp/ }),
    ).not.toBeVisible();

    await page.goto("/admin");
    await expect(
      page.getByRole("link", { name: /vet items? overdue/ }),
    ).not.toBeVisible();

    // --- Registration gap → unpaid → payment clears it -----------------
    await page.goto("/admin");
    await page
      .getByRole("link", {
        name: new RegExp(`animals? missing ${year} registration`),
      })
      .click();
    await expect(page).toHaveURL(/\/admin\/registrations#unregistered/);
    await expect(
      page.getByRole("row", { name: /E2E Dash Dog/ }),
    ).toBeVisible();

    // Register from the queue — the canonical action for this exception.
    await page
      .getByRole("row", { name: /E2E Dash Dog/ })
      .getByRole("button", { name: "Register" })
      .click();
    // The animal leaves the gap queue and lands as unpaid work.
    await expect(
      page.getByRole("row", { name: /E2E Dash Dog.*Unpaid/ }),
    ).toBeVisible();

    await page.goto("/admin");
    await page
      .getByRole("link", { name: /registrations? with an unpaid balance/ })
      .click();
    await expect(page).toHaveURL(/\/admin\/registrations#outstanding/);
    await expect(
      page.getByRole("row", { name: /E2E Dash Dog.*Unpaid/ }),
    ).toBeVisible();

    // Resolve canonically — record the payment on the animal's profile.
    await page.goto(dashDogUrl);
    await page
      .getByRole("button", { name: "Record payment" })
      .first()
      .click();
    await page.locator('input[type="number"]').first().fill("100");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Paid").first()).toBeVisible();

    // Back on the dashboard the paid work is gone — a resolved
    // exception disappears instead of counting down to a stale 0.
    await page.goto("/admin");
    await expect(
      page.getByRole("link", { name: /registrations? with an unpaid balance/ }),
    ).not.toBeVisible();

    // The routine line still names genuinely-clear domains rather than
    // pretending the whole registry is quiet (unregistered animals
    // remain).
    await expect(
      page.getByText(/Running normally:/),
    ).toContainText("Lost & found");
  });
});
