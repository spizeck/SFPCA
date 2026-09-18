// Public visitor smoke journeys against the real application running on
// emulator-backed Firestore content (seeded by tests/e2e/global-setup).
import { expect, test } from "@playwright/test";

test.describe("public journeys", () => {
  test("homepage renders seeded identity content", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: "Saba Foundation for Preventing Cruelty to Animals",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Dedicated to the welfare and protection of animals on the beautiful island of Saba",
      ),
    ).toBeVisible();
  });

  test("visitor can navigate from homepage to the registration page", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Register Your Pet" }).click();

    await expect(page).toHaveURL("/under-construction");
    await expect(
      page.getByRole("link", { name: "Call Us" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Email Us" }),
    ).toBeVisible();
  });

  test("contact page renders seeded contact details as usable links", async ({
    page,
  }) => {
    await page.goto("/contact");

    await expect(
      page.getByRole("heading", { name: "Contact Us" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "+599 416 3295" }).first(),
    ).toHaveAttribute("href", "tel:+599 416 3295");
    await expect(
      page.getByRole("link", { name: "info@sfpca.org" }),
    ).toHaveAttribute("href", "mailto:info@sfpca.org");
    await expect(
      page.getByText("The Bottom, Saba, Caribbean Netherlands"),
    ).toBeVisible();
  });
});
