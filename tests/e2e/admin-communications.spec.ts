// E2E for the communications/reminder surface (#172), run against the
// Firebase emulators + PGlite registry — no real credentials, no email
// provider. The dry-run preview is exercised for real: it evaluates the
// registry and reports zero work without sending anything.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("communications admin surface", () => {
  test("the dashboard card links to a working exceptions page", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page
      .getByRole("link", { name: "Open communications" })
      .click();
    await expect(page).toHaveURL("/admin/communications");
    await expect(
      page.getByRole("heading", { name: "Communications" }),
    ).toBeVisible();
    // Fresh registry — nothing to act on, and that is stated plainly.
    await expect(
      page.getByText("No exceptions recorded.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No messages recorded yet.", { exact: true }),
    ).toBeVisible();
  });

  test("the dry-run preview evaluates without a provider and sends nothing", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/communications");
    await dismissConsentNotice(page);
    await page
      .getByRole("button", { name: "Preview next reminder run" })
      .click();
    // With no vaccinations due, the run reports zero queued work. The
    // e2e environment has no RESEND_API_KEY — reaching this result at
    // all proves the dry-run path never needs the provider.
    await expect(page.getByText(/evaluated,/)).toBeVisible();
    await expect(page.getByText(/would queue/)).toBeVisible();
  });
});
