// Lost/found case workflow e2e (#176). Exercises the real volunteer
// paths end to end:
//   - open a missing case from the animal profile;
//   - explicitly publish it to the public /lost-pets page (opt-in);
//   - a public sighting lands on the case;
//   - a chip scan surfaces the missing case and resolves the reunion;
//   - an unknown chip becomes an unmatched found case that staff link;
//   - an owner reports their own animal missing from the portal.
//
// Fixture (tests/e2e/global-setup.ts):
//   Daisy — lifecycle 'active', owned by the E2E owner (person), chip
//   985222000333444. A dedicated animal so case state can't collide
//   with other suites' lifecycle changes.
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
} from "./global-setup";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_OWNER_EMAIL);
  await page.getByLabel("Password").fill(E2E_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/portal");
}

test.describe("lost & found", () => {
  test("unauthenticated staff routes redirect to login", async ({ page }) => {
    await page.goto("/admin/lost-found");
    await expect(page).toHaveURL(/\/login/);
  });

  test("missing → publish → public listing → chip scan → reunion → history", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // Open the missing case from the canonical animal profile.
    await page.goto("/admin/animals");
    const row = page.getByRole("row", { name: /Daisy/ });
    await row.getByRole("link", { name: "Daisy" }).click();
    await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Report missing" }).click();
    await page
      .getByLabel("Last seen location (optional)")
      .fill("Windwardside");
    await page
      .getByRole("button", { name: "Open missing case" })
      .click();
    await expect(
      page.getByText("Missing case opened", { exact: true }),
    ).toBeVisible();

    // The case shows on the profile panel; lifecycle is still active —
    // missing is workflow state, not registry state.
    await expect(page.getByText("Active on Saba").first()).toBeVisible();
    await page.getByRole("link", { name: "Open case" }).click();
    await expect(
      page.getByRole("heading", { name: "Missing case" }),
    ).toBeVisible();
    const caseUrl = page.url();

    // Publish is an explicit opt-in, not implied by the open case.
    await page.goto("/lost-pets");
    await expect(
      page.getByText("no animals listed as missing"),
    ).toBeVisible();
    await page.goto(caseUrl);
    await page
      .getByRole("button", { name: "Publish to the lost-pets page" })
      .click();
    await page
      .getByLabel(/Approved public note/)
      .fill("Answers to Daisy — do not chase");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      page.getByText("Published to the lost-pets page", { exact: true }),
    ).toBeVisible();

    // The public page shows the allowlist only — no owner contact, no
    // reporter details, no chip number.
    await page.goto("/lost-pets");
    await expect(
      page.getByRole("heading", { name: "Daisy" }),
    ).toBeVisible();
    await expect(
      page.getByText("Answers to Daisy — do not chase"),
    ).toBeVisible();
    await expect(page.getByText("Windwardside")).toBeVisible();
    await expect(page.getByText("E2E Owner")).toHaveCount(0);
    await expect(page.getByText(/599 416 0001/)).toHaveCount(0);
    await expect(page.getByText(/985.?222/)).toHaveCount(0);

    // A member of the public reports a sighting — goes TO staff, never
    // to the owner.
    await page.getByRole("button", { name: "I've seen this animal" }).click();
    await page
      .getByLabel("Where did you see it?")
      .fill("Near the harbour, Fort Bay");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(
      page.getByText("Thank you — your report has been sent to SFPCA."),
    ).toBeVisible();

    // The sighting is on the case chronology for staff.
    await page.goto(caseUrl);
    await expect(page.getByText("Near the harbour, Fort Bay")).toBeVisible();

    // Scan her chip — the missing case surfaces, the scan lands on it.
    await page.goto("/admin/chip-lookup");
    await page.getByLabel("Microchip number").fill("985-222-000-333-444");
    await page.getByLabel("Microchip number").press("Enter");
    await expect(
      page.getByRole("link", { name: "Daisy" }),
    ).toBeVisible();
    await expect(page.getByText("Reported missing")).toBeVisible();
    // Owner contact is staff-only — present here precisely because this
    // is the authorized surface.
    await expect(page.getByText("E2E Owner").first()).toBeVisible();

    // Resolve the reunion from the scan card — the case closes, the
    // public listing disappears automatically.
    await page.getByLabel("Resolution outcome").click();
    await page.getByRole("option", { name: "Reunited with owner" }).click();
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(
      page.getByText("Case resolved", { exact: true }),
    ).toBeVisible();

    await page.goto("/lost-pets");
    await expect(
      page.getByText("no animals listed as missing"),
    ).toBeVisible();

    // History is retained: the profile's case history shows the resolved
    // case and the registry status is still active — identity unchanged.
    await page.goto("/admin/animals");
    await page.getByRole("row", { name: /Daisy/ })
      .getByRole("link", { name: "Daisy" })
      .click();
    await expect(page.getByText("Active on Saba").first()).toBeVisible();
    await expect(page.getByText("Case history")).toBeVisible();
    await expect(page.getByText(/missing case resolved/)).toBeVisible();

    // The workspace shows the closed case under Recently closed.
    await page.goto("/admin/lost-found");
    await expect(
      page.getByRole("heading", { name: "Recently closed" }),
    ).toBeVisible();
    await expect(page.getByText("Daisy").first()).toBeVisible();
  });

  test("unknown chip → unmatched found case → staff links it to the registry", async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // An unknown chip is real work, not a fabricated animal.
    await page.goto("/admin/chip-lookup");
    await page.getByLabel("Microchip number").fill("555-444-333-222-111");
    await page.getByLabel("Microchip number").press("Enter");
    await expect(
      page.getByRole("heading", { name: "No registered animal for this chip" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Flag for follow-up" }).click();
    await expect(
      page.getByText("Flagged for follow-up", { exact: true }),
    ).toBeVisible();

    // The unmatched case sits in the matching queue.
    await page.goto("/admin/lost-found");
    await expect(
      page.getByRole("heading", { name: "Found — needs matching" }),
    ).toBeVisible();
    // Work THIS unmatched case — other tests may leave open cases.
    await page
      .locator("li", { hasText: "555" })
      .getByRole("link", { name: "Work case" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Found case" }),
    ).toBeVisible();
    await expect(
      page.getByText("Unmatched — link to a registry animal"),
    ).toBeVisible();

    // Manual registry search + explicit link — never fuzzy auto-matching.
    await page
      .getByPlaceholder("Name, registry ref, chip number…")
      .fill("Whiskers");
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("button", { name: "Link" }).click();
    await expect(
      page.getByText("Linked to Whiskers", { exact: true }),
    ).toBeVisible();
    // The record preserves that the case BEGAN unmatched.
    await expect(page.getByText("case began unmatched")).toBeVisible();

    // Close it out — the timeline keeps scan + link + resolution.
    await page.getByRole("button", { name: "Resolve…" }).click();
    await page.getByLabel("Outcome").click();
    await page.getByRole("option", { name: "Taken into care" }).click();
    await page.getByRole("button", { name: "Resolve case" }).click();
    await expect(
      page.getByText("Case resolved", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Linked to registry animal")).toBeVisible();
  });

  test("an owner reports their animal missing from the portal", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await page
      .getByRole("button", { name: "Daisy is missing" })
      .click();
    await page.getByLabel("Where last seen (optional)").fill("The Bottom");
    await page
      .getByRole("button", { name: "Send missing report" })
      .click();
    await expect(
      page.getByText("Missing report sent", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Reported missing")).toBeVisible();

    // Staff see it in the missing queue, attributed to the owner portal.
    await page.request.delete("/api/auth/session");
    await signInAsAdmin(page);
    await page.goto("/admin/lost-found");
    await expect(page.getByText("by the owner").first()).toBeVisible();
    await page.getByRole("link", { name: "Work case" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Missing case" }),
    ).toBeVisible();
    await expect(page.getByText("reported by owner")).toBeVisible();

    // Clean up: resolve so Daisy ends the suite case-free.
    await page.getByRole("button", { name: "Resolve…" }).click();
    await page.getByLabel("Outcome").click();
    await page.getByRole("option", { name: "Reunited with owner" }).click();
    await page.getByRole("button", { name: "Resolve case" }).click();
    await expect(
      page.getByText("Case resolved", { exact: true }),
    ).toBeVisible();
  });
});
