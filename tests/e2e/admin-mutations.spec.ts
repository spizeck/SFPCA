// E2E journeys for the #91 mutation hardening, run entirely against the
// Firebase emulator suite (firestore :8080, auth :9099, storage :9199).
// No real Firebase project or Sentry endpoint is ever contacted.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  // The Klaro notice is role="dialog" and would collide with the admin
  // form dialog's getByRole("dialog") locator.
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

// Toasts render twice in the DOM — once visibly and once in the
// screen-reader live region — so assertions need exact text matching.
function toast(page: Page, text: string) {
  return page.getByText(text, { exact: true });
}

test.describe("admin mutation hardening", () => {
  test("animal create → delete is confirm-gated: cancel keeps, confirm removes", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);

    // Create
    await page.getByRole("button", { name: "Add Animal" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("E2E Hardening Animal");
    await dialog.getByRole("button", { name: "Add Animal" }).click();
    await expect(toast(page, "Animal added successfully")).toBeVisible();
    const row = page.getByRole("row", { name: /E2E Hardening Animal/ });
    await expect(row).toBeVisible();

    // Delete → cancel keeps the record
    await page
      .getByRole("button", { name: "Delete E2E Hardening Animal" })
      .click();
    await expect(
      page.getByRole("dialog").getByText(/Permanently delete the record/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();

    // Delete → confirm removes it
    await page
      .getByRole("button", { name: "Delete E2E Hardening Animal" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(toast(page, "Animal deleted successfully")).toBeVisible();
    await expect(row).not.toBeVisible();
  });

  test("FAQ validation names missing fields and preserves entered data", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/faq");
    await dismissConsentNotice(page);

    await page.getByRole("button", { name: "Add FAQ", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Question").fill("E2E draft question");
    await dialog.getByRole("button", { name: "Add FAQ" }).click();

    // Field-level errors; the entered question is preserved.
    await expect(dialog.getByText("Choose a category.")).toBeVisible();
    await expect(dialog.getByText("Enter an answer.")).toBeVisible();
    await expect(dialog.getByLabel("Question")).toHaveValue(
      "E2E draft question",
    );

    // Completing the fields then saves normally.
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "General" }).click();
    await dialog.getByLabel("Answer").fill("E2E draft answer");
    await dialog.getByRole("button", { name: "Add FAQ" }).click();
    await expect(toast(page, "FAQ added successfully")).toBeVisible();
    await expect(
      page.getByText("E2E draft question", { exact: true }),
    ).toBeVisible();

    // Leave the emulator clean for other specs.
    await page
      .getByRole("button", { name: "Delete FAQ: E2E draft question" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(toast(page, "FAQ deleted successfully")).toBeVisible();
  });

  test("settings: unsaved-change warning, then save persists", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/settings");
    await dismissConsentNotice(page);
    await expect(page.getByLabel("Phone")).toBeVisible();
    const originalPhone = await page.getByLabel("Phone").inputValue();

    // Dirty the form, then try to leave via the admin nav. Playwright
    // auto-dismisses window.confirm (returns false), so navigation must
    // be blocked and the edit retained.
    await page.getByLabel("Phone").fill("+599 416 9999");
    await page.getByRole("link", { name: "Animals" }).click();
    await expect(page).toHaveURL(/\/admin\/settings/);
    await expect(page.getByLabel("Phone")).toHaveValue("+599 416 9999");

    // Saving completes and persists.
    await page
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await expect(toast(page, "Settings saved successfully")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Phone")).toHaveValue("+599 416 9999");

    // Restore the seeded value — other specs read this document.
    await page.getByLabel("Phone").fill(originalPhone);
    await page
      .getByRole("button", { name: "Save Changes", exact: true })
      .click();
    await expect(toast(page, "Settings saved successfully")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Phone")).toHaveValue(originalPhone);
  });

  test("backend failure during sign-in shows a retryable error, retry recovers", async ({
    page,
  }) => {
    // Simulate a backend failure on the app's own session endpoint. The
    // Firestore SDK retries transport failures as "unavailable" rather
    // than surfacing them, so the honest terminal-failure boundary in E2E
    // is the app's session POST: a 500 surfaces immediately as a safe,
    // retryable error. The Auth emulator (:9099) is untouched.
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "E2E simulated failure" }),
      }),
    );

    await page.goto("/login");
    await dismissConsentNotice(page);
    await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Safe failure feedback — no raw error text — and the staff member is
    // told they may retry. The form stays usable.
    await expect(toast(page, "Login Failed")).toBeVisible();
    await expect(
      page.getByText(/try again/i, { exact: false }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // Restore the endpoint and retry — sign-in completes.
    await page.unroute("**/api/auth/session");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/admin");
  });
});
