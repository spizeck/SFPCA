// Lifecycle journey: an animal created as "available" is listed publicly;
// transitioning it to "adopted" removes it from the public listing while
// the admin record is retained. Runs entirely against the Firebase
// emulators (seeded by tests/e2e/global-setup) — never production.
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

test.describe("animal publication lifecycle", () => {
  test("an animal appears publicly only while its status is available", async ({
    page,
  }) => {
    // Unique name so retries inside one emulator session never collide
    // with a record from a previous attempt.
    const animalName = `E2E Lifecycle ${Date.now()}`;

    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    // The Klaro notice is role="dialog" and would collide with the admin
    // form dialog's getByRole("dialog") locator below.
    await dismissConsentNotice(page);

    // Create a public (available) animal through the real admin form.
    await page.getByRole("button", { name: "Add Animal" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(animalName);
    await dialog.getByLabel("Approximate Age").fill("3 years");
    await dialog
      .getByLabel("Description")
      .fill("Synthetic animal created by the E2E lifecycle test.");
    await expect(dialog.getByLabel("Status")).toContainText("Available");
    await dialog.getByRole("button", { name: "Add Animal" }).click();
    await expect(dialog).not.toBeVisible();

    // Admin sees it with an explicit public visibility marker.
    const row = page.getByRole("row", { name: new RegExp(animalName) });
    await expect(row).toContainText("Available");
    await expect(row).toContainText("Public");

    // It is listed on the public adoptions page.
    await page.goto("/animal-adoptions");
    await expect(
      page.getByRole("heading", { name: animalName }),
    ).toBeVisible();

    // Transition to a non-public state through the same form.
    await page.goto("/admin/animals");
    await page.getByRole("button", { name: `Edit ${animalName}` }).click();
    await dialog.getByLabel("Status").click();
    await page.getByRole("option", { name: "Adopted" }).click();
    await dialog.getByRole("button", { name: "Update Animal" }).click();
    await expect(dialog).not.toBeVisible();

    // The animal disappears from the public listing (seeded animals
    // still render, so the listing itself is healthy).
    await page.goto("/animal-adoptions");
    // "Charlie" is a seeded available animal; the name does not collide
    // with the static Success Stories headings (Bella, Max, Luna).
    await expect(
      page.getByRole("heading", { name: "Charlie" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: animalName }),
    ).not.toBeVisible();

    // The underlying record is retained and clearly marked non-public.
    await page.goto("/admin/animals");
    const adoptedRow = page.getByRole("row", { name: new RegExp(animalName) });
    await expect(adoptedRow).toContainText("Adopted");
    await expect(adoptedRow).toContainText("Not public");
  });
});
