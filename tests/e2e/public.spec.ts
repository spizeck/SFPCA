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

  test("homepage previews adoptable animals and links to their detail pages", async ({
    page,
  }) => {
    await page.goto("/");

    const section = page.locator("#animals");
    await section.scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("heading", { name: "Adoptable Animals" }),
    ).toBeVisible();

    // "Charlie" is a seeded available animal. The preview card links to
    // the real detail route introduced by #157.
    const cardLink = page.getByRole("link", {
      name: "Learn more about Charlie",
    });
    await expect(cardLink).toBeVisible();
    const href = await cardLink.getAttribute("href");
    expect(href).toMatch(/^\/animal-adoptions\/.+/);

    await cardLink.click();
    await expect(page).toHaveURL(href as string);
    await expect(
      page.getByRole("heading", { name: "Charlie", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Contact Us to Adopt" }),
    ).toBeVisible();
  });

  test("homepage preview links through to the full adoption listing", async ({
    page,
  }) => {
    await page.goto("/");

    await page
      .getByRole("link", { name: "View All Adoptable Animals" })
      .click();

    await expect(page).toHaveURL("/animal-adoptions");
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
