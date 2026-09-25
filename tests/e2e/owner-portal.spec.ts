// Owner portal journeys (#166): a pre-linked owner signs in through the
// real login flow against the Firebase Auth emulator, sees only their
// own animals, confirms annually, and files a staff-reviewed request.
// The claim journey proves an email match alone never links an account —
// staff approval is the only path from sign-in to another person's
// records. Fixtures are seeded by tests/e2e/global-setup.
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_CLAIM_EMAIL,
  E2E_CLAIM_PASSWORD,
  E2E_OWNER_EMAIL,
  E2E_OWNER_PASSWORD,
} from "./global-setup";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// Switching users mid-test: the session cookie is the server-side
// authority, so clearing it is sufficient — the next signIn replaces
// Firebase's persisted client user and mints a fresh cookie.
async function signOut(page: Page) {
  await page.context().clearCookies();
}

test.describe("owner portal", () => {
  test("unauthenticated /portal redirects to login", async ({ page }) => {
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/login/);
  });

  test("owner signs in and sees only their own animals", async ({ page }) => {
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);

    await expect(page).toHaveURL("/portal");
    await expect(
      page.getByRole("heading", { name: "Owner Portal" }),
    ).toBeVisible();
    await expect(page.getByText("Signed in as E2E Owner")).toBeVisible();

    // Person-owned animal, overdue for annual confirmation.
    await expect(
      page.getByRole("heading", { name: "Rexley" }),
    ).toBeVisible();
    // Household-owned animal — visible through membership, badged with
    // the household name.
    await expect(
      page.getByRole("heading", { name: "Whiskers" }),
    ).toBeVisible();
    await expect(page.getByText("E2E Household").first()).toBeVisible();

    // Another person's animal (E2E Legacy Owner's) is never listed —
    // ownership is the only path to animal data.
    await expect(page.getByText("Claimdog")).toBeHidden();

    // Contact details are editable owner-side data.
    await expect(page.getByLabel("Email")).toHaveValue(E2E_OWNER_EMAIL);
  });

  test("owner confirms an animal for the year", async ({ page }) => {
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");

    // Rexley is overdue; Whiskers is not. Reggie (the #169 fixture) is
    // also overdue, so scope the button to Rexley's card.
    const confirm = page
      .locator("[class*=bg-card]")
      .filter({ has: page.getByRole("heading", { name: "Rexley" }) })
      .getByRole("button", {
        name: "Confirm still living on Saba with me",
      });
    await expect(confirm).toBeVisible();
    await confirm.click();

    // .first() — React strict-mode double-invocation can stack a second
    // identical toast; the assertion is about the confirmation landing.
    await expect(
      page
        .getByText("Thanks — Rexley is confirmed for this year.")
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirmed for this year" }).first(),
    ).toBeDisabled();
  });

  test("owner files a report and staff resolves it; the animal leaves the portal", async ({
    page,
  }) => {
    // --- Owner submits a "no longer mine" report on Whiskers --------
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");

    const whiskersCard = page
      .locator("div.rounded-lg.border")
      .filter({ has: page.getByRole("heading", { name: "Whiskers" }) });
    await whiskersCard.getByLabel("Report a change").click();
    await page.getByRole("option", { name: "No longer mine" }).click();
    await whiskersCard
      .getByRole("button", { name: "Submit request" })
      .click();

    await expect(
      page.getByText("Staff will review your report and follow up if needed.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("No longer mine — Whiskers")).toBeVisible();

    // --- Staff reviews and approves --------------------------------
    await signOut(page);
    await signIn(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL("/admin");

    await page.goto("/admin/requests");
    await expect(
      page.getByRole("heading", { name: "Owner requests" }),
    ).toBeVisible();
    const pendingRow = page
      .locator("li")
      .filter({ hasText: "No longer mine" })
      .filter({ hasText: "Whiskers" });
    await expect(pendingRow.getByText("From E2E Owner")).toBeVisible();
    await pendingRow.getByRole("button", { name: "Approve" }).click();
    await page
      .getByRole("button", { name: "Confirm approval" })
      .click();
    await expect(
      page.getByText("Request approved", { exact: true }),
    ).toBeVisible();

    // --- Owner sees the outcome ------------------------------------
    await signOut(page);
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");
    // Approval closed the ownership interval — Whiskers leaves "Your
    // animals" but remains as a past association (#167: closing an
    // interval never erases the registry record or the relationship
    // history), the request shows its resolution, and Rexley is
    // unaffected.
    await expect(
      page.getByRole("heading", { name: "Whiskers" }),
    ).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Previously with you" }),
    ).toBeVisible();
    const pastSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Previously with you" }) });
    await expect(pastSection.getByText("Whiskers")).toBeVisible();
    await expect(page.getByText(/No longer mine — Whiskers/)).toBeVisible();
    await expect(
      page.getByText("approved", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Rexley" }),
    ).toBeVisible();
  });

  test("an approved deceased report transitions the animal's registry lifecycle", async ({
    page,
  }) => {
    // --- Owner reports Rexley deceased ------------------------------
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");

    const rexleyCard = page
      .locator("div.rounded-lg.border")
      .filter({ has: page.getByRole("heading", { name: "Rexley" }) });
    await rexleyCard.getByLabel("Report a change").click();
    await page.getByRole("option", { name: "Report deceased" }).click();
    await rexleyCard.getByRole("button", { name: "Submit request" }).click();
    await expect(
      page.getByText("Staff will review your report and follow up if needed.", {
        exact: true,
      }),
    ).toBeVisible();
    // Nothing has changed yet — staff approval is the authority.
    await expect(
      page.getByRole("heading", { name: "Rexley" }),
    ).toBeVisible();

    // --- Staff approves --------------------------------------------
    await signOut(page);
    await signIn(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL("/admin");
    await page.goto("/admin/requests");
    const pendingRow = page
      .locator("li")
      .filter({ hasText: "Report deceased" })
      .filter({ hasText: "Rexley" });
    await pendingRow.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: "Confirm approval" }).click();
    await expect(
      page.getByText("Request approved", { exact: true }),
    ).toBeVisible();

    // The animal's registry profile shows the transition and its
    // provenance — the record is preserved, not deleted.
    await page.goto("/admin/animals");
    const row = page.getByRole("row", { name: /Rexley/ });
    await expect(row).toContainText("Deceased");
    await row.getByRole("link", { name: "Rexley" }).click();
    await expect(page.getByText(/owner report/)).toBeVisible();

    // --- Owner sees Rexley as a past association --------------------
    await signOut(page);
    await signIn(page, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD);
    await expect(page).toHaveURL("/portal");
    await expect(
      page.getByRole("heading", { name: "Rexley" }),
    ).toBeHidden();
    const pastSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Previously with you" }) });
    await expect(pastSection.getByText("Rexley")).toBeVisible();
    await expect(pastSection.getByText(/Deceased/)).toBeVisible();
  });

  test("an email-matched sign-in files a claim; only staff approval links it", async ({
    page,
  }) => {
    // --- The claim user's email matches a seeded person, so login
    // provisions an identity but files 'account-claim' instead of
    // linking — the portal shows the pending state and no animals.
    await signIn(page, E2E_CLAIM_EMAIL, E2E_CLAIM_PASSWORD);
    await expect(page).toHaveURL("/portal");
    await expect(page.getByText("Account under review")).toBeVisible();
    await expect(page.getByText("Claimdog")).toBeHidden();

    // --- Staff sees the claim and links the account to the person ---
    await signOut(page);
    await signIn(page, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
    await expect(page).toHaveURL("/admin");

    await page.goto("/admin/requests");
    const claimRow = page
      .locator("li")
      .filter({ hasText: "Account claim" })
      .filter({ hasText: E2E_CLAIM_EMAIL });
    await expect(claimRow.getByText("E2E Legacy Owner")).toBeVisible();
    await claimRow.getByRole("button", { name: "Approve" }).click();
    // The claim-resolution form has a single person picker (Radix
    // combobox); the label isn't htmlFor-associated.
    await page.getByRole("combobox").click();
    await page
      .getByRole("option", { name: /E2E Legacy Owner/ })
      .click();
    await page.getByRole("button", { name: "Confirm approval" }).click();
    await expect(
      page.getByText("Request approved", { exact: true }),
    ).toBeVisible();

    // --- The claim user's next sign-in reaches their animals --------
    await signOut(page);
    await signIn(page, E2E_CLAIM_EMAIL, E2E_CLAIM_PASSWORD);
    await expect(page).toHaveURL("/portal");
    await expect(
      page.getByText("Signed in as E2E Legacy Owner"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Claimdog" }),
    ).toBeVisible();
    // And still cannot see the other owner's animals.
    await expect(page.getByText("Rexley")).toBeHidden();
  });
});
