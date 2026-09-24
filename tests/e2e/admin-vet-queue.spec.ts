// E2E for the veterinary work queue (#175), run against the Firebase
// emulators + PGlite registry — no real credentials. The main workflow:
// log a visit with a recheck → the recheck lands on the queue →
// completing it removes it from the queue but preserves it in the
// animal's history.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from "./global-setup";
import { dismissConsentNotice } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  // The Klaro notice is role="dialog" and would collide with the
  // medical dialogs' getByRole("dialog") locator.
  await dismissConsentNotice(page);
  await page.getByLabel("Email").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/admin");
}

async function createAnimal(page: Page, name: string) {
  await page.goto("/admin/animals");
  await dismissConsentNotice(page);
  await page.getByRole("button", { name: "Add Animal" }).click();
  const animalDialog = page.getByRole("dialog");
  await animalDialog.getByLabel("Name").fill(name);
  await animalDialog.getByRole("button", { name: "Add Animal" }).click();
  await expect(
    page.getByText("Animal added successfully", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: `Medical records for ${name}` })
    .click();
  await expect(page).toHaveURL(/\/admin\/animals\/[0-9a-f-]{36}/);
}

test.describe("veterinary work queue", () => {
  test("an encounter recheck lands on the queue; completing it preserves history", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await createAnimal(page, "E2E Queue Dog");

    // Log a visit with a recheck dated in the past — it must land on
    // the queue as overdue regardless of when the suite runs.
    await page.getByRole("button", { name: "Log visit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Reason/).fill("Limping");
    await dialog.getByLabel("Schedule a recheck / follow-up").check();
    await dialog.getByLabel("Recheck date").fill("2020-01-01");
    await dialog.getByLabel("Recheck for").fill("Recheck limp");
    await dialog.getByRole("button", { name: "Save entry" }).click();
    await expect(
      page.getByText("Entry recorded", { exact: true }),
    ).toBeVisible();

    // The animal page shows it as an actionable overdue item — staff
    // never have to leave the record to see what is pending. The
    // recheck reason is unique to the follow-up panel (the timeline
    // shows the visit's own reason, "Limping").
    await expect(page.getByText("Recheck limp")).toBeVisible();
    await expect(page.getByText("Overdue")).toBeVisible();
    await expect(page.getByText(/From visit on/)).toBeVisible();
    const medicalUrl = page.url();

    // The shared queue surfaces it cross-animal.
    await page.goto("/admin/vet");
    await dismissConsentNotice(page);
    const row = page.getByRole("row", { name: /Recheck limp/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("Overdue")).toBeVisible();
    await expect(row.getByText("E2E Queue Dog")).toBeVisible();

    // Completing from the queue removes it — the record is preserved.
    await row
      .getByRole("button", { name: "Complete Recheck limp — E2E Queue Dog" })
      .click();
    await expect(
      page.getByText("Follow-up completed.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: /Recheck limp/ }),
    ).toHaveCount(0);

    // Back on the animal record: nothing open, and the completed item
    // sits in collapsed history — never deleted.
    await page.goto(medicalUrl);
    await dismissConsentNotice(page);
    await expect(
      page.getByText("No open follow-ups for this animal."),
    ).toBeVisible();
    await page.getByText(/Resolved history/).click();
    const history = page.locator("details");
    await expect(
      history.getByText("Recheck limp", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Completed", { exact: true }),
    ).toBeVisible();
  });

  test("an overdue vaccination surfaces on the queue", async ({ page }) => {
    await signInAsAdmin(page);
    await createAnimal(page, "E2E Vax Queue Cat");

    // A dose whose next-due date already passed — the queue must show
    // it as overdue (state is derived, never stored).
    await page.getByRole("button", { name: "Add vaccination" }).click();
    const vaxDialog = page.getByRole("dialog");
    await vaxDialog.getByLabel("Vaccine").fill("Rabies");
    await vaxDialog.getByLabel("Date given").fill("2020-01-01");
    await vaxDialog.getByLabel("Next due").fill("2020-06-01");
    await vaxDialog
      .getByRole("button", { name: "Add vaccination" })
      .click();
    await expect(
      page.getByText("Vaccination added", { exact: true }),
    ).toBeVisible();

    await page.goto("/admin/vet");
    await dismissConsentNotice(page);
    const row = page.getByRole("row", { name: /Rabies/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("Overdue")).toBeVisible();
    await expect(row.getByText("E2E Vax Queue Cat")).toBeVisible();
    // Vaccinations are context, not inline-complete tasks — acting on
    // them means opening the record (recording the next dose).
    await expect(row.getByRole("button")).toHaveCount(0);
  });
});
