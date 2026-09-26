// Chip lookup / found-animal workflow e2e (#168). Exercises the real
// physical path a volunteer takes: open the tool, the chip field is
// already focused, a scanner-style formatted number + Enter resolves
// the animal, identity + lifecycle + owner contact render, and a
// resolution can be recorded — then a second scan works without any
// mouse interaction.
//
// Fixtures (tests/e2e/global-setup.ts):
//   985113001234567 → Rexley (person-owned by "E2E Owner")
//   999000111222    → Whiskers (household-owned) + an OPEN chip
//                     conflict claimed on Claimdog
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

test.describe("chip lookup", () => {
  test("unauthenticated access is denied — the route redirects to login", async ({
    page,
  }) => {
    await page.goto("/admin/chip-lookup");
    await expect(page).toHaveURL(/\/login/);
    // Nothing of the tool or any owner data renders for strangers.
    await expect(page.getByLabel("Microchip number")).toHaveCount(0);
  });

  test("scanner-style input + Enter finds the animal, owner, and allows resolution", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/chip-lookup");

    // The field is already focused — a keyboard-wedge scanner needs no
    // click. Type straight at the page like a scanner would.
    const chipInput = page.getByLabel("Microchip number");
    await expect(chipInput).toBeFocused();
    await page.keyboard.type("985-113-001-234-567");
    await page.keyboard.press("Enter");

    // Identity + lifecycle for match verification.
    await expect(
      page.getByRole("link", { name: "Rexley" }),
    ).toBeVisible();
    await expect(page.getByText(/SFPCA-\d+/).first()).toBeVisible();
    await expect(page.getByText("dog · male")).toBeVisible();

    // Staff-authorized owner contact — the whole point of the tool.
    await expect(page.getByText("Owner contact")).toBeVisible();
    await expect(page.getByText("E2E Owner").first()).toBeVisible();
    await expect(page.getByText(/\+599 416 0001/)).toBeVisible();

    // Record what happened — the scan resolves a found case directly
    // (#176 case model; was a found-report row under #168).
    await page.getByLabel("Record outcome").click();
    await page.getByRole("option", { name: "Reunited with owner" }).click();
    await page.getByRole("button", { name: "Record" }).click();
    // exact: the aria-live toast resolves to one element this way.
    await expect(
      page.getByText("Found case resolved", { exact: true }),
    ).toBeVisible();

    // Second scan, no mouse: the field is focused and cleared again.
    await expect(chipInput).toBeFocused();
    await page.keyboard.type("985 113 001 234 567");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("link", { name: "Rexley" }),
    ).toBeVisible();
    // The previously-resolved case no longer shows as open.
    await expect(page.getByText("Open cases")).toHaveCount(0);
  });

  test("unknown chip shows a clear no-match state with next steps", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/chip-lookup");

    await page.getByLabel("Microchip number").fill("111-222-333-444-555");
    await page.getByLabel("Microchip number").press("Enter");

    await expect(
      page.getByRole("heading", { name: "No registered animal for this chip" }),
    ).toBeVisible();
    await expect(page.getByText("111222333444555")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Search the registry" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Flag for follow-up" }),
    ).toBeVisible();
    // No animal is silently created — nothing else appears.
    await expect(page.getByText("Owner contact")).toHaveCount(0);
  });

  test("a chip with an open conflict warns staff instead of hiding it", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto("/admin/chip-lookup");

    await page.getByLabel("Microchip number").fill("999-000-111-222");
    await page.getByLabel("Microchip number").press("Enter");

    await expect(
      page.getByRole("link", { name: "Whiskers" }),
    ).toBeVisible();
    await expect(
      page.getByText(/unresolved conflict/),
    ).toBeVisible();
  });

  test("nav and dashboard expose the tool", async ({ page }) => {
    await signInAsAdmin(page);
    await expect(
      page.getByRole("link", { name: "Look up a chip" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Chip Lookup" }).first().click();
    await expect(page).toHaveURL("/admin/chip-lookup");
    await expect(
      page.getByRole("heading", { name: "Chip Lookup" }),
    ).toBeVisible();
  });
});
