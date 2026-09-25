// Publication journey (#167): an animal is public only while its
// ADOPTION LISTING is 'available' AND its REGISTRY LIFECYCLE is
// 'active' — two deliberately separate states. Changing the listing to
// 'adopted' or marking the animal deceased both remove it from the
// public catalog, but only the lifecycle change is permanent registry
// history. The admin record is always retained. Runs against the
// Firebase emulators + PGlite (seeded by tests/e2e/global-setup) —
// never production.
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

async function createListedAnimal(
  page: import("@playwright/test").Page,
  animalName: string,
) {
  await page.goto("/admin/animals");
  // The Klaro notice is role="dialog" and would collide with the admin
  // form dialog's getByRole("dialog") locator below.
  await dismissConsentNotice(page);

  await page.getByRole("button", { name: "Add Animal" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(animalName);
  await dialog
    .getByLabel(/^Description/)
    .fill("Synthetic animal created by the E2E lifecycle test.");
  // The listing defaults to "Not listed" — make it public.
  await dialog.getByLabel("Adoption listing").click();
  await page.getByRole("option", { name: "Available" }).click();
  await dialog.getByRole("button", { name: "Add Animal" }).click();
  await expect(dialog).not.toBeVisible();
}

test.describe("animal publication lifecycle", () => {
  test("the adoption listing controls public visibility while the registry record persists", async ({
    page,
  }) => {
    // Unique name so retries inside one emulator session never collide
    // with a record from a previous attempt.
    const animalName = `E2E Lifecycle ${Date.now()}`;

    await signInAsAdmin(page);
    await createListedAnimal(page, animalName);

    // Admin sees it with both badges: lifecycle 'active' and a
    // publicly-visible 'available' listing.
    const row = page.getByRole("row", { name: new RegExp(animalName) });
    await expect(row).toContainText("Active on Saba");
    await expect(row).toContainText("Available");
    await expect(row).toContainText("Public");

    // It is listed on the public adoptions page.
    await page.goto("/animal-adoptions");
    await expect(
      page.getByRole("heading", { name: animalName }),
    ).toBeVisible();

    // The card's "Learn More" link navigates to the public detail page.
    const detailLink = page.getByRole("link", {
      name: `Learn More About ${animalName}`,
    });
    await expect(detailLink).toBeVisible();
    const detailHref = await detailLink.getAttribute("href");
    expect(detailHref).toMatch(/^\/animal-adoptions\/.+/);
    await detailLink.click();
    await expect(page).toHaveURL(detailHref as string);
    await expect(
      page.getByRole("heading", { name: animalName, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Contact Us to Adopt" }),
    ).toBeVisible();

    // Change the LISTING to adopted — the animal is still active in the
    // registry, just out of the public catalog.
    await page.goto("/admin/animals");
    await page.getByRole("button", { name: `Edit ${animalName}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Adoption listing").click();
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

    // The registry record is retained and clearly marked non-public.
    await page.goto("/admin/animals");
    const adoptedRow = page.getByRole("row", { name: new RegExp(animalName) });
    await expect(adoptedRow).toContainText("Active on Saba");
    await expect(adoptedRow).toContainText("Adopted");
    await expect(adoptedRow).toContainText("Not public");

    // Its detail page now 404s — a non-public animal is
    // indistinguishable from a nonexistent one.
    const detailResponse = await page.goto(detailHref as string);
    expect(detailResponse?.status()).toBe(404);
  });

  test("a registry lifecycle transition unpublishes a listed animal and stays in history", async ({
    page,
  }) => {
    const animalName = `E2E Deceased ${Date.now()}`;

    await signInAsAdmin(page);
    await createListedAnimal(page, animalName);

    // Open the canonical profile via the registry list row.
    const row = page.getByRole("row", { name: new RegExp(animalName) });
    await row.getByRole("link", { name: animalName }).click();
    await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: animalName }),
    ).toBeVisible();
    await expect(page.getByText("Active on Saba").first()).toBeVisible();

    // Transition the REGISTRY LIFECYCLE to deceased — a permanent fact
    // about the animal, recorded as history.
    await page
      .getByRole("button", { name: "Change registry status" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("New status").click();
    await page.getByRole("option", { name: "Deceased" }).click();
    await dialog
      .getByLabel(/Reason/)
      .fill("E2E transition — confirmed by owner");
    await dialog.getByRole("button", { name: "Apply transition" }).click();
    await expect(dialog).not.toBeVisible();

    // The profile reflects the new state and preserves the history.
    await expect(page.getByText("Deceased").first()).toBeVisible();
    await expect(page.getByText(/Entered registry as/)).toBeVisible();
    await expect(
      page.getByText(/Active on Saba.*→.*Deceased|→\s*Deceased/),
    ).toBeVisible();
    // The listing still says 'available' — but the badge spells out
    // that a non-active animal cannot be public.
    await expect(page.getByText("Not public").first()).toBeVisible();

    // Publicly the animal is gone even though its listing is still
    // 'available'.
    await page.goto("/animal-adoptions");
    await expect(
      page.getByRole("heading", { name: animalName }),
    ).not.toBeVisible();

    // Back in the registry the record persists with the transition in
    // history — nothing was deleted.
    await page.goto("/admin/animals");
    const goneRow = page.getByRole("row", { name: new RegExp(animalName) });
    await expect(goneRow).toContainText("Deceased");
    await expect(goneRow).toContainText("Not public");
  });

  test("a nonexistent animal id returns a plain 404", async ({ page }) => {
    const response = await page.goto(
      "/animal-adoptions/not-a-real-animal-id",
    );
    expect(response?.status()).toBe(404);
  });
});
