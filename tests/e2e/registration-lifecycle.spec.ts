// Registration lifecycle journey: an anonymous visitor submits the
// animal-registration form, the submission lands privately in Firestore,
// and an admin verifies it through the staff lifecycle. Runs entirely
// against the Firebase emulators — never production. All data is
// synthetic.
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("animal registration lifecycle", () => {
  test("a visitor submits a registration and staff verify it", async ({
    page,
  }) => {
    // Unique synthetic values so retries in one emulator session never
    // collide with records from a previous attempt.
    const suffix = Date.now();
    const ownerName = `E2E Owner ${suffix}`;
    const animalName = `E2E Pet ${suffix}`;

    // Anonymous submission through the real public form.
    await page.goto("/animal-registration");
    await dismissConsentNotice(page);
    await page.getByLabel("Full Name").fill(ownerName);
    await page
      .getByRole("textbox", { name: "Address", exact: true })
      .fill("Windwardside, Saba (synthetic)");
    await page.getByLabel("Phone Number").fill("+599 416 0000");
    await page.getByLabel("Email Address").fill(`e2e-${suffix}@example.com`);
    await page.getByLabel("Animal's Name").fill(animalName);
    await page.getByLabel("Type of Animal").fill("Dog");
    // Click the option labels — the Radix radios expose both a button
    // and a hidden bubble input with the same accessible name.
    await page.getByText("Male", { exact: true }).click();
    await page.getByText("Yes", { exact: true }).click();
    await page.getByLabel(/I certify/).check();
    await page
      .getByRole("button", { name: /Submit Registration/ })
      .click();

    // Success is clearly communicated to the submitter.
    await expect(
      page.getByText("Registration Submitted").first(),
    ).toBeVisible();

    // The submission is not visible anywhere on the public site — the
    // private boundary itself is proven by the security-rules tests.
    await page.goto("/");
    await expect(page.getByText(ownerName)).not.toBeVisible();

    // Admin signs in and finds the pending submission.
    await signInAsAdmin(page);
    await page.goto("/admin/registrations");
    const row = page.getByRole("row", { name: new RegExp(ownerName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pending");
    await expect(row).toContainText(animalName);

    // Staff transition it to verified through the lifecycle action.
    await row.getByRole("button", { name: "Verify registration" }).click();
    await expect(row).toContainText("Verified");

    // Reopening is available for corrections and returns it to pending.
    await row
      .getByRole("button", { name: "Reopen registration as pending" })
      .click();
    await expect(row).toContainText("Pending");
  });
});
