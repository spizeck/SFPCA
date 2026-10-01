// E2E journey for #178: a volunteer finds two duplicate animal records,
// reviews the evidence on the data-quality workspace, previews the
// merge, confirms it explicitly, and lands on the canonical survivor —
// the retired reference still resolves. Runs against the Firebase
// emulator suite; the registry is PGlite (real Postgres).
import { expect, test, type Page } from "./fixtures";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./env";
import { dismissConsentNotice, waitForDialogSettled, openAddAnimalDialog } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

// Two records with the same name + species + identical birth date —
// the deterministic corroboration the duplicate detector requires.
// Name-only similarity never qualifies, so this seeds the minimum
// honest evidence.
async function createDuplicate(
  page: Page,
  name: string,
  birthDate: string,
) {
  const dialog = await openAddAnimalDialog(page);
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Birth date", { exact: true }).fill(birthDate);
  await dialog.getByRole("button", { name: "Add Animal" }).click();
  await expect(
    page.getByText("Animal added successfully", { exact: true }),
  ).toBeVisible();
}

// The workspace card for one finding: the outermost div containing the
// finding's label is the card root (descendants below the title don't
// contain it, ancestors contain other findings too).
function findingCard(page: Page, label: RegExp) {
  return page
    .locator("div")
    .filter({ hasText: label })
    .filter({
      has: page.getByRole("link", { name: /Compare & merge|Open record/ }),
    })
    .last();
}

test.describe("data quality and safe merge", () => {
  test("duplicate pair: finding → compare → preview → confirm → survivor; retired ref resolves", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);

    const name = "E2E Mergepup";
    await createDuplicate(page, name, "2019-04-10");
    await createDuplicate(page, name, "2019-04-10");

    // The workspace lists the probable-duplicate finding with its
    // evidence — never a conclusion.
    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    const finding = findingCard(
      page,
      /Possible duplicate animals: E2E Mergepup/,
    );
    await expect(finding).toBeVisible();
    await expect(
      finding.getByText(/same birth date/),
    ).toBeVisible();

    await finding
      .getByRole("link", { name: /Compare & merge/ })
      .click();
    await expect(page).toHaveURL(/\/admin\/data-quality\/merge\?a=/);
    await expect(
      page.getByRole("heading", { name: "Review duplicate animals" }),
    ).toBeVisible();

    // Choose which record survives, then preview the server-computed
    // plan — the retired ref is captured for the post-merge search.
    await page
      .getByRole("radio", { name: "Keep this record" })
      .first()
      .check();
    await page.getByRole("button", { name: "Preview merge" }).click();
    const retireButton = page.getByRole("button", {
      name: /Merge — retire/,
    });
    await expect(retireButton).toBeVisible();
    const retiredRef = (
      (await retireButton.textContent())?.replace(
        /^Merge — retire\s+/,
        "",
      ) ?? ""
    ).trim();
    expect(retiredRef).toMatch(/^SFPCA-/);

    // Explicit confirmation — merging is never one click. The dialog is
    // still animating in when it first becomes visible; settle it before
    // clicking so the pointer events can't land on inert chrome.
    await retireButton.click();
    const confirmDialog = page.getByRole("dialog");
    const confirmMerge = confirmDialog.getByRole("button", {
      name: "Merge",
    });
    await expect(confirmMerge).toBeEnabled();
    await waitForDialogSettled(confirmDialog);
    await confirmMerge.click();
    await expect(confirmDialog).toBeHidden();

    // Lands on the canonical survivor, which shows the absorbed record.
    await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]+$/);
    await expect(
      page.getByText(/This record absorbed duplicate/),
    ).toBeVisible();

    // The retired registry reference still resolves for staff — the hit
    // is annotated with its survivor, never listed as a live animal.
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);
    await page.getByLabel("Search animals").fill(retiredRef);
    await expect(
      page.getByRole("row", { name: new RegExp(retiredRef) }),
    ).toBeVisible();
    await expect(page.getByText(/merged into SFPCA-/)).toBeVisible();

    // The workspace no longer lists the pair.
    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    await expect(
      page.getByText(/Possible duplicate animals: E2E Mergepup/),
    ).not.toBeVisible();
  });

  test("a dismissed pair stops surfacing in the open queue", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInAsAdmin(page);
    await page.goto("/admin/animals");
    await dismissConsentNotice(page);

    const name = "E2E Notdup";
    await createDuplicate(page, name, "2021-08-15");
    await createDuplicate(page, name, "2021-08-15");

    await page.goto("/admin/data-quality");
    await dismissConsentNotice(page);
    const finding = findingCard(
      page,
      /Possible duplicate animals: E2E Notdup/,
    );
    await expect(finding).toBeVisible();
    await finding
      .getByRole("button", { name: "Not duplicates" })
      .click();
    await expect(
      page.getByText(/Possible duplicate animals: E2E Notdup/),
    ).not.toBeVisible();

    // The dismissal persists — the Dismissed filter shows the verdict.
    await page.getByLabel("Status filter").click();
    await page.getByRole("option", { name: "Dismissed" }).click();
    await expect(
      page.getByText(/Possible duplicate animals: E2E Notdup/),
    ).toBeVisible();
    await expect(
      page.getByText("Dismissed", { exact: true }).first(),
    ).toBeVisible();
  });
});
