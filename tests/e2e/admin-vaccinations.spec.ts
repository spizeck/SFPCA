// E2E for the per-animal vaccination record (#173), run against the
// Firebase emulators + PGlite registry — no real credentials.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  // The Klaro notice is role="dialog" and would collide with the
  // vaccination dialog's getByRole("dialog") locator.
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("admin vaccination records", () => {
  test("staff can open an animal's medical record and add a vaccination", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);

    // Create the animal first (the registry write path is Postgres).
    await page.getByRole("button", { name: "Add Animal" }).click();
    const animalDialog = page.getByRole("dialog");
    await animalDialog.getByLabel("Name").fill("E2E Vaccination Dog");
    await animalDialog
      .getByRole("button", { name: "Add Animal" })
      .click();
    await expect(
      page.getByText("Animal added successfully", { exact: true }),
    ).toBeVisible();

    // Open the canonical animal profile from the registry row.
    await page
      .getByRole("row", { name: /E2E Vaccination Dog/ })
      .getByRole("link", { name: "E2E Vaccination Dog" })
      .click();
    await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: "E2E Vaccination Dog" }),
    ).toBeVisible();
    await expect(
      page.getByText("No medical history recorded yet."),
    ).toBeVisible();

    // Record a rabies dose with a next-due date.
    await page
      .getByRole("button", { name: "Add vaccination" })
      .click();
    const vaxDialog = page.getByRole("dialog");
    await vaxDialog.getByLabel("Vaccine").fill("Rabies");
    await vaxDialog.getByLabel("Date given").fill("2026-09-01");
    await vaxDialog.getByLabel("Next due").fill("2027-09-01");
    await vaxDialog.getByLabel("Given by (optional)").fill("Dr. E2E");
    await vaxDialog
      .getByRole("button", { name: "Add vaccination" })
      .click();
    await expect(
      page.getByText("Vaccination added", { exact: true }),
    ).toBeVisible();

    // The history row shows the vaccine, the next relevant date, and a
    // derived status — staff never compute it themselves.
    const row = page.getByRole("row", { name: /Rabies/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("2027-09-01")).toBeVisible();
    await expect(row.getByText("Current")).toBeVisible();
    await expect(row.getByText("Dr. E2E")).toBeVisible();
  });

  test("vaccination form rejects a missing administered date", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);

    await page.getByRole("button", { name: "Add Animal" }).click();
    const animalDialog = page.getByRole("dialog");
    await animalDialog.getByLabel("Name").fill("E2E Validation Cat");
    await animalDialog
      .getByRole("button", { name: "Add Animal" })
      .click();
    await expect(
      page.getByText("Animal added successfully", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("row", { name: /E2E Validation Cat/ })
      .getByRole("link", { name: "E2E Validation Cat" })
      .click();
    await page
      .getByRole("button", { name: "Add vaccination" })
      .click();
    const vaxDialog = page.getByRole("dialog");
    await vaxDialog.getByLabel("Vaccine").fill("FVRCP");
    await vaxDialog
      .getByRole("button", { name: "Add vaccination" })
      .click();

    // Field-level error; the entered vaccine name is preserved.
    await expect(
      vaxDialog.getByText("Enter the date the dose was given."),
    ).toBeVisible();
    await expect(vaxDialog.getByLabel("Vaccine")).toHaveValue("FVRCP");
  });
});
